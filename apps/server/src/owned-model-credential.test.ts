import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDatabase } from './database.js';
import { OwnedModelCredentials } from './owned-model-credential.js';
import { OwnedModelAttempts } from './owned-model-attempt.js';
import { MODEL_AGENT, MODEL_CLAIM, MODEL_KEY, MODEL_ROOM, MODEL_SOURCE, MODEL_WORKSPACE, ownedModelFixture } from './test-fixtures/owned-model.js';
import { endAgentTurn } from './agent-turn-end.js';

describe('opaque immutable owned-model credential primitive', () => {
  let fixture: Awaited<ReturnType<typeof ownedModelFixture>>;
  beforeEach(async () => { fixture = await ownedModelFixture(); });
  afterEach(async () => { await fixture.db.close(); });

  it('reconstructs the same credential on claim replay with no credential/command renewal or DML', async () => {
    const { db, credentials, issued } = fixture;
    const before = (await db.query('SELECT xmin::text version,* FROM owned_model_credentials')).rows;
    const queries: string[] = [];
    const observe = (tx: SqlDatabase): SqlDatabase => ({ query: (sql, values) => { queries.push(sql); return tx.query(sql, values); },
      transaction: work => tx.transaction(inner => work(observe(inner))) });
    expect(await db.transaction(tx => credentials.issueInTransaction(observe(tx), MODEL_CLAIM))).toEqual(issued);
    expect((await db.query('SELECT xmin::text version,* FROM owned_model_credentials')).rows).toEqual(before);
    expect(queries.some(sql => /\b(?:INSERT|UPDATE|DELETE)\b|beeline_register_owned_effect/.test(sql))).toBe(false);
    expect(JSON.stringify(before)).not.toContain(issued.token);
    expect(JSON.stringify(before)).not.toContain(MODEL_KEY.toString('hex'));
    expect(before[0]?.token_hash).toBe(createHash('sha256').update(issued.token).digest('hex'));
  });

  it('keeps its immutable bearer through a dropped socket, a stale server lease and a reconnect through another server instance',async()=>{
    const {db,credentials,issued,actor}=fixture;
    await db.query(`UPDATE agent_connections SET released_at=clock_timestamp()`);
    await db.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '1 hour'`);
    await db.transaction(tx=>credentials.assertCurrent(tx,actor));
    await credentials.authenticate(db,issued.token);
    await db.query(`INSERT INTO live_server_instances VALUES('reconnected-server',clock_timestamp());
      UPDATE agent_connections SET connection_id='reconnected-socket',
        epoch=epoch+1,instance_id='reconnected-server',released_at=NULL`);
    expect(await db.transaction(tx=>credentials.issueInTransaction(tx,MODEL_CLAIM))).toEqual(issued);
    await db.transaction(tx=>credentials.assertCurrent(tx,actor));
    expect((await db.query('SELECT count(*)::int n FROM owned_model_credentials')).rows[0]).toEqual({n:1});
  });

  it('separates the key-derivation and credential-message MAC domains from direct sealing-key MACs', async () => {
    const { db, issued, credentials } = fixture;
    const row = (await db.query('SELECT * FROM owned_model_credentials')).rows[0]!;
    const data = JSON.stringify([row.id, row.key_version, row.agent_id, row.owner_id, row.workspace_id, row.room_id, row.command_id,
      row.request_id, row.connection_id, row.connection_epoch === null ? null : Number(row.connection_epoch), row.instance_id, row.model,
      row.agent_model, row.model_token_hash, row.expires_ms === null ? null : Number(row.expires_ms)]);
    const key = createHmac('sha256', MODEL_KEY).update('beeline:owned-model:credential-key:v1\0').digest();
    const mac = createHmac('sha256', key).update('beeline:owned-model:credential:v1\0').update(data).digest('hex');
    expect(issued.token).toBe(`bfmc_v1.${row.id}.${mac}`);
    for (const wrong of [createHmac('sha256', MODEL_KEY).update(data).digest('hex'),
      createHmac('sha256', key).update('beeline:legacy-model:v1\0').update(data).digest('hex')])
      await expect(credentials.authenticate(db, `bfmc_v1.${row.id}.${wrong}`)).rejects.toThrow('authority');
    await expect(new OwnedModelCredentials({ currentVersion: 'test-v1', key: () => Buffer.alloc(32, 8) },
      () => 'synthetic/model').authenticate(db, issued.token)).rejects.toThrow('authority');
  });

  it('rejects malformed legacy-prefix, substituted ID and signature credentials without fallback', async () => {
    const { db, credentials, issued } = fixture;
    for (const token of ['bfm_legacy', issued.token + '.extra', issued.token.replace('bfmc_v1.', 'bfmc_v2.'),
      issued.token.replace(/\.[a-f0-9]{64}$/, '.' + '0'.repeat(64)), issued.token.replace(/^bfmc_v1\.[^.]+/, 'bfmc_v1.' + 'f'.repeat(32))])
      await expect(credentials.authenticate(db, token)).rejects.toThrow('authority');
  });

  it('rejects normal SQL identity/expiry mutation and cannot authenticate an out-of-band tampered binding', async () => {
    const { db, credentials, issued } = fixture;
    await expect(db.query(`UPDATE owned_model_credentials SET expires_ms=1000`)).rejects.toThrow('immutable');
    await expect(db.query('DELETE FROM owned_model_credentials')).rejects.toThrow('retained');
    // Synthetic DB-owner corruption bypasses the ordinary immutable trigger;
    // the original bearer still cannot authenticate the changed signed row.
    await db.query('ALTER TABLE owned_model_credentials DISABLE TRIGGER beeline_owned_model_credential_immutable');
    await db.query(`UPDATE owned_model_credentials SET command_id='another-command'`);
    await expect(credentials.authenticate(db, issued.token)).rejects.toThrow('authority');
  });

  it.each(['membership', 'workspace', 'archive', 'retired', 'model', 'command', 'stop'])(
    'refuses a previously authenticated actor after actual %s authority changes', async change => {
      const { db, credentials, actor, issued } = fixture;
      if (change === 'membership') await db.query('UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1', [MODEL_ROOM]);
      if (change === 'workspace') await db.query('UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id IS NULL AND identity_id=$1', [MODEL_AGENT]);
      if (change === 'archive') await db.query('UPDATE rooms SET archived_at=clock_timestamp() WHERE id=$1', [MODEL_ROOM]);
      if (change === 'retired') await db.query('UPDATE free_agents SET removed_at=clock_timestamp() WHERE agent_id=$1', [MODEL_AGENT]);
      if (change === 'model') await db.query(`UPDATE free_agents SET model='synthetic/other' WHERE agent_id=$1`, [MODEL_AGENT]);
      if (change === 'command') await db.query(`UPDATE agent_commands SET state='cancelled' WHERE id=$1`, [MODEL_CLAIM.commandId]);
      if (change === 'stop') await db.query(`UPDATE agent_commands SET action='stop' WHERE id=$1`, [MODEL_CLAIM.commandId]);
      await expect(credentials.assertCurrent(db, actor)).rejects.toThrow('authority');
      await expect(credentials.authenticate(db, issued.token)).rejects.toThrow('authority');
    },
  );

  it('keeps queue authority through bootstrap token creation and rotation', async () => {
    const { db, credentials, issued } = fixture;
    for (const tokenHash of [null, 'd'.repeat(64), 'e'.repeat(64)]) {
      await db.query('UPDATE free_agents SET model_token_hash=$1 WHERE agent_id=$2', [tokenHash, MODEL_AGENT]);
      expect((await credentials.forCommands(db, [MODEL_CLAIM.commandId])).get(MODEL_CLAIM.commandId)).toEqual(issued);
      await credentials.authenticate(db, issued.token);
    }
  });

  it('does not issue another item’s credential or manufacture a trusted actor from JSON', async () => {
    const { db, credentials, actor } = fixture;
    await expect(db.transaction(tx => credentials.issueInTransaction(tx, { ...MODEL_CLAIM, commandId: 'unknown-item' }))).rejects.toThrow('authority');
    expect(() => credentials.actor({ binding: actor.binding } as typeof actor)).toThrow('authority');
    expect((await db.query('SELECT count(*)::int count FROM owned_model_credentials')).rows[0]?.count).toBe(1);
  });
  it.each(['private_payload', 'review_context'] as const)('keeps the same item credential after optional %s changes with an UNKNOWN model result', async kind => {
    const { db, credentials, actor, issued } = fixture;
    const attempts = new OwnedModelAttempts(db, credentials);
    const prepared = async () => ({ reservation: { day: '2026-11-02', reserved: 16, maxOutput: 8, reservedUsd: 0.01, credit: 0 },
      payload: { model: actor.binding.model, max_tokens: 8, messages: [] } });
    await attempts.reserve(actor, '11111111-1111-4111-8111-111111111111', { step: 'request' }, prepared);
    await db.query(`UPDATE agent_commands SET ${kind}='{"synthetic":true}'::jsonb WHERE id=$1`, [MODEL_CLAIM.commandId]);
    expect(await db.transaction(tx => credentials.issueInTransaction(tx, MODEL_CLAIM))).toEqual(issued);
    expect((await attempts.reserve(actor, '11111111-1111-4111-8111-111111111111', { step: 'request' }, prepared)).permit).toBeUndefined();
    expect((await db.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown' }]);
  });

  it('leaves an explicit different durable command available while the prior command remains UNKNOWN', async () => {
    const { db, credentials, actor } = fixture, attempts = new OwnedModelAttempts(db, credentials);
    const prepared = async () => ({ reservation: { day: '2026-11-02', reserved: 16, maxOutput: 8, reservedUsd: 0.01, credit: 0 },
      payload: { model: actor.binding.model, max_tokens: 8, messages: [] } });
    await attempts.reserve(actor, '11111111-1111-4111-8111-111111111111', { step: 'same synthetic semantic payload' }, prepared);
    await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,root_command_id,root_source_message_id,
      agent_depth,state)
      SELECT 'different-command',room_id,agent_id,'different-request','input','human_tag','different-command','different-human-source',
        0,'pending' FROM agent_commands WHERE id=$1`, [MODEL_CLAIM.commandId]);
    const granted = await db.transaction(tx => credentials.issueInTransaction(tx, { ...MODEL_CLAIM, commandId: 'different-command' }));
    const different = await credentials.authenticate(db, granted.token);
    expect((await attempts.reserve(different, '22222222-2222-4222-8222-222222222222', { step: 'same synthetic semantic payload' }, prepared)).permit).toBeDefined();
    expect((await db.query('SELECT command_id,state FROM owned_model_attempts ORDER BY command_id')).rows).toEqual([
      { command_id: 'different-command', state: 'unknown' }, { command_id: MODEL_CLAIM.commandId, state: 'unknown' },
    ]);
  });

  it('keeps separate queue-item credentials across Rooms when one item is stopped', async () => {
    const { db, credentials, issued } = fixture;
    const otherRoom = '33333333-3333-4333-8333-333333333333';
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Other Room')`, [otherRoom, MODEL_WORKSPACE]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [MODEL_WORKSPACE, otherRoom, MODEL_AGENT]);
    await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,root_command_id,
      root_source_message_id,agent_depth,state)
      VALUES('other-command',$1,$2,'other-request','input','human_tag','other-command','other-source',0,'pending')`,
      [otherRoom, MODEL_AGENT]);
    const other = await db.transaction(tx => credentials.issueInTransaction(tx,
      { agentId: MODEL_AGENT, commandId: 'other-command' }));
    expect(other.token).not.toBe(issued.token);
    expect((await credentials.authenticate(db, other.token)).binding.roomId).toBe(otherRoom);
    expect((await credentials.authenticate(db, issued.token)).binding.roomId).toBe(MODEL_ROOM);
    await db.transaction(tx => endAgentTurn(tx, { id: 'other-command' }, 'cancelled', 'stop'));
    await expect(credentials.authenticate(db, other.token)).rejects.toThrow('authority');
    expect((await credentials.authenticate(db, issued.token)).binding.commandId).toBe(MODEL_CLAIM.commandId);
  });
});
