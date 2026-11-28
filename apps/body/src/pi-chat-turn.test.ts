import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { afterEach, expect, it, vi } from 'vitest';
import { readAgentCommands } from '../../server/src/agent-command.js';
import { DaemonService } from '../../server/src/daemon-service.js';
import { LiveHub } from '../../server/src/live.js';
import { PhoneService } from '../../server/src/phone-service.js';
import { migratedDatabase } from '../../server/src/test-support.js';
import { AcpClient } from './acp.js';
import { agentCornerCheckoutPaths } from './agent-corner-checkout.js';
import { AgentRunner } from './agent-runner.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { installPiSystemPrompt } from './pi-session-instructions.js';
import { itemPrompt, memberThreads } from './place-prompt.js';
import { assembleSessionPrompt } from './prompt-assembly.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const count = (text: string, part: string) => text.split(part).length - 1;

it('a Pi person tag omits unrelated thread work and gets its session rules once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'beeline-pi-chat-turn-'));
  roots.push(root);
  const agent = { publicKey: 'grunt' };
  const thread = {
    cornerId: 'd3293b70-78c0-424f-b62d-15a38c3974b0',
    parentRoomId: 'apm',
    name: 'game-3d',
    createdBy: 'grunt',
    archived: false,
    pullRequestNumber: 1,
    objective: 'Move the 3D slice into the repository.',
  };
  const checkout = agentCornerCheckoutPaths(root, thread.cornerId, agent.publicKey).path;
  mkdirSync(checkout, { recursive: true });
  const session = assembleSessionPrompt({
    surface: 'room',
    agentName: 'Grunt',
    agentCommand: '/opt/adapters/pi/node_modules/.bin/pi-acp',
    repositoryPending: true,
    shell: { available: true },
    writableHome: join(root, 'agent-home', 'user'),
  });
  const item: AgentCommand = {
    id: 'request',
    turnRequestId: 'request',
    rootCommandId: 'request',
    rootSourceMessageId: 'message',
    sourceMessageId: 'message',
    roomId: 'apm',
    roomName: '#apm',
    returnRoomId: 'apm',
    agentId: 'grunt',
    action: 'input',
    reason: 'human_tag',
    agentDepth: 0,
    createdAt: 0,
    source: {
      id: 'message',
      authorId: 'dana',
      type: 'message',
      attachments: [],
      createdAt: 0,
      body: '@grunt the start button does not work on phones. Please fix it.',
    },
  };
  const threads = memberThreads(
    'room',
    {
      corners: [thread, { ...thread, cornerId: 'closed-thread', name: 'old-work', archived: true }],
    },
    { placeId: 'apm', runtime: { supervisorRoot: root }, agent },
  );
  const turn = itemPrompt(item, {
    names: new Map([['dana', 'Dana']]),
    turnPrefix: session.turnPrefix,
    threads,
    fresh: true,
  });

  expect(threads).toContain(
    'Current threads you belong to (use the exact address with read or message):\n' +
      `- game-3d (${thread.cornerId}), parent chat apm, created by grunt, PR #1, checkout ${checkout}: Move the 3D slice into the repository.`,
  );
  expect(turn).not.toContain(thread.cornerId);
  expect(turn).not.toContain(checkout);
  expect(turn).not.toContain('old-work');
  expect(turn).toMatch(/Reply to the message below\.[\s\S]*text: @grunt the start button does not work on phones\. Please fix it\.$/);
  expect(session.systemPrompt).toContain('Code work happens only in a thread.');
  expect(session.systemPrompt).not.toContain('write/edit tools');
  expect(session.turnPrefix).toBe('');
  expect(count(turn, 'You are Grunt in Beeline')).toBe(0);
  const env = { PI_CODING_AGENT_DIR: join(root, 'agent-home', 'pi') };
  await installPiSystemPrompt(env, session.systemPrompt);
  const system = readFileSync(join(env.PI_CODING_AGENT_DIR, 'SYSTEM.md'), 'utf8');
  expect(system).toBe(session.systemPrompt);
  expect(count(system, 'You are Grunt in Beeline')).toBe(1);
});

