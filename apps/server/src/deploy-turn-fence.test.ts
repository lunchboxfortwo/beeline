import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import type { TokenAuth } from './auth.js';
import { createAgentCommand } from './agent-command.js';
import { ConnectionPresence } from './connection-presence.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';
import { migratedDatabase } from './test-support.js';

const AGENT = 'b'.repeat(64), HUMAN = 'a'.repeat(64), ABSENT = 'c'.repeat(64);
const ROOM = '22222222-2222-4222-8222-222222222222';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';

it.each([false, true])('DEPLOY-TURN: the same helper publishes its A generation after reconnecting to B (preceding server=%s)', async precedingServer => {
  const database = await migratedDatabase();
  const live = new LiveHub(), daemon = new DaemonService(database, live);
  const first = new ConnectionPresence(database, live, { instanceId: 'deploy-A' });
  const second = new ConnectionPresence(database, live, { instanceId: 'deploy-B' });
  const servers: ReturnType<typeof createBeelineServer>[] = [];
  const sockets: WebSocket[] = [];
  const register = async (presence: ConnectionPresence, lifecycleId = 'running-helper') => {
    const server = createBeelineServer({ database, daemon, live, connectionPresence: presence,
      auth: { authenticateDaemon: async () => AGENT, retiredDaemonAgent: async () => null } as unknown as TokenAuth,
      mediaMaximumBytes: 1 });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/phone/live`, ['beeline.machine.1']);
    sockets.push(socket);
    const frames: Record<string, any>[] = [];
    socket.on('message', raw => frames.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'register', agentId: AGENT, token: 'bdt_test', lifecycleId,
      turnOwnershipV1: true, daemonOperationsV1: true }));
    await vi.waitFor(() => expect(frames.find(frame => frame.type === 'registered')).toBeDefined());
    const capabilities = frames.find(frame => frame.type === 'registered')!.capabilities;
    return { server, socket, frames, source: { connectionId: capabilities.turnConnectionId, epoch: capabilities.turnConnectionEpoch } };
  };
  try {
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Bee'),($3,'agent','Absent')`, [HUMAN, AGENT, ABSENT]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [ROOM, WORKSPACE]);
    await database.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [AGENT, HUMAN]);
    await database.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [ABSENT, HUMAN]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member'),($1,NULL,$3,'member'),($1,$2,$4,'member'),($1,NULL,$4,'member')`, [WORKSPACE, ROOM, AGENT, ABSENT]);
    const a = await register(first);
    if (precedingServer) {
      await database.query(`UPDATE agent_connections SET
        turn_connection_id=NULL,turn_connection_epoch=NULL,turn_transport_id=NULL WHERE agent_id=$1`, [AGENT]);
      await database.query(`UPDATE live_outputs SET body=body-'connectionLifecycleId' WHERE agent_id=$1 AND kind='presence'`, [AGENT]);
    }
    const command = (await createAgentCommand(database, { roomId: ROOM, agentId: AGENT, sourceMessageId: null, reason: 'system' }))!;
    await daemon.execute('claimAgentCommand', { roomId: ROOM, commandId: command.id, generationId: 'running-generation' }, AGENT, a.source);
    const absentSource = { connectionId: 'never-back', epoch: await first.claimConnection(ABSENT, { connectionId: 'never-back' }) };
    const absentCommand = (await createAgentCommand(database, { roomId: ROOM, agentId: ABSENT, sourceMessageId: null, reason: 'system' }))!;
    await daemon.execute('claimAgentCommand', { roomId: ROOM, commandId: absentCommand.id, generationId: 'absent-generation' }, ABSENT, absentSource);
    // Server shutdown holds its connections for a successor instead of releasing the turn.
    await new Promise<void>(resolve => a.server.close(() => resolve()));
    servers.splice(servers.indexOf(a.server), 1);
    await first.stop();
    await database.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '161 seconds' WHERE instance_id='deploy-A'`);
    const post = { roomId: ROOM, cornerId: ROOM, requestId: command.turn_request_id,
      generationId: 'running-generation', text: 'Output survived the deploy' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(daemon.execute('postCornerMessage', post, AGENT)).rejects.toThrow('server instance lease stale: age=');
    const b = await register(second);
    expect(b.source).toEqual(a.source);
    expect((await database.query('SELECT state,generation_id FROM agent_commands WHERE id=$1', [command.id])).rows)
      .toEqual([{ state: 'claimed', generation_id: 'running-generation' }]);
    expect((await database.query('SELECT instance_id FROM agent_connections WHERE agent_id=$1', [AGENT])).rows)
      .toEqual([{ instance_id: 'deploy-B' }]);
    await expect(daemon.execute('postCornerMessage', { ...post, requestId: absentCommand.turn_request_id,
      generationId: 'absent-generation' }, ABSENT)).rejects.toThrow('server instance lease stale: age=');
    b.socket.send(JSON.stringify({ type: 'daemon-operation', agentId: AGENT, requestId: 'deploy-output', operation: 'postCornerMessage', input: post }));
    await vi.waitFor(() => expect(b.frames.find(frame => frame.requestId === 'deploy-output')).toBeDefined(), { timeout: 3_000 });
    expect(b.frames.find(frame => frame.requestId === 'deploy-output')).not.toHaveProperty('error');
    expect((await database.query('SELECT text FROM messages WHERE room_id=$1 AND author_id=$2', [ROOM, AGENT])).rows)
      .toEqual([{ text: post.text }]);
  } finally {
    for (const socket of sockets) socket.terminate();
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    await first.stop(); await second.stop(); vi.restoreAllMocks(); await database.close();
  }
}, 30_000);
