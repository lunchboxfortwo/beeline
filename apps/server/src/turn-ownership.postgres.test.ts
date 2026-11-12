import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { authorizeCommandOutput } from './agent-command.js';
import { PostgresDatabase } from './database.js';
import { TURN_OWNERSHIP_SCHEMA, commandOwnerLiveSql } from './turn-ownership.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Turn ownership proofs require isolated loopback PostgreSQL');
const room = '11111111-1111-4111-8111-111111111111';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe.skipIf(!url)('real PostgreSQL execution ownership contention', () => {
  it('never waits on the connection row: a reconnect and a stale lease leave an admitted writer to commit', async () => {
    const schema = 'turn_owner_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: url, max: 1 }); await admin.query(`CREATE SCHEMA ${schema}`);
    const config = { connectionString: url, options: `-c search_path=${schema},public -c lock_timeout=2000`, max: 2 };
    const left = new PostgresDatabase('', 2, { pool: new Pool(config) });
    const right = new PostgresDatabase('', 2, { pool: new Pool(config) });
    const entered = deferred<void>(), releaseWriter = deferred<void>();
    let writer: Promise<unknown> | undefined, writerError: unknown;
    try {
      await left.query(`CREATE TABLE agent_commands(id text PRIMARY KEY,room_id uuid,agent_id text,turn_request_id text,
          action text,state text,generation_id text,lease_expires_at timestamptz,created_at timestamptz DEFAULT now());
        CREATE TABLE agent_turns(room_id uuid,request_id text,agent_id text,status text,generation_id text,created_at timestamptz DEFAULT now());
        CREATE TABLE agent_connections(agent_id text PRIMARY KEY,connection_id text,epoch bigint,instance_id text,released_at timestamptz);
        CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz);
        CREATE TABLE ownership_effects(id text PRIMARY KEY,epoch bigint);`);
      await left.query(`CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
        CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,removed_at timestamptz);
        INSERT INTO rooms(id,workspace_id) VALUES('${room}','22222222-2222-4222-8222-222222222222');
        INSERT INTO memberships VALUES('22222222-2222-4222-8222-222222222222',NULL,'agent',NULL),
          ('22222222-2222-4222-8222-222222222222','${room}','agent',NULL);`);
      await left.query(TURN_OWNERSHIP_SCHEMA);
      await left.query(`INSERT INTO live_server_instances VALUES('old-server',clock_timestamp()),('new-server',clock_timestamp());
        INSERT INTO agent_connections VALUES('agent','old-connection',1,'old-server',NULL);`);
      await left.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,state,generation_id,
          turn_owner_connection_id,turn_owner_epoch) VALUES('command',$1,'agent','request','input','claimed','generation','old-connection',1)`, [room]);
      await left.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id) VALUES($1,'request','agent','working','generation')`, [room]);

      writer = left.transaction(async db => {
        await authorizeCommandOutput(db, room, 'agent', 'request', 'generation');
        entered.resolve(); await releaseWriter.promise;
        await db.query(`INSERT INTO ownership_effects VALUES('admitted-effect',1)`);
      });
      void writer.catch(error => { writerError = error; entered.resolve(); });
      await entered.promise;
      if (writerError) throw writerError;
      // The reconnect and the deploy commit while the writer is still open.
      await right.query(`UPDATE agent_connections SET connection_id='new-connection',epoch=2,instance_id='new-server' WHERE agent_id='agent'`);
      await right.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '1 hour' WHERE instance_id='old-server'`);
      releaseWriter.resolve(); await writer;
      expect((await left.query('SELECT * FROM turn_owned_access_checks')).rowCount).toBe(0);
      expect((await left.query(`SELECT id FROM ownership_effects`)).rows).toEqual([{ id: 'admitted-effect' }]);
      await left.transaction(db => authorizeCommandOutput(db, room, 'agent', 'request', 'generation'));
      expect((await left.query<{ live: boolean }>(`SELECT ${commandOwnerLiveSql('command')} live FROM agent_commands command`)).rows[0]!.live).toBe(true);
      await left.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL WHERE id='command'`);
      await expect(left.transaction(db => authorizeCommandOutput(db, room, 'agent', 'request', 'generation')))
        .rejects.toThrow('command output authority rejected');
    } finally {
      releaseWriter.resolve();
      await Promise.allSettled(writer ? [writer] : []);
      await left.close(); await right.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    }
  }, 20_000);
});
