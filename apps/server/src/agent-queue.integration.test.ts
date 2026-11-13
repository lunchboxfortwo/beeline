import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { AGENT_COMMAND_SCHEMA, createAgentCommand } from './agent-command.js';
import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
import { claimAgentConnection, releaseAgentConnection } from './connection-presence.js';
import { LiveHub } from './live.js';

const H = 'a'.repeat(64), A = 'b'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111';
const R1 = '22222222-2222-4222-8222-222222222222';
const R2 = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase, daemon: DaemonService, live: LiveHub;
let sequence = 0;
beforeAll(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Person','person'),($2,'agent','Agent','agent')`, [H, A]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [A, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Queue')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'One'),($2,$3,'Two')`, [R1, R2, W]);
  for (const who of [H, A]) for (const room of [null, R1, R2])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [W, room, who]);
  live = new LiveHub();
  daemon = new DaemonService(db, live);
}, 30_000);
afterAll(async () => db.close());
beforeEach(async () => {
  await db.query('DELETE FROM agent_commands');
  await db.query('DELETE FROM agent_turns');
});

/** A person tags the agent in a Room: one queue item. */
async function ask(roomId: string, text: string) {
  const id = `m${String(++sequence).padStart(63, '0')}`;
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
    VALUES($1,$2,$3,$4,'message',now())`, [id, roomId, H, `@agent ${text}`]);
  return (await createAgentCommand(db, { roomId, agentId: A, sourceMessageId: id, reason: 'human_tag' }))!;
}
const queue = async () => (await daemon.execute('getAgentCommands', {}, A)).commands;
const answer = (roomId: string, requestId: string, text: string) =>
  daemon.execute('postRoomMessage', { roomId, requestId, text, presentation: 'message' }, A);

it('one queue per agent: items from every place, oldest first, with where the answer goes', async () => {
  const first = await ask(R2, 'first');
  const second = await ask(R1, 'second');
  const items = await queue();
  expect(items.map(item => [item.id, item.roomId, item.returnRoomId])).toEqual([
    [first.id, R2, R2], [second.id, R1, R1]]);
  expect(items[0]!.source.body).toContain('first');
});

it('an item stays queued until its answer is posted, then the answer is idempotent', async () => {
  const item = await ask(R1, 'hello');
  await daemon.execute('startAgentTurn', { roomId: R1, requestId: item.turn_request_id }, A);
  expect((await queue()).map(entry => entry.id)).toEqual([item.id]);
  const posted = await answer(R1, item.turn_request_id, 'hi there');
  expect(await queue()).toEqual([]);
  const resent = await answer(R1, item.turn_request_id, 'hi there');
  expect(resent.id).toBe(posted.id);
  expect((await db.query(`SELECT count(*)::int n FROM messages WHERE author_id=$1 AND request_id=$2`,
    [A, item.turn_request_id])).rows[0]).toEqual({ n: 1 });
  expect((await db.query(`SELECT state,result_message_id FROM agent_commands WHERE id=$1`, [item.id])).rows[0])
    .toEqual({ state: 'complete', result_message_id: posted.id });
});

it('a dropped helper leaves the item queued for its next registration', async () => {
  const item = await ask(R1, 'still there?');
  await claimAgentConnection(db, live, A, {}, { connectionId: 'one', instanceId: 'server' });
  await daemon.execute('startAgentTurn', { roomId: R1, requestId: item.turn_request_id }, A);
  await releaseAgentConnection(db, live, A, 'one');
  await claimAgentConnection(db, live, A, {}, { connectionId: 'two', instanceId: 'server' });
  expect((await queue()).map(entry => entry.id)).toEqual([item.id]);
});

it('upgrades a legacy resume sharing its parent source without losing either answer obligation', async () => {
  const parent = await ask(R1, 'answer both items');
  await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,
    action,reason,root_command_id,parent_command_id,root_source_message_id,agent_depth,state)
    SELECT 'legacy-resume',room_id,agent_id,source_message_id,turn_request_id,'resume','resume',
      root_command_id,id,root_source_message_id,agent_depth,'pending' FROM agent_commands WHERE id=$1`, [parent.id]);
  await db.query(AGENT_COMMAND_SCHEMA);
  const items = await queue();
  expect(items.map(item=>[item.id,item.turnRequestId])).toEqual([
    [parent.id,parent.turn_request_id],['legacy-resume','legacy-resume']]);
  expect(items[1]!.source.body).toContain('answer both items');
  await answer(R1,parent.turn_request_id,'First answer');
  expect((await queue()).map(item=>item.id)).toEqual(['legacy-resume']);
  await answer(R1,'legacy-resume','Resume answer');
  expect(await queue()).toEqual([]);
});

it('Stop cancels the item: it leaves the queue and its answer is refused', async () => {
  const item = await ask(R1, 'long job');
  await daemon.execute('startAgentTurn', { roomId: R1, requestId: item.turn_request_id }, A);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES('stop-source',$1,$2,'stop','message')`, [R1, H]);
  const phone = new (await import('./phone-service.js')).PhoneService(db, 'http://test');
  await phone.cancelAgentTurn({ roomId: R1, agentId: A, requestId: item.turn_request_id }, H);
  expect(await queue()).toEqual([]);
  await expect(answer(R1, item.turn_request_id, 'too late')).rejects.toThrow('command turn cancelled');
});

