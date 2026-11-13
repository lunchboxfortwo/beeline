import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { claimAgentConnection } from './connection-presence.js';
import { CommandExecutionContext, runServerCommandIntake } from '../../body/src/server-command-intake.js';
import type { DaemonApiClient } from '../../body/src/daemon-api-client.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import type { HelperTurnOwnershipSource } from '@beeline/api-contract/helper-turn-ownership';

const H='a'.repeat(64), A='b'.repeat(64), W=randomUUID(), R=randomUUID();
let db:PgliteDatabase, daemon:DaemonService, phone:PhoneService, owner:HelperTurnOwnershipSource;
beforeAll(async()=>{
  db=await migratedDatabase();const live=new LiveHub();daemon=new DaemonService(db,live);phone=new PhoneService(db,'http://test');
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Worker','worker')`,[H,A]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[A,H]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Batch proof')",[W]);
  await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')",[R,W]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,[W,H,A,R]);
  await db.query("INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('batch-test',clock_timestamp())");
  owner={connectionId:'batch-helper',epoch:await claimAgentConnection(db,live,A,{}, {connectionId:'batch-helper',instanceId:'batch-test'})};
},30_000);
afterAll(()=>db.close());

it('three messages during a running turn use one current-state follow-up without replaying unanswered wakes',async()=>{
  const scratch=await mkdtemp(join(tmpdir(),'beeline-batch-'));
  const abort=new AbortController(), context=new CommandExecutionContext(scratch), errors:unknown[]=[], invocations:AgentCommand[][]=[];
  let push:((commands:readonly AgentCommand[])=>void)|undefined;
  let finishFirst!:()=>void,finishFollowup!:()=>void;
  const first=new Promise<void>(resolve=>{finishFirst=resolve;});
  const followup=new Promise<void>(resolve=>{finishFollowup=resolve;});
  const claims:{ids:string[];generation:string}[]=[];
  const releases:string[][]=[];
  const api={
    turnOwnershipScope:()=>owner,
    execute:async(name:string,input:Record<string,unknown>)=>{
      const result=await daemon.execute(name as never,input as never,A,
        ['claimAgentCommand','claimAgentTurn','releaseAgentTurn','postAgentTurnReceipt'].includes(name)?owner:undefined);
      if(name==='releaseAgentTurn')releases.push((result as {commands:AgentCommand[]}).commands.map(command=>command.id));
      if(name==='claimAgentTurn')claims.push({ids:(result as {commands:AgentCommand[]}).commands.map(command=>command.id),generation:String(input.generationId)});
      return result;
    },
    liveSubscribe:(_room:unknown,_cursor:unknown,_items:unknown,_state:unknown,_presence:unknown,onCommands:typeof push)=>{push=onCommands;return()=>{};},
  } as unknown as DaemonApiClient;
  const send=(text:string)=>phone.execute('sendRoomMessage',{roomId:R,text:`@worker ${text}`},H);
  const answer=(command:AgentCommand)=>daemon.execute('postRoomMessage',{
    roomId:R,requestId:command.turnRequestId,generationId:context.generationId,text:`Answered ${command.source.body}`,
  },A);
  await send('Initial task');
  const running=runServerCommandIntake({api,roomId:R,agentId:A,context,signal:abort.signal,
    stop:()=>{},onError:error=>errors.push(error),run:async command=>{
      const group=[...context.commands];invocations.push(group);
      if(invocations.length===1){await first;await answer(group[0]!);}
      else if(invocations.length===2){
        expect(command.source.body).toContain('current state');
        expect(command.source.body).toContain('Third question');
        expect(command.source.body).not.toContain('First question');
        await followup;
        await answer(group[0]!);
        const active=(await phone.readRoom(R,H))!.latestAgentTurns.find(turn=>turn.agentPubkey===A)!;
        expect(active.status).toBe('working');expect(active.requestId).not.toBe(group[0]!.turnRequestId);
        const delta=await phone.readLiveDelta(R,H,{type:'turn',agentId:A,requestId:active.requestId});
        expect(delta).toMatchObject({type:'turn-delta',turn:{status:'working'}});
        await answer(group[1]!);
        await daemon.execute('postAgentTurnReceipt',{roomId:R,requestId:group[2]!.turnRequestId,
          generationId:context.generationId,status:'complete',diagnosticsOnly:true,toolCalls:2},A,owner);
        expect((await db.query('SELECT status,tool_calls FROM agent_turns WHERE room_id=$1 AND request_id=$2',
          [R,group[2]!.turnRequestId])).rows).toEqual([{status:'working',tool_calls:2}]);
        expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[group[2]!.id])).rows).toEqual([{state:'claimed'}]);
      }
    }});
  try{
    await vi.waitFor(()=>expect(invocations).toHaveLength(1));
    for(const text of ['First question','Second question','Third question'])await send(text);
    push?.((await daemon.execute('getAgentCommands',{roomId:R},A)).commands);
    expect(invocations).toHaveLength(1);
    expect((await db.query("SELECT count(*)::int n FROM agent_commands WHERE state='pending' AND room_id=$1",[R])).rows).toEqual([{n:3}]);
    finishFirst();
    await vi.waitFor(()=>expect(invocations).toHaveLength(2));
    expect(invocations[1]!.map(command=>command.source.body)).toEqual(['@worker First question','@worker Second question','@worker Third question']);
    expect(claims[1]!.ids).toEqual(invocations[1]!.map(command=>command.id));
    // The follow-up ends on its own; intake shuts down only after its release.
    finishFollowup();
    await vi.waitFor(()=>expect(releases).toHaveLength(2));
    abort.abort();await running;
    expect(releases[1]).toEqual([]);
    expect(invocations).toHaveLength(2);
    expect((await db.query('SELECT state FROM agent_commands WHERE id=ANY($1::text[])',[invocations[1]!.map(command=>command.id)])).rows)
      .toEqual([{state:'complete'},{state:'complete'},{state:'complete'}]);
    expect((await daemon.execute('getAgentCommands',{roomId:R},A)).commands).toEqual([]);
    expect(errors).toEqual([]);
    expect((await db.query("SELECT id FROM messages WHERE room_id=$1 AND card_type='turn-failed'",[R])).rows).toEqual([]);
  }finally{abort.abort();finishFirst();finishFollowup();await running;await rm(scratch,{recursive:true,force:true});}
});

