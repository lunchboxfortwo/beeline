import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDiagnosticClient } from '@beeline/api-contract/diagnostics-client';
import { parseDiagnosticBatch, type DiagnosticBatch, type DiagnosticDescriptor } from '@beeline/api-contract/diagnostics';
import { ingestDiagnostics, withDiagnosticContext, compactDiagnostics } from './diagnostics.js';
import { readPersonDiagnostics, renderPersonDiagnostics } from './operator-diagnostics.js';
import { createWorkspace } from './workspace-creation.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { deliverMcpEvents } from './rooms-mcp-events.js';
import { sealSecrets } from './free-agents.js';
import { PHONE_OPERATION_NAMES } from './phone/operation-names.js';
import { createBeelineServer } from './server.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import type { TokenAuth } from './auth.js';
import type { DaemonService } from './daemon-service.js';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createAgentCommand } from './agent-command.js';
import { endAgentTurn } from './agent-turn-end.js';

const user='a'.repeat(64), other='b'.repeat(64);
let db: PgliteDatabase;
const descriptor: DiagnosticDescriptor = { platform:'web',client:'web',version:'0.2.22',environment:'lab' };
function batch(patch: Partial<DiagnosticBatch> = {}): DiagnosticBatch {
  return { schemaVersion:1,deviceId:randomUUID(),sessionId:randomUUID(),viewId:randomUUID(),bindingKey:randomUUID(),descriptor,
    events:[{name:'session_started',eventId:randomUUID(),sequence:1,occurredAt:new Date().toISOString()}],...patch };
}
function storage() {
  const values=new Map<string,string>();
  return { values,getItem:async (k:string)=>values.get(k)??null,setItem:async(k:string,v:string)=>{values.set(k,v);},getAllKeys:async()=>[...values.keys()],removeItem:async(k:string)=>{values.delete(k);} };
}
beforeEach(async()=>{
  db=await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Fixture person','diagnostic-fixture'),($2,'human','Other fixture','other-fixture')`,[user,other]);
});
afterEach(async()=>{vi.unstubAllEnvs();await db.close();});

it('acceptance 1 + operator: three installations and returning sessions stay distinct, account changes never reattribute',async()=>{
  for(const platform of ['android','windows','web'] as const) {
    const b=batch({descriptor:{...descriptor,platform}});
    await ingestDiagnostics(db,b);
    b.events=[{eventId:randomUUID(),sequence:2,occurredAt:new Date().toISOString(),name:'screen_viewed',route:'beeline/channels'}];
    await ingestDiagnostics(db,b,user,'fixture-family');
    await expect(ingestDiagnostics(db,b,other)).rejects.toThrow('conflict');
    await expect(ingestDiagnostics(db,{...b,bindingKey:randomUUID()},user)).rejects.toThrow('conflict');
    await ingestDiagnostics(db,{...b,sessionId:randomUUID(),viewId:randomUUID(),bindingKey:randomUUID(),events:[{...b.events[0]!,eventId:randomUUID(),sequence:1}]},user);
  }
  const data=(await readPersonDiagnostics(db,'diagnostic-fixture'))!;
  expect(data.devices).toHaveLength(3);
  expect(data.devices.every(d=>d.sessions.length===2)).toBe(true);
  expect(data.devices.flatMap(d=>d.sessions).flatMap(s=>s.actions).filter(a=>a.detail.name==='screen_viewed')).toHaveLength(6);
  const html=renderPersonDiagnostics(data);
  for(const platform of ['android','windows','web']) expect(html).toContain(platform);
  expect(html).toContain('Devices → sessions → actions');
  expect(html).toContain('screen_viewed');
  expect((await readPersonDiagnostics(db,other))!.devices).toHaveLength(0);
  expect((await db.query(`SELECT 1 FROM diagnostic_reads WHERE user_id=$1`,[user])).rowCount).toBe(1);
});

