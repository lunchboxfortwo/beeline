import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgliteDatabase } from './test-support.js';
import {
  TURN_OWNERSHIP_SCHEMA, commandOwnerLiveSql, turnOwnershipEnabled, workingTurnFreshSql,
} from './turn-ownership.js';
import { MODEL_AGENT, MODEL_CLAIM, MODEL_ROOM, MODEL_SOURCE, ownedModelFixture } from './test-fixtures/owned-model.js';
import { claimAgentCommand, claimMcpOrder, readAgentCommands } from './agent-command.js';

describe('effective command ownership', () => {
  let db: PgliteDatabase;
  beforeEach(async () => {
    db = new PgliteDatabase();
    await db.query(`CREATE TABLE agent_commands(id text PRIMARY KEY,agent_id text,state text,lease_expires_at timestamptz,generation_id text,room_id text,turn_request_id text);
      CREATE TABLE agent_turns(room_id text,request_id text,agent_id text,generation_id text,created_at timestamptz);
      CREATE TABLE agent_connections(agent_id text PRIMARY KEY,connection_id text,epoch bigint,instance_id text,released_at timestamptz);
      CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz);`);
    await db.query(TURN_OWNERSHIP_SCHEMA);
    await db.query(`INSERT INTO live_server_instances VALUES('server',clock_timestamp());
      INSERT INTO agent_connections VALUES('agent','connection',1,'server',NULL);
      INSERT INTO agent_commands(id,agent_id,state,lease_expires_at) VALUES
        ('legacy-live','agent','claimed',now()+interval '1 day'),
        ('legacy-dead','agent','claimed',now()-interval '1 day'),('legacy-null','agent','pending',NULL);
      INSERT INTO agent_commands(id,agent_id,state,lease_expires_at,generation_id,turn_owner_connection_id,turn_owner_epoch)
        VALUES('owned','agent','claimed',NULL,'generation','connection',1);`);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await db.close(); });
  const active = async (db: PgliteDatabase) => (await db.query<{ id: string; active: boolean | null }>(
    `SELECT command.id,${commandOwnerLiveSql('command')} active
      FROM agent_commands command ORDER BY command.id`)).rows;

  it('drops the retired owner-live predicate by its exact signature and records the execution kind of claims admitted before it', async () => {
    await db.query(`CREATE FUNCTION beeline_command_owner_live(owned_agent text,owned_connection text,owned_epoch bigint,
      legacy_until timestamptz,observed_at timestamptz) RETURNS boolean AS $$ SELECT true $$ LANGUAGE sql VOLATILE`);
    await db.query(`INSERT INTO agent_commands(id,agent_id,state,generation_id) VALUES('app','agent','claimed','mcp:call')`);
    await db.query(TURN_OWNERSHIP_SCHEMA);
    expect((await db.query("SELECT count(*)::int n FROM pg_proc WHERE proname='beeline_command_owner_live'")).rows).toEqual([{ n: 0 }]);
    expect((await db.query(`SELECT id,execution_kind FROM agent_commands WHERE execution_kind IS NOT NULL ORDER BY id`)).rows)
      .toEqual([{ id: 'app', execution_kind: 'mcp' }, { id: 'owned', execution_kind: 'helper' }]);
    expect((await db.query(`SELECT connection_id,connection_epoch FROM agent_command_generation_owners`)).rows
      .every(row => row.connection_id === null && row.connection_epoch === null)).toBe(true);
  });

  it('ignores command expiry timestamps and a disabled admission gate cannot reinterpret an owned row', async () => {
    vi.stubEnv('BEELINE_NETWORK_ROUTER_V1', '0'); expect(turnOwnershipEnabled()).toBe(false);
    expect(await active(db)).toEqual([
      { id: 'legacy-dead', active: true }, { id: 'legacy-live', active: true },
      { id: 'legacy-null', active: false }, { id: 'owned', active: true },
    ]);
  });
  it('keeps a claimed turn live through a replaced socket, a stale server lease and a released connection', async () => {
    const owned = async () => (await active(db)).find(row => row.id === 'owned')!.active;
    await db.query(`UPDATE agent_connections SET connection_id='replacement',epoch=2`);
    expect(await owned()).toBe(true);
    await db.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '1 day'`);
    expect(await owned()).toBe(true);
    await db.query(`UPDATE agent_connections SET released_at=clock_timestamp()`);
    expect(await owned()).toBe(true);
    await db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL WHERE id='owned'`);
    expect(await owned()).toBe(false);
  });

  it('rejects a partial owner pair and arbitrary SQL aliases', async () => {
    await expect(db.query(`UPDATE agent_commands SET turn_owner_epoch=NULL WHERE id='owned'`)).rejects.toThrow();
    expect(() => commandOwnerLiveSql('command; SELECT 1')).toThrow('alias');
  });
  it('records each generation once, never as an owner, and cleans it only with its command', async () => {
    await db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL WHERE id='owned'`);
    // The same generation continues from another connection; its record is history only.
    await db.query(`UPDATE agent_commands SET state='claimed',generation_id='generation',
      turn_owner_connection_id='replacement',turn_owner_epoch=2 WHERE id='owned'`);
    expect((await db.query(`SELECT * FROM agent_command_generation_owners WHERE command_id='owned'`)).rowCount).toBe(1);
    await expect(db.query(`UPDATE agent_command_generation_owners SET connection_id='replacement' WHERE command_id='owned'`)).rejects.toThrow('immutable');
    await expect(db.query(`DELETE FROM agent_command_generation_owners WHERE command_id='owned'`)).rejects.toThrow('immutable');
    await db.query(`DELETE FROM agent_commands WHERE id='owned'`);
    expect((await db.query(`SELECT * FROM agent_command_generation_owners WHERE command_id='owned'`)).rowCount).toBe(0);
  });
  it('keeps a claimed turn visible after its connection drops and ends it only on requeue', async () => {
    await db.query(`UPDATE agent_commands SET room_id='room',turn_request_id='request' WHERE id='owned';
      INSERT INTO agent_turns VALUES('room','request','agent','generation',now()-interval '10 minutes');`);
    const fresh = async () => (await db.query<{ fresh: boolean }>(`SELECT ${workingTurnFreshSql('turn')} fresh FROM agent_turns turn`)).rows[0]!.fresh;
    expect(await fresh()).toBe(true);
    await db.query(`UPDATE agent_connections SET released_at=clock_timestamp();UPDATE agent_turns SET created_at=now()`);
    expect(await fresh()).toBe(true);
    await db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL WHERE id='owned'`);
    expect(await fresh()).toBe(false);
  });
});

