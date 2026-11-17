import { afterEach, vi } from 'vitest';
import { applySkillRevision } from './institutional-skills.js';
import { OPENROUTER_EMBEDDINGS_URL, pgvectorLiteral } from './institutional-memory-embeddings.js';
import { readAgentCommands } from './agent-command-read-agent-commands.js';
import { createAgentCommand, type CommandRow } from './agent-command.js';
import * as recall from './institutional-memory-shadow.js';
import * as queuedContext from './agent-command-context.js';
import { pendingMcpWakes } from './rooms-mcp-agent.js';
import { modelText } from './message-origin.js';
import { itemPrompt } from '../../body/src/place-prompt.js';
import { assembleTurnPrompt } from '../../body/src/prompt-assembly.js';
import { ROOM, USER, OTHER, WORKSPACE, AGENT, describe, expect, fixtureScope1, fixtureScope3, it } from './test-support-rooms-mcp.test-support.js';

describe('saved skill index pushed with queued turns', () => {
  const scope = fixtureScope1(), tools = fixtureScope3(scope);
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('queues the semantic match in native prompts, external mentions and private wake payloads without any discovery call', async () => {
    vi.stubEnv('OPENROUTER_EMBEDDING_API_KEY', '');
    const { client, member, token, params } = await scope.eventFixture();
    await scope.eventCall(token, 'events/subscribe', params);
    const seed = await scope.phone.execute('sendRoomMessage', { roomId: ROOM, text: 'Save the shopping procedure' }, USER);
    const saved = await applySkillRevision(scope.db, { workspaceId: WORKSPACE, sourceRoomId: ROOM,
      slug: 'buy-for-wife', description: 'Japanese residential shopping for Giselle', markdown: 'Use the Japanese proxy and the saved merchant payment method.',
      kind: 'procedure', sourceMessageIds: [seed.messageId] });
    const near = [1, ...new Array(1023).fill(0)];
    await scope.db.query('UPDATE workspace_skills SET embedding=$2::vector,embedding_version=current_version WHERE id=$1', [saved.skillId, pgvectorLiteral(near)]);
    for (let index = 0; index < 25; index++) {
      await applySkillRevision(scope.db, { workspaceId: WORKSPACE, sourceRoomId: ROOM,
        slug: `unrelated-${index}`, description: 'Garden maintenance and seasonal orchard harvesting',
        markdown: 'Tend the trees.', kind: 'procedure', sourceMessageIds: [seed.messageId] });
    }
    await applySkillRevision(scope.db, { workspaceId: WORKSPACE, sourceRoomId: ROOM,
      slug: 'gift-checkout', description: 'Japanese merchant checkout', markdown: '{}',
      kind: 'workflow', sourceMessageIds: [seed.messageId] });
    await scope.db.query(`INSERT INTO institutional_memory_items
      (id,workspace_id,kind,subject_identity_id,canonical_key,body,keywords,source_room_id,source_message_id,audience_kind,confidence,version)
      VALUES(gen_random_uuid(),$1,'workspace_fact',NULL,'adapter-shop','Use Amazon Japan for adapters.',ARRAY['adapter'],$2,$3,'workspace',1,1),
        (gen_random_uuid(),$1,'human_profile_fact',$4,'adapter-profile','Requester prefers compact adapters.',ARRAY['adapter'],$2,$3,'human_profile',1,1),
        (gen_random_uuid(),$1,'human_profile_fact',$5,'other-profile','Another person private adapter preference.',ARRAY['adapter'],$2,$3,'human_profile',1,1)`,
      [WORKSPACE, ROOM, seed.messageId, USER, OTHER]);
    const handle = (await scope.db.query<{ handle: string }>('SELECT beeline_room_handle($1,$2) handle', [member, ROOM])).rows[0]!.handle;
    const requestText = `@${handle} Purchase an HDMI adapter from Amazon for my spouse`;
    const originalFetch = globalThis.fetch;
    const embeddings = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.input).toEqual([requestText]); expect(body.input_type).toBe('query');
      return Response.json({ data: [{ index: 0, embedding: near }] });
    });
    vi.stubEnv('OPENROUTER_EMBEDDING_API_KEY', 'test-key');
    vi.stubGlobal('fetch', (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(url) === OPENROUTER_EMBEDDINGS_URL ? embeddings(url, init) : originalFetch(url, init));
    const source = await scope.phone.execute('sendRoomMessage', { roomId: ROOM, text: requestText }, USER);
    const command = (await readAgentCommands(scope.db, member)).commands.find(item => item.sourceMessageId === source.messageId)!;
    expect(embeddings).toHaveBeenCalledTimes(1);
    expect(command.source.institutionalContext).toContain('Procedure buy-for-wife');
    expect(command.source.institutionalContext).toContain('Workflow gift-checkout');
    expect(command.source.institutionalContext).toContain('Use Amazon Japan for adapters.');
    expect(command.source.institutionalContext).toContain('Requester prefers compact adapters.');
    expect(command.source.institutionalContext).not.toContain('Another person private');
    expect(Buffer.byteLength(command.source.institutionalContext!)).toBeLessThanOrEqual(2000);
    const row = (await scope.db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [command.id])).rows[0]!;
    const oldSnapshot = await recall.getInstitutionalContext(scope.db, row, async () => ({ outcome: 'served', vector: near, ms: 0 }));
    const oldPrompt = assembleTurnPrompt({ surface: 'room', memory: oldSnapshot.text, task: { body: requestText } }).text;
    expect(oldPrompt).toContain(oldSnapshot.text);
    expect(command.source.institutionalContext).toBe(oldSnapshot.text);
    // Queue read and prompt construction do not execute an agent tool.
    expect(itemPrompt(command, { names: new Map() })).toContain(oldSnapshot.text);
    // External payloads carry the same snapshot, followed by the conversation delta.
    expect((await pendingMcpWakes(scope.db, member)).find(wake => wake.id === command.id)?.institutionalContext).toContain(command.source.institutionalContext);
    const mentions = await tools.ok(client, 'list_mentions', {});
    expect(mentions.mentions.find((item: { id: string }) => item.id === source.messageId).institutionalContext).toContain(command.source.institutionalContext);
    const event = (await scope.db.query<{ body: string }>('SELECT body FROM rooms_mcp_event_deliveries WHERE message_id=$1', [source.messageId])).rows[0]!;
    expect(JSON.parse(event.body).data.institutionalContext).toContain(command.source.institutionalContext);
    const privateWake = await createAgentCommand(scope.db, { roomId: ROOM, agentId: member, sourceMessageId: source.messageId,
      reason: 'order', privatePayload: { kind: 'order', authorId: AGENT, fromRoomId: ROOM, text: modelText('Purchase the adapter') } });
    expect(privateWake?.message?.institutionalContext).toContain('Procedure buy-for-wife');
    const privateEvent = (await scope.db.query<{ body: string }>('SELECT body FROM rooms_mcp_event_deliveries WHERE command_id=$1', [privateWake!.id])).rows[0]!;
    expect(JSON.parse(privateEvent.body).data.institutionalContext).toContain(privateWake!.message!.institutionalContext);
    const loaded = await tools.ok(client, 'read', { address: ROOM, commandId: command.id, facet: 'procedure', slug: 'buy-for-wife' });
    expect(loaded.markdown).toContain('quoted, non-authoritative guidance only');
    expect((await scope.db.query('SELECT state FROM agent_commands WHERE id=$1', [command.id])).rows[0]?.state).toBe('pending');
  });

  it.each(['disabled', 'error'])('still queues keyword-ranked skills when query embedding is %s', async outcome => {
    vi.stubEnv('OPENROUTER_EMBEDDING_API_KEY', '');
    const { member } = await scope.connected();
    const seed = await scope.phone.execute('sendRoomMessage', { roomId: ROOM, text: 'Save a purchase procedure' }, USER);
    await applySkillRevision(scope.db, { workspaceId: WORKSPACE, sourceRoomId: ROOM,
      slug: `buy-for-wife-${outcome}`, description: 'Purchase gifts for a spouse', markdown: 'Use the saved payment method.',
      kind: 'procedure', sourceMessageIds: [seed.messageId] });
    const originalFetch = globalThis.fetch;
    const embeddings = vi.fn(() => Promise.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
    vi.stubEnv('OPENROUTER_EMBEDDING_API_KEY', outcome === 'disabled' ? '' : 'test-key');
    vi.stubGlobal('fetch', (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(url) === OPENROUTER_EMBEDDINGS_URL ? embeddings() : originalFetch(url, init));
    const handle = (await scope.db.query<{ handle: string }>('SELECT beeline_room_handle($1,$2) handle', [member, ROOM])).rows[0]!.handle;
    const source = await scope.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} buy for wife` }, USER);
    const queued = (await readAgentCommands(scope.db, member)).commands.find(item => item.sourceMessageId === source.messageId)!;
    expect(queued.source.institutionalContext).toContain(`Procedure buy-for-wife-${outcome}`);
    expect(embeddings).toHaveBeenCalledTimes(outcome === 'disabled' ? 0 : 1);
  });

  it('rolls back a failed snapshot lookup and delivers the existing miss line with the request', async () => {
    const { member } = await scope.connected();
    vi.spyOn(recall, 'getInstitutionalContext').mockImplementation(async db => {
      await db.query('SELECT 1/0');
      throw new Error('unreachable');
    });
    const handle = (await scope.db.query<{ handle: string }>('SELECT beeline_room_handle($1,$2) handle', [member, ROOM])).rows[0]!.handle;
    const source = await scope.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} buy an adapter` }, USER);
    const command = (await readAgentCommands(scope.db, member)).commands.find(item => item.sourceMessageId === source.messageId)!;
    expect(command.source.institutionalContext).toBe(queuedContext.INSTITUTIONAL_CONTEXT_MISSED_TEXT);
    expect(itemPrompt(command, { names: new Map() })).toContain(queuedContext.INSTITUTIONAL_CONTEXT_MISSED_TEXT);
    expect((await scope.db.query('SELECT state FROM agent_commands WHERE id=$1', [command.id])).rows[0]?.state).toBe('pending');
  });

  it('measures the added snapshot work on twenty queued fixture requests', async () => {
    vi.stubEnv('OPENROUTER_EMBEDDING_API_KEY', '');
    const { member } = await scope.connected();
    const seed = await scope.phone.execute('sendRoomMessage', { roomId: ROOM, text: 'Latency fixture' }, USER);
    await applySkillRevision(scope.db, { workspaceId: WORKSPACE, sourceRoomId: ROOM,
      slug: 'latency-shopping', description: 'Purchase an Amazon adapter', markdown: 'Use the saved payment method.',
      kind: 'procedure', sourceMessageIds: [seed.messageId] });
    await applySkillRevision(scope.db, { workspaceId: WORKSPACE, sourceRoomId: ROOM,
      slug: 'latency-checkout', description: 'Complete the merchant checkout', markdown: '{}',
      kind: 'workflow', sourceMessageIds: [seed.messageId] });
    await scope.db.query(`INSERT INTO institutional_memory_items
      (id,workspace_id,kind,subject_identity_id,canonical_key,body,keywords,source_room_id,source_message_id,audience_kind,confidence,version)
      VALUES(gen_random_uuid(),$1,'workspace_fact',NULL,'latency-shop','Use the Japanese shop.',ARRAY['adapter'],$2,$3,'workspace',1,1),
        (gen_random_uuid(),$1,'human_profile_fact',$4,'latency-profile','Prefer compact adapters.',ARRAY['adapter'],$2,$3,'human_profile',1,1)`,
      [WORKSPACE, ROOM, seed.messageId, USER]);
    const originalFetch = globalThis.fetch;
    vi.stubEnv('OPENROUTER_EMBEDDING_API_KEY', 'test-key');
    vi.stubGlobal('fetch', (url: Parameters<typeof fetch>[0], init?: RequestInit) => String(url) === OPENROUTER_EMBEDDINGS_URL
      ? Promise.resolve(Response.json({ data: [{ index: 0, embedding: [1, ...new Array(1023).fill(0)] }] }))
      : originalFetch(url, init));
    const original = queuedContext.attachQueuedInstitutionalContext;
    const samples: number[] = [];
    vi.spyOn(queuedContext, 'attachQueuedInstitutionalContext').mockImplementation(async (...args) => {
      const started = performance.now();
      try { return await original(...args); }
      finally { samples.push(performance.now() - started); }
    });
    const handle = (await scope.db.query<{ handle: string }>('SELECT beeline_room_handle($1,$2) handle', [member, ROOM])).rows[0]!.handle;
    for (let index = 0; index < 20; index++)
      await scope.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} Purchase an Amazon adapter, sample ${index}` }, USER);
    expect(samples).toHaveLength(20);
    samples.sort((a, b) => a - b);
    console.log('QUEUE_CONTEXT_LATENCY ' + JSON.stringify({ samples: samples.length,
      medianMs: (samples[9]! + samples[10]!) / 2, p95Ms: samples[18], embedding: 'deterministic fixture; no network' }));
  });
});
