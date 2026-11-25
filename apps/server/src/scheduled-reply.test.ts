import { randomBytes, randomUUID } from 'node:crypto';
import { SCHEDULE_SCHEDULER_NAME } from '@beeline/api-contract/scheduled-prompts';
import { expect, it } from 'vitest';
import { itemPrompt } from '../../body/src/place-prompt.js';
import { answerQueuedMessage, type CommandRow } from './agent-command.js';
import { sendMessage } from './agent-messaging.js';
import { AgentScheduleLoop } from './agent-schedules.js';
import { A, B, CHAT, H, THREAD, db, daemon } from './messaging.test-support.js';
import { PhoneService } from './phone-service.js';
import { resourceReadAuthority } from './resource-requester.js';

const cadence = { kind: 'interval', everyMinutes: 1 } as const;
const prompt = 'Send the daily CI report.';

async function fire(scheduleId: string) {
  const due = (await db.query<{ next_run_at: Date }>(
    'SELECT next_run_at FROM agent_schedules WHERE id=$1', [scheduleId])).rows[0]!.next_run_at;
  expect(await new AgentScheduleLoop(db).runOnce(due)).toBe(1);
  const { commands } = await daemon.execute('getAgentCommands', { roomId: THREAD }, B);
  const runs = commands.filter(item => item.reason === 'schedule');
  expect(runs).toHaveLength(1);
  const run = runs[0]!;
  const invocation = { id: randomUUID(), requestId: run.turnRequestId };
  await daemon.execute('startAgentTurn', { roomId: THREAD, requestId: run.turnRequestId, invocationId: invocation.id }, B);
  const command = (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [run.id])).rows[0]!;
  return { run, command, reply: (quoteMsgId: string) => daemon.execute('message', {
    type: 'reply', roomId: THREAD, requestId: run.turnRequestId, invocation, quoteMsgId, text: 'CI is green.',
  }, B) };
}

it.each(['create', 'update'] as const)('Reproduction standing-ask-reply: successive runs after %s reply to the original asker in their chat', async action => {
  const unrelated = await sendMessage(db, {
    route: { from: { agent: A, place: CHAT }, to: { agent: B, place: THREAD } }, text: 'Investigate yesterday’s CI.',
  });
  let parent: CommandRow | undefined;
  if (action === 'update') {
    const messageId = randomBytes(32).toString('hex');
    await new PhoneService(db, 'http://test').execute('sendRoomMessage', {
      roomId: CHAT, messageId, text: '@ruby renew the daily CI request.',
    }, H);
    parent = (await db.query<CommandRow>(
      'SELECT * FROM agent_commands WHERE agent_id=$1 AND source_message_id=$2', [A, messageId])).rows[0]!;
    expect(parent).toBeDefined();
  }
  const ask = await sendMessage(db, {
    route: { from: { agent: A, place: CHAT }, to: { agent: B, place: THREAD } }, text: 'Send me a daily CI report.', parent,
  });
  await daemon.execute('startAgentTurn', { roomId: THREAD, requestId: ask.id, invocationId: randomUUID() }, B);
  const definition = { roomId: THREAD, title: 'Daily CI', prompt, cadence };
  const { scheduleId } = await daemon.execute('createAgentSchedule', {
    ...definition, ...(action === 'create' ? { requestId: ask.id } : {}),
  }, B);
  if (action === 'update') await daemon.execute('updateAgentSchedule', { ...definition, scheduleId, requestId: ask.id }, B);
  expect((await db.query('SELECT requester_command_id FROM agent_schedules WHERE id=$1', [scheduleId])).rows)
    .toEqual([{ requester_command_id: ask.id }]);
  const original = (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [ask.id])).rows[0]!;
  await answerQueuedMessage(db, B, { roomId: THREAD, requestId: ask.id, text: 'Scheduled.' });

  const occurrences = new Set<string | null>();
  for (let occurrence = 0; occurrence < 2; occurrence += 1) {
    const { run, command, reply } = await fire(scheduleId);
    const rendered = itemPrompt(run, { names: new Map([[A, 'Ruby']]) });
    expect(rendered).toContain(`From: ${SCHEDULE_SCHEDULER_NAME} in #Widget\nid: ${command.source_message_id}\ntext: ${prompt}`);
    expect(rendered).toContain(`Reply with quoteMsgId "${ask.id}".`);
    await expect(reply(run.source.id)).rejects.toThrow('woke this turn');
    await expect(reply(unrelated.id)).rejects.toThrow('woke this turn');
    const saved = await reply(ask.id);
    expect((await db.query(`SELECT room_id,reply_to_message_id,card_type,card->'recipient'->>'id' recipient
      FROM messages WHERE id=$1`, [saved.id])).rows).toEqual([
      { room_id: CHAT, reply_to_message_id: ask.id, card_type: 'agent-command', recipient: A },
    ]);
    expect(run.from?.place).toBe(THREAD);
    expect(run.source.id).toBe(command.source_message_id);
    expect(run.sourceMessageId).toBe(ask.id);
    expect(run.scheduleId).toBe(scheduleId);
    expect(command.source_message_id).not.toBe(ask.id);
    expect(await resourceReadAuthority(db, command)).toEqual(await resourceReadAuthority(db, original));
    occurrences.add(command.source_message_id);
    await answerQueuedMessage(db, B, { roomId: THREAD, requestId: run.turnRequestId, text: '' });
  }
  const history = (await db.query<{ message_id: string }>(
    'SELECT message_id FROM agent_schedule_occurrences WHERE schedule_id=$1', [scheduleId])).rows;
  expect(history).toHaveLength(2);
  expect(occurrences).toEqual(new Set(history.map(row => row.message_id)));
});

it('an unbound schedule cannot reply to its system wake or to a past ask', async () => {
  const ask = await sendMessage(db, {
    route: { from: { agent: A, place: CHAT }, to: { agent: B, place: THREAD } }, text: 'Compare the CI runs.',
  });
  const { scheduleId } = await daemon.execute('createAgentSchedule', {
    roomId: THREAD, title: 'Daily CI', prompt, cadence,
  }, B);
  const { run, command, reply } = await fire(scheduleId);
  expect(run.source.id).toBe(command.source_message_id);
  await expect(reply(run.source.id)).rejects.toThrow('woke this turn');
  await expect(reply(ask.id)).rejects.toThrow('woke this turn');
});
