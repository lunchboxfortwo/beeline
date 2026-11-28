import { renderWake, renderMention } from '../../body/src/session-join/bridge.js';
import { pendingMcpWakes } from './rooms-mcp-agent.js';
import { itemPrompt } from '../../body/src/place-prompt.js';
import {
  expect,
  it,
  H,
  A,
  R,
  C,
  W,
  daemon,
  db,
  commands,
  send,
  rootFixture,
} from './test-support-agent-command.integration.test-support.js';
import { queueMessage } from './agent-command.js';

const Q = 'e'.repeat(64);

async function queueAgentRequest(text: string) {
  const { messageId } = await send(text);
  return queueMessage(db, { roomId: R, agentId: A, sourceMessageId: messageId, reason: 'message' });
}

it('queues only what a live session has not seen for agent requests: new messages, and the member list once per change', async () => {
  await queueAgentRequest('first request');
  await send('Untagged chatter between requests');
  await queueAgentRequest('second request');
  await queueAgentRequest('third request');
  const [first, second, third] = await commands(A);
  // A session with no earlier command here gets the window.
  expect(first!.source.conversationContext).toContain('Members (exact tag spellings):');
  expect(first!.source.conversationContext).toContain('You are @hoots');
  expect(first!.source.conversationWindow).toBeUndefined();
  // The tip: only the message it has not seen, never its own source again.
  expect(second!.source.conversationContext).toContain('Untagged chatter between requests');
  expect(second!.source.conversationContext).not.toContain('first request');
  expect(second!.source.conversationContext).not.toContain('Members (exact tag spellings):');
  expect(third!.source.conversationContext).toBeUndefined();
  // A fresh session still gets recent messages, without repeating unchanged members.
  expect(third!.source.conversationWindow).toContain('second request');
  expect(third!.source.conversationWindow).not.toContain('Members (exact tag spellings):');
  const live = itemPrompt(third!, { names: new Map() });
  const fresh = itemPrompt(third!, { names: new Map(), fresh: true });
  expect(live).not.toContain('Untagged chatter between requests');
  expect(fresh).toContain('Untagged chatter between requests');
  expect(fresh).not.toContain('Members (exact tag spellings):');

  await rootFixture.db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Quill','quill') ON CONFLICT DO NOTHING`,
    [Q],
  );
  await rootFixture.db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
    [W, R, Q],
  );
  try {
    await queueAgentRequest('fourth request');
    await queueAgentRequest('fifth request');
    const [, , , fourth, fifth] = await commands(A);
    expect(fourth!.source.conversationContext).toContain('@quill — Quill (person)');
    expect(itemPrompt(fourth!, { names: new Map(), fresh: true })).toContain('@quill — Quill (person)');
    expect(fifth!.source.conversationContext ?? '').not.toContain('Members (exact tag spellings):');
    expect(itemPrompt(fifth!, { names: new Map(), fresh: true })).not.toContain('Members (exact tag spellings):');
  } finally {
    await rootFixture.db.query('DELETE FROM memberships WHERE identity_id=$1', [Q]);
  }
});

it('delivers a thread brief with the first turn and again only when its revision changes, in wakes too', async () => {
  await rootFixture.db.query('DELETE FROM corner_brief_revisions WHERE corner_id=$1', [C]);
  await rootFixture.db.query(
    `INSERT INTO corner_brief_revisions(corner_id,revision,spec,objective,author_id,source_room_id)
    VALUES($1,1,'Build the first version.','Build it',$2,$3)`,
    [C, H, R],
  );
  await send('@hoots start the thread', C);
  await send('@hoots continue', C);
  await rootFixture.db.query(
    `INSERT INTO corner_brief_revisions(corner_id,revision,spec,objective,author_id,source_room_id)
    VALUES($1,2,'Build the second version.','Build it',$2,$3)`,
    [C, H, R],
  );
  await send('@hoots go on', C);
  const [opening, unchanged, revised] = await commands(A, C);
  expect(opening!.source.conversationContext).toContain('revision 1');
  expect(unchanged!.source.conversationContext ?? '').not.toContain('Current thread brief');
  expect(revised!.source.conversationContext).toContain('Build the second version.');
  expect(revised!.source.conversationContext).not.toContain('Build the first version.');
  // External sessions read the same delta from the wake payload.
  const wakes = await pendingMcpWakes(rootFixture.db, A);
  expect(wakes.find((wake) => wake.id === revised!.id)?.institutionalContext ?? '').toContain(
    'Build the second version.',
  );
});

