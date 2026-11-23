import { afterEach, beforeEach, expect, it } from 'vitest';
import { MODEL_AGENT, MODEL_ROOM, ownedModelFixture } from './test-fixtures/owned-model.js';

let fixture: Awaited<ReturnType<typeof ownedModelFixture>>;
beforeEach(async () => { fixture = await ownedModelFixture(); });
afterEach(async () => { await fixture.db.close(); });

it('uses the same bearer for consecutive turns and refuses it between turns', async () => {
  const { db, credentials, token, actor } = fixture;
  expect(actor.binding).toMatchObject({ commandId: 'synthetic-command', requestId: 'synthetic-request' });
  await db.query("UPDATE agent_commands SET state='complete' WHERE id=$1", [actor.binding.commandId]);
  await expect(credentials.authenticate(db, token, MODEL_ROOM)).rejects.toThrow('authority');
  await expect(credentials.assertCurrent(db, actor)).rejects.toThrow('authority');

  await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,root_command_id,root_source_message_id,
    agent_depth,state)
    VALUES('second-command',$1,$2,'second-request','input','human_tag','second-command','second-source',0,'pending')`, [MODEL_ROOM, MODEL_AGENT]);
  await expect(credentials.authenticate(db, token, MODEL_ROOM)).rejects.toThrow('authority');
  await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,started_at)
    VALUES($1,'second-request',$2,'working',now())`, [MODEL_ROOM, MODEL_AGENT]);
  const second = await credentials.authenticate(db, token, MODEL_ROOM);
  expect(second.binding).toMatchObject({ commandId: 'second-command', requestId: 'second-request' });
  await expect(credentials.assertCurrent(db, actor)).rejects.toThrow('authority');
});

it('requires the authenticated agent’s live Room and current membership', async () => {
  const { db, credentials, actor, token } = fixture;
  expect(() => credentials.actor({ ...actor })).toThrow('authority');
  await expect(credentials.authenticate(db, token, 'a different room')).rejects.toThrow('authority');
  await expect(credentials.authenticate(db, 'bfm_' + 'a'.repeat(43), MODEL_ROOM)).rejects.toThrow('authority');
  await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1', [MODEL_ROOM]);
  await expect(credentials.authenticate(db, token, MODEL_ROOM)).rejects.toThrow('authority');
  await expect(credentials.assertCurrent(db, actor)).rejects.toThrow('authority');
});