describe('older claim writers during serving and rollback overlap', () => {
  let f: Awaited<ReturnType<typeof ownedModelFixture>>;
  beforeEach(async () => { f = await ownedModelFixture(); });
  afterEach(async () => { await f.db.close(); });
  // The claim write of images below this release: no execution_kind, and a
  // requeue that leaves the previous kind in place.
  const olderClaim = (id: string, generation: string, connection: string | null) => f.db.query(
    `UPDATE agent_commands SET state='claimed',generation_id=$2,lease_expires_at=NULL,claimed_at=now(),
       turn_owner_connection_id=$3::text,turn_owner_epoch=CASE WHEN $3::text IS NULL THEN NULL ELSE 1 END WHERE id=$1`,
    [id, generation, connection]);
  const olderRequeue = (id: string) => f.db.query(
    `UPDATE agent_commands SET state='pending',generation_id=NULL,lease_expires_at=NULL,claimed_at=NULL,
       turn_owner_connection_id=NULL,turn_owner_epoch=NULL WHERE id=$1`, [id]);
  const order = async (id: string) => f.db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,
      root_command_id,root_source_message_id,agent_depth,state,private_payload)
    VALUES($1,$2,$3,$1,'input','order',$1,$1,0,'pending',$4::jsonb)`,
    [id, MODEL_ROOM, MODEL_AGENT, JSON.stringify({ kind: 'order', text: 'Do this', authorId: MODEL_AGENT, fromRoomId: MODEL_ROOM })]);
  const offered = async () => (await readAgentCommands(f.db, MODEL_ROOM, MODEL_AGENT)).commands.map(command => command.id);

  it('keeps an older connected-app claim out of helper reads and helper replay', async () => {
    // Its row last ran as a helper turn, so a stale kind would also say helper.
    await olderRequeue(MODEL_CLAIM.commandId);
    await olderClaim(MODEL_CLAIM.commandId, 'mcp:overlap', null);
    expect((await f.db.query('SELECT execution_kind FROM agent_commands WHERE id=$1', [MODEL_CLAIM.commandId])).rows)
      .toEqual([{ execution_kind: 'mcp' }]);
    expect(await offered()).toEqual([]);
    await expect(f.db.transaction(tx => claimAgentCommand(tx, MODEL_ROOM, MODEL_AGENT, MODEL_CLAIM.commandId,
      'mcp:overlap', { kind: 'helper', owner: MODEL_SOURCE }))).rejects.toThrow('command claim conflict');
    await expect(claimAgentCommand(f.db, MODEL_ROOM, MODEL_AGENT, MODEL_CLAIM.commandId, 'mcp:overlap'))
      .rejects.toThrow('command claim conflict');
  });

  it('lets connected-app reuse keep the older writer generation', async () => {
    await order('older-order');
    await olderClaim('older-order', 'mcp:overlap', null);
    const reused = await f.db.transaction(tx => claimMcpOrder(tx, MODEL_AGENT, MODEL_ROOM, 'mcp:new', 'older-order'));
    expect({ generation: reused?.generation_id, kind: reused?.execution_kind }).toEqual({ generation: 'mcp:overlap', kind: 'mcp' });
  });

  it('keeps older helper and legacy-adapter claims recoverable by their helper', async () => {
    await olderRequeue(MODEL_CLAIM.commandId);
    await olderClaim(MODEL_CLAIM.commandId, 'older-helper-generation', MODEL_SOURCE.connectionId);
    await order('legacy-adapter');
    await olderClaim('legacy-adapter', 'legacy-generation', null);
    expect((await f.db.query(`SELECT id,execution_kind FROM agent_commands WHERE id=ANY($1) ORDER BY id`,
      [[MODEL_CLAIM.commandId, 'legacy-adapter']])).rows)
      .toEqual([{ id: 'legacy-adapter', execution_kind: null }, { id: MODEL_CLAIM.commandId, execution_kind: 'helper' }]);
    expect((await offered()).sort()).toEqual(['legacy-adapter', MODEL_CLAIM.commandId]);
    const resumed = await f.db.transaction(tx => claimAgentCommand(tx, MODEL_ROOM, MODEL_AGENT, MODEL_CLAIM.commandId,
      'older-helper-generation', { kind: 'helper', owner: MODEL_SOURCE }));
    expect(resumed.generation_id).toBe('older-helper-generation');
  });

  it.each(['3f2b8c1e-6d4a-4b9e-9a7c-2e5f1d8b0c34', 'mcp:legacy-generation'])(
    'stores a current legacy claim as legacy and replays generation %s', async generation => {
      await order('legacy-current');
      const first = await claimAgentCommand(f.db, MODEL_ROOM, MODEL_AGENT, 'legacy-current', generation);
      expect(first.execution_kind).toBe('legacy');
      const replay = await claimAgentCommand(f.db, MODEL_ROOM, MODEL_AGENT, 'legacy-current', generation);
      expect({ id: replay.id, generation: replay.generation_id, kind: replay.execution_kind })
        .toEqual({ id: 'legacy-current', generation, kind: 'legacy' });
    });
});