it('acceptance 2: real server ceremony and the visible client failure join by installation and attempt',async()=>{
  const b=batch(),attemptId=randomUUID(),ceremonyId=randomUUID();
  b.events.push({eventId:randomUUID(),sequence:2,occurredAt:new Date().toISOString(),name:'auth_failed',
    phase:'exchange_started',code:'offline',outcome:'failed',attemptId});
  await ingestDiagnostics(db,b,user);
  await db.query(`INSERT INTO signin_attempt_events(attempt_id,stage,install_id,funnel_attempt_id,provider,platform,version,internal,occurred_at)
    VALUES($1,'ticket_issued',$2,$3,'google','web','0.2.22',false,now())`,[ceremonyId,b.deviceId,attemptId]);
  const timeline=(await readPersonDiagnostics(db,user))!.devices[0]!.sessions[0]!.actions;
  expect(timeline).toContainEqual(expect.objectContaining({source:'client',detail:expect.objectContaining({phase:'exchange_started',code:'offline',attemptId})}));
  expect(timeline).toContainEqual(expect.objectContaining({source:'server',detail:expect.objectContaining({name:'auth_server_step',phase:'ticket_issued',ceremonyId})}));
});

it('acceptance 3: lost response replay has one authoritative workspace fact with a distinct onboarding or connector source',async()=>{
  const b=batch();await ingestDiagnostics(db,b,user);
  const workspaceId=randomUUID(),actionId=randomUUID();
  const origin={deviceId:b.deviceId,sessionId:b.sessionId,viewId:b.viewId,actionId,requestId:randomUUID()};
  const created=await withDiagnosticContext(user,origin,()=>db.transaction(tx=>createWorkspace(tx,{name:'Fixture',workspaceId,creationSource:'onboarding'},user)));
  const replay=await withDiagnosticContext(user,{...origin,requestId:randomUUID()},()=>db.transaction(tx=>createWorkspace(tx,{name:'Fixture',workspaceId,creationSource:'onboarding'},user)));
  expect(replay).toEqual(created);
  await db.transaction(tx=>createWorkspace(tx,{name:'Manual'},user));
  await db.transaction(tx=>createWorkspace(tx,{name:'Connector'},user,undefined,'mcp_consent'));
  const facts=await db.query(`SELECT source,action_id,session_id FROM workspace_creation_facts ORDER BY source`);
  expect(facts.rows.map(f=>f.source)).toEqual(['manual_ui','mcp_consent','onboarding']);
  expect(facts.rows[2]).toMatchObject({action_id:actionId,session_id:b.sessionId});
  expect((await db.query(`SELECT 1 FROM diagnostic_actions WHERE detail->>'name'='workspace_created'`)).rowCount).toBe(3);
});