it('releasing an invocation consumes it once; repeated release never requeues it',async()=>{
  for(const text of ['Another question','Last question'])await phone.execute('sendRoomMessage',{roomId:R,text:`@worker ${text}`},H);
  const pending=(await daemon.execute('getAgentCommands',{roomId:R},A)).commands;
  const result=await daemon.execute('claimAgentTurn',{roomId:R,commandId:pending[0]!.id,generationId:'batch-stale'},A,owner);
  expect(result.commands).toHaveLength(2);
  for(let replay=0;replay<2;replay++){
    const released=await daemon.execute('releaseAgentTurn',{roomId:R,generationId:'batch-stale'},A,owner);
    expect(released.commands).toEqual([]);
  }
  expect((await phone.readRoom(R,H))?.latestAgentTurns?.some(turn=>turn.status==='working')).toBe(false);
  expect((await db.query("SELECT state FROM agent_commands WHERE id=ANY($1::text[])",[pending.map(command=>command.id)])).rows)
    .toEqual([{state:'complete'},{state:'complete'}]);
  await expect(daemon.execute('claimAgentTurn',{roomId:R,commandId:pending[0]!.id,generationId:'batch-next'},A,owner))
    .rejects.toThrow('command claim conflict');
});

it.each([0,2,4])('R1 Stop on batch member %s clears the whole invocation despite differing transport history and preserves other invocations', async target => {
  const send = async (text: string) => {
    await phone.execute('sendRoomMessage', {roomId:R,text:`@worker ${text}`}, H);
    return (await db.query<{id:string}>(`SELECT id FROM agent_commands WHERE room_id=$1 AND state='pending'
      AND action='input' ORDER BY created_at DESC,id DESC LIMIT 1`,[R])).rows[0]!.id;
  };
  const ids = [];
  for (let i=0;i<5;i++) ids.push(await send(`R1 request ${i}`));
  const batch = await daemon.execute('claimAgentTurn',
    {roomId:R,commandId:ids[0]!,generationId:'r1-stop'},A,owner);
  expect(batch.commands).toHaveLength(5);
  const claim = async (generation: string, connection: string, epoch: number) => {
    const id = await send('another delivery');
    await db.query(`UPDATE agent_commands SET state='claimed',generation_id=$2,
      turn_owner_connection_id=$3,turn_owner_epoch=$4 WHERE id=$1`,[id,generation,connection,epoch]);
    return id;
  };
  // Same generation through another recorded socket is still this invocation.
  const members = [...ids, await claim('r1-stop','different-connection',owner.epoch),
    await claim('r1-stop',owner.connectionId,owner.epoch+1)];
  const preserved = [await claim('successor',owner.connectionId,owner.epoch), await send('unclaimed follow-up')];
  await phone.execute('cancelAgentTurn',
    {roomId:R,agentId:A,requestId:batch.commands[target]!.turnRequestId},H);
  expect((await db.query(`SELECT state FROM agent_commands WHERE id=ANY($1::text[])`,[members])).rows)
    .toEqual(members.map(()=>({state:'cancelled'})));
  expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=ANY($2::text[])`,
    [R,batch.commands.map(c=>c.turnRequestId)])).rows)
    .toEqual(Array.from({length:5},()=>({status:'cancelled'})));
  expect((await phone.readRoom(R,H))!.latestAgentTurns
    .some(turn=>turn.status==='working' && batch.commands.some(c=>c.turnRequestId===turn.requestId))).toBe(false);
  expect((await db.query(`SELECT id,state FROM agent_commands WHERE id=ANY($1::text[]) ORDER BY id`,[preserved])).rows)
    .toEqual(preserved.map((id,index)=>({id,state:index===1?'pending':'claimed'})).sort((a,b)=>a.id.localeCompare(b.id)));
  // Test cleanup uses the normal terminal path.
  await db.query(`SELECT beeline_end_agent_turn(id,generation_id,'cancelled','test cleanup')
    FROM agent_commands WHERE id=ANY($1::text[])`,[preserved]);
});

async function runRunnerTurn(reason?: string, orders:readonly {authorId:string;fromRoomId:string}[]=[{authorId:H,fromRoomId:R}]) {
  const {createAgentCommand}=await import('./agent-command.js');
  const scratch=await mkdtemp(join(tmpdir(),'beeline-failed-wake-'));
  const abort=new AbortController(), context=new CommandExecutionContext(scratch);
  const commands=[];
  for(const route of orders) commands.push((await createAgentCommand(db,{roomId:R,agentId:A,sourceMessageId:null,reason:'order',
    privatePayload:{kind:'order',...route,text:'Run the review'}}))!);
  const command=commands[0]!;
  const api={turnOwnershipScope:()=>owner,execute:async(name:string,input:Record<string,unknown>)=>{
    const result=await daemon.execute(name as never,input as never,A,
      ['claimAgentTurn','releaseAgentTurn','postAgentTurnReceipt'].includes(name)?owner:undefined);
    if(name==='releaseAgentTurn')abort.abort();
    return result;
  }} as unknown as DaemonApiClient;
  try {
    await runServerCommandIntake({api,roomId:R,agentId:A,context,signal:abort.signal,
      stop:()=>{},run:async()=>{if(reason)throw new Error(reason);}});
    return {room:(await phone.readRoom(R,H))!,command,commands};
  } finally {abort.abort();await rm(scratch,{recursive:true,force:true});}
}

it.each(['review checkout has uncommitted work', 'agent process exited before output'])(
  'Reproduction F1: runner failure stays failed after release without a chat notice (%s)', async reason => {
    await runRunnerTurn();
    const {room,command}=await runRunnerTurn(reason);
    expect(room.latestAgentTurns).toContainEqual(expect.objectContaining({
      requestId:command.turn_request_id,status:'failed',
    }));
    expect(room.messages.some(message=>message.text.startsWith('failed:') && message.text.includes(reason)
      && message.text.includes('@worker') && message.text.includes(R))).toBe(false);
    expect(room.messages.some(message=>message.systemEvent?.verb==='could not finish this request' && message.text.includes(reason))).toBe(false);
  });

it('Reproduction F1: repeated failures stay silent across a successful quiet turn',async()=>{
  const reports=(room:Awaited<ReturnType<typeof runRunnerTurn>>['room'])=>
    room.messages.filter(message=>message.text.startsWith('failed:')).length;
  const baseline=reports((await runRunnerTurn()).room);
  for(let attempt=1;attempt<=4;attempt++){
    const {room}=await runRunnerTurn('checkout preparation failed');
    expect(reports(room)).toBe(baseline);
  }
  const success=await runRunnerTurn();
  expect(success.room.latestAgentTurns).toContainEqual(expect.objectContaining({
    requestId:success.command.turn_request_id,status:'complete',
  }));
  expect(reports((await runRunnerTurn('another early crash')).room)).toBe(baseline);
});

it.each(['distinct issuers and places','same issuer','same place'])(
  'Reproduction F1: batched failures complete each request without posting to human return routes (%s)',async kind=>{
    await runRunnerTurn();
    const other='c'.repeat(64), firstPlace=randomUUID(), secondPlace=kind==='same place'?firstPlace:randomUUID();
    await db.query("INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Other owner','otherowner') ON CONFLICT DO NOTHING",[other]);
    for(const place of new Set([firstPlace,secondPlace])) {
      await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Return place')",[place,W]);
      for(const member of [H,other,A]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$2,'member'),($1,$3,$2,'member') ON CONFLICT DO NOTHING`,[W,member,place]);
    }
    const orders=[{authorId:H,fromRoomId:firstPlace},
      {authorId:kind==='same issuer'?H:other,fromRoomId:secondPlace}];
    orders.push({...orders[0]!});
    const reportCount=async()=>{
      let count=0;
      for(const place of new Set([firstPlace,secondPlace])) {
        const room=(await phone.readRoom(place,H))!;
        const reports=room.messages.filter(message=>message.text.startsWith('failed:'));
        expect(reports.every(message=>message.text.includes('@worker') && message.text.includes(R)
          && message.text.includes('checkout preparation failed'))).toBe(true);
        count+=reports.length;
      }
      return count;
    };
    for(let attempt=1;attempt<=4;attempt++) {
      const {commands}=await runRunnerTurn('checkout preparation failed',orders);
      expect(await reportCount()).toBe(0);
      expect((await db.query('SELECT state FROM agent_commands WHERE id=ANY($1::text[])',[commands.map(command=>command.id)])).rows)
        .toEqual(commands.map(()=>({state:'complete'})));
      expect((await db.query('SELECT status FROM agent_turns WHERE request_id=ANY($1::text[])',[commands.map(command=>command.turn_request_id)])).rows)
        .toEqual(commands.map(()=>({status:'failed'})));
    }
    await runRunnerTurn();
    await runRunnerTurn('checkout preparation failed',orders);
    expect(await reportCount()).toBe(0);
  });
