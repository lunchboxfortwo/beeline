import { randomUUID } from 'node:crypto';
import type { MessageAddress } from '@beeline/api-contract/daemon';
import { expect, it } from 'vitest';
import { answerQueuedMessage } from './agent-command.js';
import { sendMessage } from './agent-messaging.js';
import { AgentScheduleLoop } from './agent-schedules.js';
import { A, B, CHAT, H, OTHER, db, daemon } from './messaging.test-support.js';

const cadence = { kind: 'interval', everyMinutes: 1 } as const;
const file = { url: 'https://server.test/v1/media/00000000-0000-4000-8000-000000000001', name: 'insights.json', mimeType: 'application/json', size: 3 };
const closing = 'Posted the morning card.';

const posts = async (place = CHAT) => (await db.query<{ text: string; files: string[] }>(
  `SELECT text,COALESCE((SELECT array_agg(part->>'name') FROM jsonb_array_elements(attachments) part),'{}') files
   FROM messages WHERE author_id=$1 AND room_id=$2 AND presentation<>'activity' AND deleted_at IS NULL ORDER BY created_at,id`,
  [B, place])).rows;
const notes = async () => (await db.query(`SELECT activity FROM messages WHERE author_id=$1 AND room_id=$2 AND presentation='activity'`, [B, CHAT])).rows
  .flatMap(row => (row.activity as { kind: string; text?: string }[]).filter(step => step.kind === 'note').map(step => step.text));
// The upload tool records a file on every command of the turn.
const upload = (requestId: string) => db.query(
  'UPDATE agent_commands SET answer_attachments=answer_attachments || $2::jsonb WHERE agent_id=$1 AND turn_request_id=$3',
  [B, JSON.stringify([file]), requestId]);

/** One turn: upload a file, reply quoting the request, then end with closing text. */
async function turn(requestId: string, quoteMsgId: string) {
  const invocation = { id: randomUUID(), requestId };
  await daemon.execute('startAgentTurn', { roomId: CHAT, requestId, invocationId: invocation.id }, B);
  await upload(requestId);
  await daemon.execute('message', { type: 'reply', roomId: CHAT, requestId, invocation, quoteMsgId, text: 'Morning card.' }, B);
  await answerQueuedMessage(db, B, { roomId: CHAT, requestId, text: closing, harnessEnded: true, invocation });
}

const ask = (from: MessageAddress) => sendMessage(db, { route: { from, to: { agent: B, place: CHAT } }, text: 'Send me a morning card.' });

it('Reproduction scheduled-reply-hold: a scheduled reply carries the turn\'s files and the closing text stays in activity', async () => {
  const request = await ask({ agent: H, place: CHAT });
  await daemon.execute('startAgentTurn', { roomId: CHAT, requestId: request.id, invocationId: randomUUID() }, B);
  const { scheduleId } = await daemon.execute('createAgentSchedule', { roomId: CHAT, title: 'Morning card', prompt: 'Post the morning card.', cadence, requestId: request.id }, B);
  await answerQueuedMessage(db, B, { roomId: CHAT, requestId: request.id, text: 'Scheduled.' });
  const due = (await db.query<{ next_run_at: Date }>('SELECT next_run_at FROM agent_schedules WHERE id=$1', [scheduleId])).rows[0]!.next_run_at;
  expect(await new AgentScheduleLoop(db).runOnce(due)).toBe(1);
  const run = (await daemon.execute('getAgentCommands', { roomId: CHAT }, B)).commands.find(item => item.reason === 'schedule')!;
  expect(run.sourceMessageId).toBe(request.id);
  await turn(run.turnRequestId, request.id);
  expect(await posts()).toEqual([{ text: 'Scheduled.', files: [] }, { text: 'Morning card.', files: ['insights.json'] }]);
  expect(await notes()).toEqual([closing]);
});

