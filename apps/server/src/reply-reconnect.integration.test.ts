import { vi } from 'vitest';
import { AgentTurnStream } from '../../body/src/turn-stream.js';
import { DaemonApiError, type DaemonApiClient } from '../../body/src/daemon-api-client.js';
import { requestErrorStatus } from './server-request-error-status.js';
import { expect, it, A, H, R, claim, commands, send, result, disconnectHelper, helperOwner, rootFixture } from './test-support-agent-command.integration.test-support.js';

it.each(['reconnect','stale-server','closed-connection'])('Reproduction reply-reconnect: a reply survives %s and the first answer wins', async path => {
  await send('@hoots answer this');
  const [command] = await commands();
  await claim(command!, 'connection-a');
  if (path !== 'stale-server') await disconnectHelper();
  if (path === 'reconnect') await helperOwner(A);
  if (path === 'stale-server') await rootFixture.db.query("UPDATE live_server_instances SET renewed_at=now()-interval '2 minutes'");
  const answer = `Answer after ${path}`;
  await result(command!, answer, 'connection-a');
  const view = await rootFixture.phone.readRoom(R, H);
  expect(view!.messages.filter(m => m.text === answer)).toHaveLength(1);
  await expect(result(command!, 'A second answer', 'connection-a')).rejects.toThrow();
});

it('two connections of the same agent land exactly one answer', async () => {
  await send('@hoots answer once');
  const [command] = await commands();
  await claim(command!, 'connection-a');
  await disconnectHelper();
  await helperOwner(A);
  await claim(command!, 'connection-b');
  const outcomes = await Promise.allSettled([
    result(command!, 'Answer A', 'connection-a'), result(command!, 'Answer B', 'connection-b'),
  ]);
  expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
  expect((await rootFixture.phone.readRoom(R, H))!.messages.filter(m => /^Answer [AB]$/.test(m.text))).toHaveLength(1);
});

it('a refused reply immediately releases its matching claim', async () => {
  await send('@hoots answer');
  const [command] = await commands();
  await claim(command!);
  await expect(result(command!, 'Reply', 'g1', {replyToMessageId:'f'.repeat(64)})).rejects.toThrow();
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1', [command!.id])).rows[0]?.state).toBe('pending');
  await claim(command!, 'retry');
  await result(command!, 'Recovered', 'retry');
  expect((await rootFixture.phone.readRoom(R, H))!.messages.some(m => m.text === 'Recovered')).toBe(true);
});

it('membership removal refuses a reply and leaves its job pending', async () => {
  await send('@hoots answer');
  const [command] = await commands();
  await claim(command!);
  await rootFixture.db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [R,A]);
  await expect(result(command!, 'Must not arrive')).rejects.toThrow();
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1', [command!.id])).rows[0]?.state).toBe('pending');
  expect((await rootFixture.phone.readRoom(R, H))!.messages.some(m => m.text === 'Must not arrive')).toBe(false);
});

it('a second reply to the same tag is explicitly reported as not delivered', async () => {
  const tag = await send('@hoots first tag');
  await rootFixture.db.query(`INSERT INTO rooms_mcp_mentions(member_id,room_id,message_id)
    VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [A,R,tag.messageId]);
  const [first] = await commands();
  await claim(first!, 'first-tag');
  await result(first!, 'The first tagged answer', 'first-tag', {replyToMessageId:tag.messageId});
  await send('@hoots another job');
  const [second] = await commands();
  await claim(second!, 'second-tag');
  await expect(result(second!, 'The discarded tagged answer', 'second-tag', {replyToMessageId:tag.messageId}))
    .rejects.toThrow('Reply not delivered: this tag already has an answer');
  expect((await rootFixture.phone.readRoom(R,H))!.messages.some(m => m.text === 'The discarded tagged answer')).toBe(false);
});

it.each(['workflow', 'membership', 'cancelled'] as const)(
  'Reproduction reclaimed-reply: service refusal for %s reaches the stream without bypassing authority', async boundary => {
    const source = await send('@hoots reclaimed reply');
    const [command] = await commands();
    await claim(command!, 'old');
    await disconnectHelper();
    await helperOwner(A);
    await claim(command!, 'new');
    if (boundary === 'workflow')
      await rootFixture.db.query(`UPDATE messages SET card='{"runId":"reclaimed-workflow"}' WHERE id=$1`, [source.messageId]);
    if (boundary === 'membership')
      await rootFixture.db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [R,A]);
    if (boundary === 'cancelled')
      await rootFixture.db.query("UPDATE agent_commands SET state='cancelled' WHERE id=$1", [command!.id]);
    let attempts = 0;
    const statuses: number[] = [];
    const execute = async (name: string, input: Record<string, unknown>) => {
      if (name !== 'postRoomMessage') throw new Error(`Unexpected operation ${name}`);
      attempts++;
      try { return await rootFixture.daemon.execute('postRoomMessage', {...input, generationId:'old'} as never, A); }
      catch (error) {
        const status = requestErrorStatus(error);
        statuses.push(status);
        throw new DaemonApiError((error as Error).message, status, false);
      }
    };
    const failure = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const stream = new AgentTurnStream({api:{execute} as unknown as DaemonApiClient,
        agentId:A,roomId:R,requestId:command!.turnRequestId,label:'reclaimed service proof'});
      await expect(stream.settle('Old output must not land')).rejects.toThrow();
      expect(attempts).toBe(boundary === 'workflow' ? 2 : 1);
      expect(statuses).toEqual(boundary === 'workflow' ? [409,409] : [403]);
      if (boundary === 'workflow') expect(failure).toHaveBeenCalledOnce();
      else expect(failure).not.toHaveBeenCalled();
      expect((await rootFixture.phone.readRoom(R,H))!.messages.some(m => m.text === 'Old output must not land')).toBe(false);
      const state = (await rootFixture.db.query('SELECT state,generation_id FROM agent_commands WHERE id=$1', [command!.id])).rows[0];
      expect(state).toMatchObject({state:boundary === 'cancelled' ? 'cancelled' : 'claimed',generation_id:'new'});
    } finally { failure.mockRestore(); }
  });
