import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { AcpClient } from '../../body/src/acp.js';
import { startAgentProcess, stopAgentProcess } from '../../body/src/agent-process.js';
import { CommandExecutionContext, runServerCommandIntake } from '../../body/src/server-command-intake.js';
import type { DaemonApiClient } from '../../body/src/daemon-api-client.js';
import type { AgentCommand, DaemonOperationMap } from '@beeline/api-contract/daemon';
import { createAgentCommand } from './agent-command.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { HelperDaemonService } from './test-fixtures/helper-daemon.js';
import { insertCornerFacts, migratedDatabase, type PgliteDatabase } from './test-support.js';

const HUMAN = 'a'.repeat(64), WORKER = 'b'.repeat(64), COMMANDER = 'c'.repeat(64);
let db: PgliteDatabase;
beforeAll(async () => { db = await migratedDatabase(); }, 30_000);
afterAll(() => db.close());

// The harness keeps its process alive and leaves an unfinished status entry,
// but authoritatively ends (or rejects) the prompt when the test requests it.
const harness = `
const readline = require('node:readline');
let prompt;
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  const answer = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
  if (request.method === 'initialize') answer(request.id,{protocolVersion:1,agentCapabilities:{}});
  if (request.method === 'session/new') answer(request.id,{sessionId:'fixture'});
  if (request.method === 'session/prompt') {
    prompt = request.id;
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture',
      update:{sessionUpdate:'tool_call',toolCallId:'stale-status',title:'Build',status:'in_progress'}}})+'\\n');
    process.stderr.write('prompt-ready');
  }
  if (request.method === 'fixture/end') {
    if (request.params.reject) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:prompt,
      error:{code:-32001,message:'fixture prompt rejected'}})+'\\n');
    else answer(prompt,{stopReason:'end_turn'});
    answer(request.id,{});
  }
});`;

it.each([false, true])('claims queued order, human tag and resume after a blocked report and harness termination (rejected=%s)', async rejected => {
  const workspace = randomUUID(), room = randomUUID(), corner = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'beeline-ended-harness-'));
  const daemon = new HelperDaemonService(db, new LiveHub());
  const phone = new PhoneService(db, 'http://test');
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Worker','worker'),($3,'agent','Commander','commander')
    ON CONFLICT(id) DO NOTHING`, [HUMAN, WORKER, COMMANDER]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3) ON CONFLICT DO NOTHING', [WORKER, COMMANDER, HUMAN]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Ended harness proof')", [workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')", [room, workspace]);
  for (const identity of [HUMAN, WORKER, COMMANDER]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [workspace, identity, room]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Corner',$4)`, [corner, workspace, room, COMMANDER]);
  await insertCornerFacts(db, {cornerId:corner, ownerAgentId:WORKER, commissionedBy:HUMAN});
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Initial work')`, [corner, corner, HUMAN]);
  const initial = (await createAgentCommand(db, {roomId:corner, agentId:WORKER, sourceMessageId:corner, reason:'corner_brief_revision'}))!;
  const controller = new AbortController(), context = new CommandExecutionContext(root);
  const client = new AcpClient({agentCommand:process.execPath, agentArgs:['-e',harness],
    agentEnv:{HOME:root,XDG_CONFIG_HOME:root,XDG_STATE_HOME:root}, inheritProcessEnv:false, resourceScope:'none'});
  let notify: ((commands: readonly AgentCommand[]) => void) | undefined;
  const claimed: AgentCommand[][] = [], errors: unknown[] = [];
  let invocation = 0, releases = 0;
  const api = {
    execute: async <Name extends keyof DaemonOperationMap>(name: Name, input: DaemonOperationMap[Name]['input']) => {
      const result = await daemon.execute(name, input, WORKER);
      if (name === 'claimAgentTurn') claimed.push((result as DaemonOperationMap['claimAgentTurn']['output']).commands);
      if (name === 'releaseAgentTurn') releases++;
      return result;
    },
    liveSubscribe: (_room: unknown, _cursor: unknown, _items: unknown, _state: unknown, _presence: unknown,
      onCommands: typeof notify) => { notify = onCommands; return () => {}; },
  } as unknown as DaemonApiClient;
  let intake: Promise<void> | undefined;
  try {
    await startAgentProcess(client);
    await client.sessionNew({cwd:root});
    const ready = once(client, 'stderr');
    intake = runServerCommandIntake({api,roomId:corner,agentId:WORKER,context,signal:controller.signal,
      stop:() => {}, onError:error => errors.push(error), run:async command => {
        if (++invocation === 1) {
          await client.sessionPrompt('fixture', 'Work until blocked');
          // The report leaves the command open until the turn ends, so the
          // same turn may still publish.
          await daemon.execute('postAgentActivity', {roomId:corner,agentId:WORKER,requestId:command.turnRequestId,
            generationId:context.generationId,activity:[{kind:'output',title:'Update',text:'Late activity'}]}, WORKER);
        }
      }});
    await ready;
    // Match the incident: an order arrives before the implementer reports blocked.
    const order = (await createAgentCommand(db, {roomId:corner,agentId:WORKER,sourceMessageId:null,reason:'order',
      privatePayload:{kind:'order',authorId:COMMANDER,fromRoomId:room,text:'Continue the proof'}}))!;
    await daemon.execute('report', {roomId:corner,requestId:initial.turn_request_id,generationId:context.generationId,
      status:'blocked',text:'blocked: The owner must finish sign-in.'}, WORKER);
    expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[initial.id])).rows).toEqual([{state:'claimed'}]);
    await phone.execute('sendRoomMessage',{roomId:corner,text:'@worker Help me click the checkbox'},HUMAN);
    const source = randomUUID();
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Resume after sign-in')`,[source,corner,HUMAN]);
    const resume = (await createAgentCommand(db,{roomId:corner,agentId:WORKER,sourceMessageId:source,
      reason:'resume',action:'resume',parent:initial,retainDepth:true}))!;
    const pending = (await daemon.execute('getAgentCommands',{roomId:corner},WORKER)).commands;
    expect(pending.map(command => command.reason).sort()).toEqual(['human_tag','order','resume']);
    notify!(pending);
    await client.request('fixture/end',{reject:rejected});
    await vi.waitFor(() => expect(claimed).toHaveLength(2));
    expect(claimed[1]!.map(command => command.id).sort()).toEqual(pending.map(command => command.id).sort());
    expect(claimed[1]!.some(command => command.id === order.id)).toBe(true);
    expect(claimed[1]!.some(command => command.id === resume.id)).toBe(true);
    await vi.waitFor(() => expect(releases).toBe(2));
    expect(errors.map(String)).toEqual(rejected ? [expect.stringContaining('fixture prompt rejected')] : []);
    expect((await daemon.execute('getAgentCommands',{roomId:corner},WORKER)).commands).toEqual([]);
    expect((await phone.readRoom(corner,HUMAN))!.pendingAgentCommands).toEqual([]);
    expect((await db.query("SELECT 1 FROM agent_turns WHERE room_id=$1 AND status='working'",[corner])).rows).toEqual([]);
    expect(client.isAlive).toBe(true);
  } finally {
    controller.abort();
    await stopAgentProcess(client);
    await intake;
    await rm(root,{recursive:true,force:true});
  }
});