it('command origin crosses the durable queue and terminal observations never invent a reply',async()=>{
  const b=batch();await ingestDiagnostics(db,b,user);
  const ws=await db.transaction(tx=>createWorkspace(tx,{name:'Command fixture'},user));
  const agent='d'.repeat(64),message='e'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Fixture worker')`,[agent]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,user]);
  await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`,[ws.id,agent]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[ws.id,ws.roomId,agent]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'private order')`,[message,ws.roomId,user]);
  const actionId=randomUUID();
  const command=await withDiagnosticContext(user,{deviceId:b.deviceId,sessionId:b.sessionId,viewId:b.viewId,actionId,requestId:randomUUID()},
    ()=>db.transaction(tx=>createAgentCommand(tx,{roomId:ws.roomId,agentId:agent,sourceMessageId:message,reason:'human_tag'})));
  expect(command).toBeDefined();
  expect((await db.query(`SELECT session_id,action_id FROM diagnostic_command_origins WHERE command_id=$1`,[command!.id])).rows[0])
    .toEqual({session_id:b.sessionId,action_id:actionId});
  await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,$2,$3,'working') ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET status='working',generation_id=NULL`,[ws.roomId,command!.turn_request_id,agent]);
  expect(await db.transaction(tx=>endAgentTurn(tx,command!,'failed','activation-failed'))).toBe(true);
  expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,[ws.roomId,command!.turn_request_id,agent])).rows[0]).toEqual({status:'failed'});
  const steps=(await readPersonDiagnostics(db,user))!.devices[0]!.sessions[0]!.actions.filter(a=>a.command_id===command!.id);
  expect(steps.map(s=>s.detail.name)).toEqual(['agent_command','agent_terminal']);
  expect(steps[1]!.detail.outcome).toBe('failed');
  expect(steps[1]!.detail.hostResult).toBe('failed');
  expect(JSON.stringify(steps)).not.toContain('private order');
});

it('acceptance 4: callback receipt, HTTP refusal, network failure, access skip and absent host acknowledgement remain distinct',async()=>{
  vi.stubEnv('BEELINE_MCP_WEBHOOK_KEY','fixture-key');
  const ws=await db.transaction(tx=>createWorkspace(tx,{name:'Delivery fixture'},user));
  const member='c'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Fixture member')`,[member]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[member,user]);
  await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`,[ws.id,member]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[ws.id,ws.roomId,member]);
  await db.query(`INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES('fixture-client','Fixture','[]')`);
  await db.query(`INSERT INTO rooms_mcp_connections(client_id,identity_id,scope) VALUES('fixture-client',$1,'rooms')`,[user]);
  await db.query(`INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label) VALUES('fixture-client',$1,$2,'fixture')`,[user,member]);
  const secret=sealSecrets('fixture-key','whsec_'+Buffer.alloc(32,1).toString('base64'));
  await db.query(`INSERT INTO rooms_mcp_event_subscriptions(id,client_id,owner_id,member_id,url,secret,verified_at,expires_at)
    VALUES('fixture-sub','fixture-client',$1,$2,'https://fixture.invalid', $3,now(),now()+interval '1 day')`,[user,member,secret]);
  for(let i=0;i<4;i++) {
    const message=String(i+1).repeat(64);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'fixture body must not enter diagnostics')`,[message,ws.roomId,user]);
    await db.query(`INSERT INTO rooms_mcp_event_deliveries(subscription_id,message_id,room_id,event_id,body) VALUES('fixture-sub',$1,$2,$3,'{}')`,[message,ws.roomId,`evt_${i}`]);
    if(i===3)await db.query(`UPDATE messages SET deleted_at=now() WHERE id=$1`,[message]);
  }
  let call=0;
  expect(await deliverMcpEvents(db,async()=>{call++;if(call===3)throw new Error('provider secret must never enter diagnostics');return new Response('',{status:call===1?200:401});})).toBe(1);
  const rows=(await db.query(`SELECT delivery_state,http_status,failure_category,execution_state FROM rooms_mcp_event_deliveries ORDER BY event_id`)).rows;
  expect(rows).toEqual([
    {delivery_state:'delivered',http_status:200,failure_category:null,execution_state:'unknown'},
    {delivery_state:'failed',http_status:401,failure_category:'http_error',execution_state:'unknown'},
    {delivery_state:'failed',http_status:null,failure_category:'network_error',execution_state:'unknown'},
    {delivery_state:'skipped',http_status:null,failure_category:'access_ended',execution_state:'unknown'},
  ]);
  expect(await deliverMcpEvents(db,async()=>{throw new Error('must not retry');})).toBe(0);
  const data=(await readPersonDiagnostics(db,user))!;
  expect(data.deliveries.every(d=>d.host_result==='unknown')).toBe(true);
  expect(JSON.stringify(data)).not.toContain('fixture body');
  expect(JSON.stringify(data)).not.toContain('provider secret');
  for(let i=0;i<3;i++) {
    const command=await db.transaction(tx=>createAgentCommand(tx,{roomId:ws.roomId,agentId:member,sourceMessageId:String(i+1).repeat(64),reason:'human_tag'}));
    expect(command).toBeDefined();
    await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,completion_kind,failure_reason)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET status=EXCLUDED.status,completion_kind=EXCLUDED.completion_kind,failure_reason=EXCLUDED.failure_reason`,[ws.roomId,command!.turn_request_id,member,i===0?'complete':i===1?'failed':'working',
      i===0?'no-reply':null,i===1?'activation-failed':null]);
    await db.query(`DELETE FROM rooms_mcp_event_deliveries WHERE command_id=$1`,[command!.id]);
    await db.query(`UPDATE rooms_mcp_event_deliveries SET message_id=NULL,command_id=$2 WHERE event_id=$1`,[`evt_${i}`,command!.id]);
  }
  const hostResults=(await readPersonDiagnostics(db,user))!.deliveries;
  expect(hostResults.find(d=>d.event_id==='evt_0')!.host_result).toBe('no_reply');
  expect(hostResults.find(d=>d.event_id==='evt_1')!.host_result).toBe('failed');
  expect(hostResults.find(d=>d.event_id==='evt_2')!.host_result).toBe('unknown'); // Host lost before any terminal evidence.
});

it('acceptance 5: bounded offline persistence survives process death and acknowledges duplicates',async()=>{
  const store=storage();let online=false;
  const send=vi.fn(async(b:DiagnosticBatch,authenticated:boolean)=>{
    if(!online)throw new Error('offline');
    return ingestDiagnostics(db,b,authenticated?user:undefined);
  });
  const first=createDiagnosticClient({storage:store,uuid:randomUUID,descriptor,send});
  await first.identify(user);
  for(let i=0;i<1100;i++)await first.record({name:'screen_viewed',route:'beeline/channels'});
  await first.flush();
  const retained=[...store.values.entries()].filter(([key])=>key.startsWith('beeline.diagnostics.event.v1:'));
  expect(retained.length).toBeGreaterThan(32);
  expect(retained.length).toBeLessThanOrEqual(256);
  expect(retained.reduce((sum,[,value])=>sum+value.length*3,0)).toBeLessThanOrEqual(256*1024);
  const restored=createDiagnosticClient({storage:store,uuid:randomUUID,descriptor,send});
  await restored.identify(user);
  const screenCount=[...store.values.entries()].filter(([key,value])=>
    key.startsWith('beeline.diagnostics.event.v1:') && JSON.parse(value).event.name==='screen_viewed').length;
  send.mockClear();online=true;await restored.flush();
  expect((await db.query(`SELECT 1 FROM diagnostic_actions WHERE detail->>'name'='screen_viewed'`)).rowCount).toBe(screenCount);
  expect(send.mock.calls.every(([b])=>b.events.length<=32)).toBe(true);
  const sent=send.mock.calls.find(([b])=>b.events.length===32)![0];
  await ingestDiagnostics(db,sent,user);await ingestDiagnostics(db,sent,user);
  expect((await db.query(`SELECT 1 FROM diagnostic_actions WHERE detail->>'name'='screen_viewed'`)).rowCount).toBe(screenCount);
});

it('records native Expo UUIDv7 updates while retaining UUIDv4 session authority',async()=>{
  const b=batch({descriptor:{...descriptor,platform:'android',client:'expo_native',
    updateId:'019a0000-0000-7000-8000-000000000001'}});
  expect(await ingestDiagnostics(db,b,user)).toEqual({accepted:[b.events[0]!.eventId]});
  expect((await readPersonDiagnostics(db,user))!.devices[0]!.sessions[0]!.descriptor.updateId)
    .toBe(b.descriptor.updateId);
  expect(parseDiagnosticBatch({...b,sessionId:b.descriptor.updateId},PHONE_OPERATION_NAMES)).toBeNull();
});

it('acceptance 5: account switches and copied or denied storage never mix identities, idle sessions rotate without timers',async()=>{
  let at=Date.now();const store=storage();const sent:{b:DiagnosticBatch;owner:string|null}[]=[];
  let owner:string|null=null;
  const client=createDiagnosticClient({storage:store,uuid:randomUUID,descriptor,now:()=>at,send:async(b,authed)=>{sent.push({b,owner:authed?owner:null});throw new Error('offline');}});
  owner=user;await client.identify(user);await client.record({name:'screen_viewed',route:'beeline/channels'});await client.flush();
  const original=(await client.context()).sessionId;
  at+=31*60_000;expect((await client.context()).sessionId).not.toBe(original);
  owner=other;await client.identify(other);await client.record({name:'foreground'});await client.flush();
  expect(sent.at(-1)!.owner).toBe(other);
  expect(sent.at(-1)!.b.events.some(e=>e.name==='screen_viewed')).toBe(false);
  const denied=createDiagnosticClient({storage:{getItem:async()=>{throw new Error('denied');},setItem:async()=>{throw new Error('denied');},getAllKeys:async()=>{throw new Error('denied');},removeItem:async()=>{throw new Error('denied');}},uuid:randomUUID,descriptor,send:async b=>{expect(b.events[0]!.code).toBe('storage_unavailable');return {accepted:b.events.map(e=>e.eventId)};}});
  await denied.record({name:'foreground'});await denied.flush();
});

it('privacy and coverage: rejects content and forged identity fields, preserves clock skew and exposes sequence gaps',async()=>{
  const b=batch();
  for(const payload of [{...b,userId:other},{...b,url:'https://secret.invalid'}, {...b,events:[{...b.events[0],text:'private message'}]},
    {...b,events:[{...b.events[0],code:'bearer-secret'}]}, {...b,descriptor:{...descriptor,deviceName:'Private name'}}]) {
    expect(parseDiagnosticBatch(payload,PHONE_OPERATION_NAMES)).toBeNull();
  }
  b.events=[{...b.events[0]!,name:'screen_viewed',sequence:4,occurredAt:'2030-01-01T00:00:00.000Z'}];
  await ingestDiagnostics(db,b,user);
  const session=(await readPersonDiagnostics(db,user))!.devices[0]!.sessions[0]!;
  expect(session.gaps).toEqual([{after:0,before:4}]);expect(session.coverage).toBe('start_unobserved');
  await db.query(`UPDATE diagnostic_actions SET received_at=now()-interval '31 days'`);
  await compactDiagnostics(db);expect((await db.query(`SELECT 1 FROM diagnostic_actions`)).rowCount).toBe(0);
  await db.query(`DELETE FROM identities WHERE id=$1`,[user]);
  expect((await db.query(`SELECT 1 FROM diagnostic_sessions WHERE user_id=$1`,[user])).rowCount).toBe(0);
});

it('acceptance 8 + private console: real HTTP pre-auth batch and the existing authenticated socket share durable acknowledgements',async()=>{
  const live=new LiveHub();
  const server=createBeelineServer({database:db,phone:new PhoneService(db,'http://fixture.invalid',undefined,undefined,live),live,
    auth:{authenticatePhone:async()=>user,authenticatePhoneSession:async()=>({identityId:user,familyId:'fixture-family'})} as unknown as TokenAuth,
    daemon:{} as DaemonService,mediaMaximumBytes:1,dashboardSecret:'fixture-operator-secret'});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let socket: WebSocket | undefined;
  try {
    const b=batch();
    const preauth=await fetch(base+'/v1/funnel/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
    expect(preauth.status).toBe(200);expect(await preauth.json()).toEqual({accepted:[b.events[0]!.eventId]});
    socket=new WebSocket(base.replace('http','ws')+'/v1/phone/live',['bearer.'+'fixture'.repeat(8)]);
    await once(socket,'open');
    const response=new Promise<Record<string,any>>(resolve=>socket!.on('message',raw=>{const frame=JSON.parse(String(raw));if(frame.t==='res'&&frame.id==='diagnostic-batch')resolve(frame);}));
    socket.send(JSON.stringify({t:'req',id:'diagnostic-batch',op:'reportDiagnostics',args:b}));
    expect(await response).toMatchObject({ok:true,result:{accepted:[b.events[0]!.eventId]}});
    expect((await db.query(`SELECT 1 FROM diagnostic_actions WHERE event_id=$1`,[b.events[0]!.eventId])).rowCount).toBe(1);
    const refused=new Promise<Record<string,unknown>>(resolve=>socket!.on('message',raw=>{
      const frame=JSON.parse(String(raw));if(frame.t==='res'&&frame.id==='unknown-operation')resolve(frame);
    }));
    const query=vi.spyOn(db,'query');
    socket.send(JSON.stringify({t:'req',id:'unknown-operation',op:'https://private.invalid/provider-material',args:{}}));
    expect(await refused).toMatchObject({ok:false});
    expect(query).not.toHaveBeenCalled();
    query.mockRestore();
    expect((await fetch(base+'/v1/admin/diagnostics?person='+user)).status).toBe(403);
    const html=await fetch(base+'/v1/admin/diagnostics?person='+user+'&format=html',{headers:{authorization:'Bearer fixture-operator-secret'}});
    expect(html.status).toBe(200);expect(html.headers.get('cache-control')).toBe('no-store');
    expect(await html.text()).toContain(b.deviceId);
  } finally {
    socket?.terminate();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