it('delivers all unseen messages beyond the cold window limit for agent requests', async () => {
  await queueAgentRequest('opening request');
  for (let index = 0; index < 25; index++) await send(`Unseen chatter ${index}.`);
  await queueAgentRequest('next request');
  const next = (await commands(A)).at(-1)!;
  for (let index = 0; index < 25; index++)
    expect(next.source.conversationContext).toContain(`Unseen chatter ${index}.`);
  expect(next.source.conversationContext).not.toContain('opening request');
  expect(next.source.conversationWindow).not.toContain('Unseen chatter 0.');
  expect(next.source.conversationWindow).toContain('Unseen chatter 24.');
  await queueAgentRequest('another request');
  expect((await commands(A)).at(-1)!.source.conversationContext).toBeUndefined();
});

it('makes a person tag the task and leaves room history available on demand', async () => {
  const { messageId } = await send('Older skirmish assignment');
  await send('@hoots respond');
  const [command] = await commands();
  const prompt = itemPrompt(command!, { names: new Map(), fresh: true, threads: 'Old thread objectives', tasks: 'Other work' });
  expect(prompt).toMatch(/Reply to the message below\.[\s\S]*text: @hoots respond$/);
  expect(prompt).toContain('Members (exact tag spellings):');
  for (const unrelated of ['Older skirmish assignment', 'Old thread objectives', 'Other work'])
    expect(prompt).not.toContain(unrelated);
  const history = await daemon.execute('getRoomMessage', { roomId: R, messageId }, A);
  expect(history).toMatchObject({ messageId, body: 'Older skirmish assignment' });
});

it('delivers the generated human thread rename and first-brief asks on its first native and external turn', async () => {
  await rootFixture.db.query('UPDATE rooms SET name=$2 WHERE id=$1', [C, 'steady-amber-thread']);
  await send('@hoots Build the thread naming fix', C);
  const [opening] = await commands(A, C);
  const native = itemPrompt(opening!, { names: new Map(), fresh: true });
  const wake = (await pendingMcpWakes(rootFixture.db, A)).find(wake => wake.id === opening!.id)!;
  const runner = { node: '/synthetic/node', bundle: '/synthetic/beeline.mjs' };
  const joined = { agent: 'codex', cwd: '/synthetic' } as Parameters<typeof renderWake>[1];
  const external = renderWake(wake, joined, runner);
  // Mentions carry the same frozen context through queuedContextSql.
  const mention = renderMention({ id: opening!.sourceMessageId, room_id: C,
    institutionalContext: wake.institutionalContext, text: opening!.source.body });
  for (const prompt of [native, external, mention]) {
    expect(prompt).toContain('still has its generated name, "steady-amber-thread"');
    expect(prompt).toContain('revise_thread(action:install_brief');
    expect(prompt).toContain('a short objective');
    expect(prompt).toContain('brief.approval.sourceMessageId');
    expect(prompt).not.toContain('No assigned brief yet');
  }
});

it('does not ask to rename a human thread after its name and brief are set', async () => {
  await rootFixture.db.query('UPDATE rooms SET name=$2 WHERE id=$1', [C, 'thread-naming-fix']);
  await rootFixture.db.query(
    `INSERT INTO corner_brief_revisions(corner_id,revision,spec,objective,author_id,source_room_id)
     VALUES($1,1,'Restore the naming prompt.','Restore naming',$2,$3)`, [C, H, R],
  );
  await send('@hoots Continue the fix', C);
  const [opening] = await commands(A, C);
  const wake = (await pendingMcpWakes(rootFixture.db, A)).find(wake => wake.id === opening!.id)!;
  for (const prompt of [itemPrompt(opening!, { names: new Map(), fresh: true }), wake.institutionalContext ?? '']) {
    expect(prompt).toContain('Restore the naming prompt.');
    expect(prompt).not.toContain('still has its generated name');
    expect(prompt).not.toContain('write the first brief');
  }
});

// Contract: a command response supplies current accessible threads even when the
// helper has no cache. Reading before/after archive rejects a stale queue-time list.
it('supplies current active threads on the shared command delivery boundary', async () => {
  await send('@hoots work on the code');
  const [chat] = await commands(A);
  expect(chat!.threads?.corners).toEqual([
    expect.objectContaining({ cornerId: C, parentRoomId: R, archived: false }),
  ]);
  await send('@hoots continue', C);
  const [thread] = await commands(A, C);
  expect(thread!.threads?.corners).toEqual([
    expect.objectContaining({ cornerId: C, parentRoomId: R, archived: false }),
  ]);
  await rootFixture.db.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [C]);
  const [updated] = await commands(A);
  expect(updated!.threads).toEqual({ corners: [] });
});
