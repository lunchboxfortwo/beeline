import { startQueuedTurn } from './test-fixtures/queued-turn.test-support.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentCommand } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { migrate } from './database.js';
import { LiveHub } from './live.js';
import { PgliteDatabase } from './test-support.js';

const HUMAN = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111118';
const ROOM = '22222222-2222-4222-8222-222222222228';
const REQUEST = 'c'.repeat(64);

describe('agent reply completion latency', () => {
  let database: PgliteDatabase;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Human','human'),($2,'agent','Agent','agent')`,
      [HUMAN, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Latency')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
       ($1,$4,$2,'owner'),($1,$4,$3,'member')`,
      [WORKSPACE, HUMAN, AGENT, ROOM],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@agent answer')`,
      [REQUEST, ROOM, HUMAN],
    );
    const command = await createAgentCommand(database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: REQUEST,
      reason: 'human_tag',
    });
    await startQueuedTurn(database, ROOM, AGENT, command!.id);
  });

  afterEach(async () => { vi.restoreAllMocks(); await database.close(); });
  it('stamps the turn’s real work on its own row', async () => {
    const request = `measure-${randomUUID()}`;
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@agent measure')`,
      [request, ROOM, HUMAN],
    );
    const command = await createAgentCommand(database, {
      id: request,
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: request,
      reason: 'human_tag',
    });
    await startQueuedTurn(database, ROOM, AGENT, command!.id);
    await database.query(
      `INSERT INTO institutional_context_serves
       (id,workspace_id,room_id,agent_id,request_id,requester_identity_id,mode,served,total_bytes,
        estimated_tokens)
       VALUES($1,$2,$3,$4,$5,$6,'live',true,4000,1000)`,
      [randomUUID(), WORKSPACE, ROOM, AGENT, request, HUMAN],
    );
    const daemon = new DaemonService(database, new LiveHub());
    await daemon.execute('postRoomMessage',{roomId:ROOM,requestId:request,text:'Measured answer.'},AGENT);
    await database.backgroundWork.drain();
    await daemon.execute(
      'postAgentTurnReceipt',
      { agentId: AGENT, roomId: ROOM, requestId: request, status: 'complete', inputTokens: 30_000, totalInputTokens: 45_000, outputTokens: 800, promptBytes: 60_000, toolCalls: 7 },
      AGENT,
    );
    // The receipt's real cost and work live on the turn itself.
    expect(
      (
        await database.query(
          `SELECT tool_calls,input_tokens,output_tokens FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
          [ROOM, request],
        )
      ).rows[0],
    ).toEqual({ tool_calls: 7, input_tokens: 45_000, output_tokens: 800 });
  }, 10_000);
});
