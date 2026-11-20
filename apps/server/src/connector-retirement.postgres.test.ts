import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, PostgresDatabase } from './database.js';
import { createAgentCommand, createMcpAgentCommand } from './agent-command.js';
import { beginAgentInvocation } from './agent-invocation.js';
import { markConnectorsOffline, noteConnectorPresence } from './rooms-mcp-delivery.js';
import { retireStuckConnectorCommands } from './migrations/stuck-connector-commands.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Connector retirement tests require isolated loopback PostgreSQL');
const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

describe.skipIf(!url)('connector retirement serializes with command claims', () => {
  const name = 'connector_retirement_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url, max: 1 });
  const target = new URL(url ?? 'postgresql://localhost/postgres');
  target.pathname = '/' + name;
  const config = { connectionString: target.toString(), max: 1, options: '-c statement_timeout=8000' };
  const first = new PostgresDatabase('', 1, { pool: new Pool(config) });
  const second = new PostgresDatabase('', 1, { pool: new Pool(config) });
  const owner = 'a'.repeat(64), member = 'b'.repeat(64), workspace = randomUUID(), room = randomUUID();
  let firstPid: number, secondPid: number;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${name}`);
    await migrate(first);
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Connector')`, [owner, member]);
    await first.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [member, owner]);
    await first.query("INSERT INTO workspaces(id,name) VALUES($1,'Retirement')", [workspace]);
    await first.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')", [room, workspace]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`, [workspace, owner, member, room]);
    await first.query(`INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES('claims','Claims','[]')`);
    await first.query(`INSERT INTO rooms_mcp_connections(client_id,identity_id,scope) VALUES('claims',$1,'rooms:read rooms:write')`, [owner]);
    await first.query(`INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label,callback_url)
      VALUES('claims',$1,$2,'Claims','https://hooks.example/claims')`, [owner, member]);
    firstPid = (await first.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    secondPid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
  }, 60_000);
  afterAll(async () => {
    await first.close();
    await second.close();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH(FORCE)`);
    await admin.end();
  });
  const waiting = async (pid: number, blocker: number) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await admin.query<{ blocked: boolean }>('SELECT $2::int=ANY(pg_blocking_pids($1)) blocked', [pid, blocker])).rows[0]?.blocked) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Command writer did not wait for the competing command lock');
  };
  const queued = async () => {
    const command = (await createAgentCommand(first, {
      roomId: room, agentId: member, sourceMessageId: null, reason: 'order',
      privatePayload: { kind: 'order', authorId: owner, fromRoomId: room, text: 'Keep claimed work' },
    }))!;
    await first.query("UPDATE agent_commands SET created_at='2026-11-14T13:48:23Z' WHERE id=$1", [command.id]);
    await markConnectorsOffline(first, [member]);
    return command;
  };

  it.each([['reconnect', 'invocation'], ['historical', 'invocation'], ['reconnect', 'child'], ['historical', 'child']])('%s retirement observes a %s claim committed while waiting', async (mode, kind) => {
    const command = await queued(), claimed = barrier(), commit = barrier();
    const claim = second.transaction(async tx => {
      if (kind === 'invocation') await beginAgentInvocation(tx, member, room, command.turn_request_id, randomUUID());
      else await createMcpAgentCommand(tx, { roomId: room, agentId: member, parent: command });
      claimed.release();
      await commit.promise;
    });
    let retirement: Promise<unknown> | undefined;
    try {
      await claimed.promise;
      retirement = mode === 'reconnect' ? noteConnectorPresence(first, member) : retireStuckConnectorCommands(first);
      await waiting(firstPid, secondPid);
    } finally {
      commit.release();
      await claim;
      await retirement;
    }
    expect((await first.query('SELECT state FROM agent_commands WHERE id=$1', [command.id])).rows[0]?.state).toBe('pending');
  });

  it('refuses a claim registered after retirement acquired the command', async () => {
    const command = await queued(), retired = barrier(), commit = barrier();
    const retirement = first.transaction(async tx => {
      await noteConnectorPresence(tx, member);
      retired.release();
      await commit.promise;
    });
    let claim: Promise<unknown> | undefined;
    try {
      await retired.promise;
      claim = beginAgentInvocation(second, member, room, command.turn_request_id, randomUUID())
        .then(() => null, error => error);
      await waiting(secondPid, firstPid);
    } finally {
      commit.release();
      await retirement;
    }
    expect(await claim).toMatchObject({ message: 'invocation requires a pending command' });
    expect((await first.query('SELECT state FROM agent_commands WHERE id=$1', [command.id])).rows[0]?.state).toBe('cancelled');
  });
});