it('posts one quoted reply and ends the turn as failed when every Pi attempt returns 429', async () => {
  const root = mkdtempSync(join(tmpdir(), 'beeline-pi-quota-turn-'));
  roots.push(root);
  const db = await migratedDatabase();
  const workspaceId = randomUUID(), roomId = randomUUID(), human = 'a'.repeat(64);
  const secretKeyHex = '01'.repeat(32);
  const { publicKey: agentId, name } = identityFromKey(secretKeyHex, 'Grunt');
  const message = 'No tool-capable adapter is available for a request with function tools; finish setup or retry after quota resets Routes skipped: all tool-capable routes exhausted.';
  const errorMessage = `429: ${JSON.stringify({ type: 'server_error', code: 'quota', message })}`;
  const sessionId = randomUUID();
  const start = vi.spyOn(AcpClient.prototype, 'startProcess').mockImplementation(async function (this: AcpClient) {
    this.alive = true;
  });
  const request = vi.spyOn(AcpClient.prototype, 'request').mockImplementation(async function (this: AcpClient, method, params) {
    if (method === 'session/new') return { sessionId };
    if (method !== 'session/prompt') throw new Error(`Unexpected ACP method ${method}`);
    const directory = join(this.agentEnv.PI_CODING_AGENT_DIR!, 'sessions', 'fixture');
    await mkdir(directory, { recursive: true });
    const recorded = [
      { role: 'user', content: (params as { prompt: unknown }).prompt },
      ...[1, 2, 3].map(() => ({ role: 'assistant', content: [], stopReason: 'error', errorMessage })),
    ];
    await writeFile(join(directory, `fixture_${sessionId}.jsonl`), recorded.map((entry) =>
      JSON.stringify({ type: 'message', message: { ...entry, timestamp: Date.now() } })).join('\n') + '\n');
    return { stopReason: 'end_turn' };
  });
  const abort = new AbortController();
  let running: ReturnType<AgentRunner['run']> | undefined;
  try {
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Person','person'),($2,'agent','Grunt','grunt')`, [human, agentId]);
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agentId, human]);
    await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Workspace')", [workspaceId]);
    await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')", [roomId, workspaceId]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$4,'member')`,
    [workspaceId, roomId, human, agentId]);
    const live = new LiveHub();
    const phone = new PhoneService(db, live);
    const daemon = new DaemonService(db, live);
    const tag = await phone.execute('sendRoomMessage', { roomId, text: '@grunt Please answer' }, human);
    const { commands } = await readAgentCommands(db, agentId, roomId);
    expect(commands).toMatchObject([{ sourceMessageId: tag.messageId, reason: 'human_tag' }]);
    const command = commands[0]!;
    let pushQueue!: (commands: AgentCommand[], completed: string[], stopped: string[], resets: []) => void;
    const execute = vi.fn(async (operation: string, input: object) => {
      if (operation === 'getDaemonBootstrap') return { workspaceIds: [workspaceId] };
      if (operation === 'startAgentTurn' || operation === 'postRoomMessage' || operation === 'postAgentTurnReceipt')
        return daemon.execute(operation, input as never, agentId);
      if (operation.startsWith('get') || operation.startsWith('list')) throw new Error('Optional resource unavailable in fixture');
      return {};
    });
    const api = {
      execute,
      baseUrl: 'http://127.0.0.1',
      connection: () => ({ baseUrl: 'http://127.0.0.1', daemonToken: 'test', agentId, helperVersion: 'test' }),
      setQueueListener: (listener: typeof pushQueue) => { pushQueue = listener; },
      subscribeQueue: () => pushQueue(commands, [], [], []),
      setConfigChangedListener() {}, setRoomsChangedListener() {}, setCornerCompleteListener() {},
      onLiveOpen: () => () => {},
    } as unknown as DaemonApiClient;
    const runner = new AgentRunner({
      agent: { publicKey: agentId, secretKeyHex, name }, communityId: workspaceId, rooms: [], supervisorRoot: root,
    } as AgentRuntimeRecord, join(root, 'runtime.json'), {
      workspaceRoot: root, operatorHome: root, agentKind: 'pi', agentBinary: 'pi-acp', mcpBinary: 'fixture', agentEnv: {},
    }, { daemonApi: api });
    running = runner.run({ signal: abort.signal });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({
      requestId: command.id, text: expect.any(String), harnessEnded: true,
    })), { timeout: 5_000 });
    const posts = execute.mock.results.filter((_, index) => execute.mock.calls[index]![0] === 'postRoomMessage');
    expect(posts).toHaveLength(1);
    await posts[0]!.value;
    expect(request.mock.calls.filter(([method]) => method === 'session/prompt')).toHaveLength(1);
    await db.backgroundWork.drain();
    expect((await db.query('SELECT text,reply_to_message_id FROM messages WHERE room_id=$1 AND author_id=$2', [roomId, agentId])).rows)
      .toEqual([{ text: message, reply_to_message_id: tag.messageId }]);
    expect((await readAgentCommands(db, agentId, roomId)).commands).toEqual([]);
    expect((await db.query('SELECT status FROM agent_turns WHERE request_id=$1', [command.turnRequestId])).rows)
      .toEqual([{ status: 'failed' }]);
  } finally {
    abort.abort();
    await running;
    await db.close();
    start.mockRestore();
    request.mockRestore();
  }
}, 30_000);