it('empty output and silence acknowledgements leave an unanswered request queued', async () => {
  const item = await ask(R1, 'anything?');
  await answer(R1, item.turn_request_id, '<thinking>nothing to say</thinking>');
  expect((await queue()).map(entry => entry.id)).toEqual([item.id]);
  expect((await db.query(`SELECT count(*)::int n FROM messages WHERE author_id=$1 AND request_id=$2`,
    [A, item.turn_request_id])).rows[0]).toEqual({ n: 0 });
  expect(await daemon.execute('markAgentTurnSilent', { roomId: R1, requestId: item.turn_request_id }, A)).toMatchObject({ answered: false });
  expect((await queue()).map(entry => entry.id)).toEqual([item.id]);
  await answer(R1, item.turn_request_id, 'Here is my answer.');
  expect(await queue()).toEqual([]);
});

it('posts a private answer to the return address fixed at insertion, then completes the item', async () => {
  const item = await createAgentCommand(db, { roomId: R1, agentId: A, sourceMessageId: null, reason: 'order',
    privatePayload: { kind: 'order', text: 'answer in Two', authorId: H, fromRoomId: R2 } });
  expect((await queue()).find(entry => entry.id === item!.id)?.returnRoomId).toBe(R2);
  // A later mutable context must not move the committed return address.
  await db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{fromRoomId}',to_jsonb($2::text))
    WHERE id=$1`, [item!.id, R1]);
  await answer(R1, item!.turn_request_id, 'recorded-route answer');
  expect((await db.query('SELECT room_id,text FROM messages WHERE author_id=$1 AND text=$2', [A, 'recorded-route answer'])).rows)
    .toEqual([{ room_id: R2, text: 'recorded-route answer' }]);
  expect(await queue()).toEqual([]);
  await answer(R1, item!.turn_request_id, 'recorded-route answer');
  expect((await db.query('SELECT count(*)::int n FROM messages WHERE author_id=$1 AND text=$2', [A, 'recorded-route answer'])).rows[0])
    .toEqual({ n: 1 });
});

it('retains the answer obligation when return membership is gone, with no public fallback', async () => {
  const item = await createAgentCommand(db, { roomId: R1, agentId: A, sourceMessageId: null, reason: 'order',
    privatePayload: { kind: 'order', text: 'private question', authorId: H, fromRoomId: R2 } });
  await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [R2, H]);
  try {
    await expect(answer(R1, item!.turn_request_id, 'private answer')).rejects.toThrow('return address');
    expect((await queue()).map(entry => entry.id)).toContain(item!.id);
    expect((await db.query('SELECT 1 FROM messages WHERE author_id=$1 AND text=$2', [A, 'private answer'])).rows).toEqual([]);
  } finally {
    await db.query('UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2', [R2, H]);
  }
});

it('queues messages beyond the retired chain-depth cap', async () => {
  const parent = await ask(R1, 'root');
  await db.query('UPDATE agent_commands SET agent_depth=50 WHERE id=$1', [parent.id]);
  const next = await createAgentCommand(db, { roomId: R1, agentId: A, sourceMessageId: null, reason: 'order',
    parent: { ...parent, agent_depth: 50 }, privatePayload: { kind: 'order', text: 'next request', authorId: H, fromRoomId: R1 } });
  expect(next!.agent_depth).toBe(51);
  expect((await queue()).map(entry => entry.id)).toEqual([parent.id, next!.id]);
});

it('drops malformed optional tool history without losing the answer', async () => {
  const item = await ask(R1, 'answer despite broken history');
  await daemon.execute('postRoomMessage', { roomId: R1, requestId: item.turn_request_id,
    text: 'answer without history', steps: [{ kind: 'unsupported' }] as never }, A);
  expect(await queue()).toEqual([]);
  expect((await db.query('SELECT text FROM messages WHERE author_id=$1 AND request_id=$2', [A, item.turn_request_id])).rows)
    .toEqual([{ text: 'answer without history' }]);
});

it('shows only the offline connection notice when the harness cannot start, keeping its item queued', async () => {
  const item = await ask(R1, 'waiting for a harness');
  await daemon.execute('startAgentTurn', { roomId: R1, requestId: item.turn_request_id, available: false }, A);
  expect((await queue()).map(entry => entry.id)).toEqual([item.id]);
  const notices = await db.query<{text:string}>(`SELECT text FROM messages WHERE room_id=$1 AND presentation='system'`, [R1]);
  expect(notices.rows.at(-1)?.text).toMatch(/is offline.*connect again/);
  expect((await db.query('SELECT state,completed_at FROM agent_commands WHERE id=$1', [item.id])).rows[0])
    .toEqual({ state: 'pending', completed_at: null });
});