it('a reply to a person in this place carries the turn\'s files', async () => {
  const request = await ask({ agent: H, place: CHAT });
  await turn(request.id, request.id);
  expect(await posts()).toEqual([{ text: 'Morning card.', files: ['insights.json'] }]);
  expect(await notes()).toEqual([closing]);
});

it('a retried reply with files returns the saved reply and posts once', async () => {
  const request = await ask({ agent: H, place: CHAT });
  const invocation = { id: randomUUID(), requestId: request.id };
  await daemon.execute('startAgentTurn', { roomId: CHAT, requestId: request.id, invocationId: invocation.id }, B);
  await upload(request.id);
  const send = () => daemon.execute('message', { type: 'reply', roomId: CHAT, requestId: request.id, invocation,
    quoteMsgId: request.id, text: 'Morning card.', transportRequestId: 'retry-1' }, B);
  const first = await send();
  const retry = await send();
  expect(retry.messageId).toBe(first.messageId);
  expect(await posts()).toEqual([{ text: 'Morning card.', files: ['insights.json'] }]);
  await answerQueuedMessage(db, B, { roomId: CHAT, requestId: request.id, text: closing, harnessEnded: true, invocation });
  expect(await posts()).toEqual([{ text: 'Morning card.', files: ['insights.json'] }]);
  expect(await notes()).toEqual([closing]);
});

it('a retried reply to a deleted question returns the saved reply and posts once', async () => {
  const request = await ask({ agent: H, place: CHAT });
  const invocation = { id: randomUUID(), requestId: request.id };
  await daemon.execute('startAgentTurn', { roomId: CHAT, requestId: request.id, invocationId: invocation.id }, B);
  await upload(request.id);
  await db.query('UPDATE messages SET deleted_at=now() WHERE id=$1', [request.id]);
  const send = () => daemon.execute('message', { type: 'reply', roomId: CHAT, requestId: request.id, invocation,
    quoteMsgId: request.id, text: 'Morning card.', transportRequestId: 'retry-deleted' }, B);
  const first = await send();
  const retry = await send();
  expect(retry.messageId).toBe(first.messageId);
  expect(await posts()).toEqual([{ text: 'Morning card.', files: ['insights.json'] }]);
});

it('a transport ID reused in another chat does not copy the earlier reply\'s files', async () => {
  const send = async (place: string, upload_: boolean) => {
    const request = await sendMessage(db, { route: { from: { agent: H, place }, to: { agent: B, place } }, text: 'Send me a morning card.' });
    const invocation = { id: randomUUID(), requestId: request.id };
    await daemon.execute('startAgentTurn', { roomId: place, requestId: request.id, invocationId: invocation.id }, B);
    if (upload_) await upload(request.id);
    const saved = await daemon.execute('message', { type: 'reply', roomId: place, requestId: request.id, invocation,
      quoteMsgId: request.id, text: 'Morning card.', transportRequestId: 'shared' }, B);
    await answerQueuedMessage(db, B, { roomId: place, requestId: request.id, text: closing, harnessEnded: true, invocation });
    return saved;
  };
  const first = await send(CHAT, true);
  const second = await send(OTHER, false);
  expect(second.messageId).not.toBe(first.messageId);
  expect(await posts()).toEqual([{ text: 'Morning card.', files: ['insights.json'] }]);
  expect(await posts(OTHER)).toEqual([{ text: 'Morning card.', files: [] }]);
});

it('a reply to a person in another place leaves the files with the closing text here', async () => {
  const request = await ask({ agent: H, place: OTHER });
  await turn(request.id, request.id);
  expect(await posts(OTHER)).toEqual([{ text: 'Morning card.', files: [] }]);
  expect(await posts()).toEqual([{ text: closing, files: ['insights.json'] }]);
});

it('a reply to an agent leaves the files with the closing text', async () => {
  const request = await ask({ agent: A, place: CHAT });
  await turn(request.id, request.id);
  expect((await posts()).map(post => post.files)).toEqual([[], ['insights.json']]);
  expect((await posts()).at(-1)?.text).toBe(closing);
});
