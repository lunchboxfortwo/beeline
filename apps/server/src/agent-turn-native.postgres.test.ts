import { randomUUID } from 'node:crypto';
import { Pool,type QueryResultRow } from 'pg';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createAgentCommand } from './agent-command.js';
import { sendOrder } from './commander.js';
import { claimAgentConnection } from './connection-presence.js';
import { DaemonService } from './daemon-service.js';
import { migrate,PostgresDatabase,type SqlDatabase } from './database.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { concurrentWriters } from './test-fixtures/concurrent-writers.js';
import { routeHumanMessage } from './test-fixtures/queue-routing.test-support.js';
import { startQueuedTurn } from './test-fixtures/queued-turn.test-support.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw new Error('Isolated loopback PostgreSQL required');
describe.skipIf(!url)('native terminal receipt serialization',()=>{
  const name='turn_native_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});
  const target=new URL(url??'postgresql://localhost/postgres');target.pathname='/'+name;
  const config={connectionString:target.toString(),max:1,options:'-c statement_timeout=8000'};
  const first=new PostgresDatabase('',1,{pool:new Pool(config)}),second=new PostgresDatabase('',1,{pool:new Pool(config)});
  const workspace=randomUUID(),room=randomUUID(),person='a'.repeat(64),agent='b'.repeat(64),request=randomUUID();
  let owner:{connectionId:string;epoch:number},commandId:string;
  beforeAll(async()=>{
    await admin.query(`CREATE DATABASE ${name}`);await migrate(first);
    await first.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Helper','helper')`,[person,agent]);
    await first.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[agent,person]);
    await first.query(`INSERT INTO workspaces(id,name) VALUES($1,'Turn proof')`,[workspace]);
    await first.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`,[room,workspace]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,[workspace,person,agent,room]);
    await first.query(`INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('turn-proof',clock_timestamp())`);
    owner={connectionId:'turn-connection',epoch:await claimAgentConnection(first,new LiveHub(),agent,{},
      {connectionId:'turn-connection',instanceId:'turn-proof'})};
    await first.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@helper Please work')`,[request,room,person]);
    commandId=(await createAgentCommand(first,{roomId:room,agentId:agent,sourceMessageId:request,reason:'human_tag'}))!.id;
    await startQueuedTurn(first, room, agent, commandId);
  },60_000);
  afterAll(async()=>{await first.close();await second.close();await admin.query(`DROP DATABASE IF EXISTS ${name} WITH(FORCE)`);await admin.end();});
  it('Stop cancels an order whose transaction started earlier but paused before inserting into an empty queue',async()=>{
    const queueRoom=randomUUID(),commander='d'.repeat(64),aSource=randomUUID(),bSource=randomUUID();
    await first.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Commander','commander')`,[commander]);
    await first.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[commander,person]);
    await first.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Queue')`,[queueRoom,workspace]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'member'),($1,$3,$2,'member'),($1,$3,$4,'owner'),($1,$3,$5,'member')`,[workspace,commander,queueRoom,person,agent]);
    await first.query(`INSERT INTO messages(id,room_id,author_id,text)
      VALUES($1,$3,$4,'First task'),($2,$3,$4,'Second task')`,[aSource,bSource,queueRoom,person]);
    const payload={kind:'order' as const,text:'Do the work',authorId:commander,fromRoomId:queueRoom};
    const running=(await createAgentCommand(first,{roomId:queueRoom,agentId:agent,sourceMessageId:aSource,privatePayload:payload,reason:'order'}))!;
    await startQueuedTurn(first, queueRoom, agent, running.id);
    const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};};
    const inserting=deferred(),release=deferred(),stopping=deferred();
    const observe=(db:SqlDatabase,side:'dispatch'|'stop'):SqlDatabase=>({
      query:async<Row extends QueryResultRow>(sql:string,values?:unknown[])=>{
        if(side==='dispatch'&&sql.includes('INSERT INTO agent_commands')){inserting.resolve();await release.promise;}
        if(side==='stop'&&sql.includes('jsonb_to_recordset')&&sql.includes('FOR UPDATE OF member'))stopping.resolve();
        return db.query<Row>(sql,values);
      },transaction:work=>db.transaction(tx=>work(observe(tx,side))),
    });
    const dispatch=createAgentCommand(observe(first,'dispatch'),{roomId:queueRoom,agentId:agent,
      sourceMessageId:bSource,privatePayload:payload,reason:'order'});
    let stop:Promise<unknown>|undefined;
    try{
      await inserting.promise;
      stop=new PhoneService(observe(second,'stop'),new LiveHub()).execute('cancelAgentTurn',
        {roomId:queueRoom,agentId:agent,requestId:running.turn_request_id},person);
      await Promise.race([stopping.promise,stop.then(()=>{throw new Error('Stop did not use the recipient membership fence');})]);
      release.resolve();const accepted=await dispatch;await stop;
      expect((await first.query('SELECT state FROM agent_commands WHERE id=$1',[accepted!.id])).rows).toEqual([{state:'cancelled'}]);
      expect((await first.query('SELECT status FROM agent_turns WHERE request_id=$1',[running.turn_request_id])).rows).toEqual([{status:'cancelled'}]);
      expect((await first.query(`SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2
        AND action IN ('input','resume') AND state='pending'`,[queueRoom,agent])).rowCount).toBe(0);
    }finally{release.resolve();await Promise.allSettled([dispatch,...(stop?[stop]:[])]);}
  },20_000);
  it('concurrent peer orders share source reads without upgrading the other recipient membership',async()=>{
    const peer='e'.repeat(64),peerRoom=randomUUID(),sources=[randomUUID(),randomUUID()];
    await first.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Peer lead','peerlead')`,[peer]);
    await first.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[peer,person]);
    await first.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Peer orders')`,[peerRoom,workspace]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$5,'member'),($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`,[workspace,peerRoom,person,agent,peer]);
    await first.query(`INSERT INTO messages(id,room_id,author_id,text)
      VALUES($1,$3,$4,'First task'),($2,$3,$4,'Second task')`,[...sources,peerRoom,person]);
    const a=(await createAgentCommand(first,{roomId:peerRoom,agentId:agent,sourceMessageId:sources[0]!,reason:'human_tag'}))!;
    const b=(await createAgentCommand(first,{roomId:peerRoom,agentId:peer,sourceMessageId:sources[1]!,reason:'human_tag'}))!;
    await startQueuedTurn(first, peerRoom, agent, a.id);await startQueuedTurn(first, peerRoom, peer, b.id);
    let reads=0,ready!:()=>void;const bothReading=new Promise<void>(resolve=>ready=resolve);
    const observe=(db:SqlDatabase):SqlDatabase=>({
      query:async<Row extends QueryResultRow>(sql:string,values?:unknown[])=>{
        const result=await db.query<Row>(sql,values);
        if(sql.includes('LIMIT 1 FOR SHARE OF room')){if(++reads===2)ready();await bothReading;}
        return result;
      },transaction:work=>db.transaction(tx=>work(observe(tx))),
    });
    const orders=[{database:first,command:a,actor:agent,target:'peerlead'},{database:second,command:b,actor:peer,target:'helper'}];
    const pending=orders.map(({database,command,actor,target})=>database.transaction(async tx=>{
        await tx.query('SELECT id FROM agent_commands WHERE id=$1 FOR UPDATE',[command.id]);
        await sendOrder(observe(tx),command,actor,peerRoom,'Please check the result',target);
      }));
    try{await Promise.all(pending);}finally{ready();await Promise.allSettled(pending);}
    expect((await first.query(`SELECT id FROM agent_commands WHERE room_id=$1 AND reason='order' AND state='pending'`,[peerRoom])).rowCount).toBe(2);
    await first.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2',[peerRoom,peer]);
    await expect(sendOrder(first,b,peer,peerRoom,'Another order','helper')).rejects.toThrow('address requires current membership');
  },20_000);

  it('a delegated order commits before a concurrent membership removal',async()=>{
    const actor='f'.repeat(64),targetRoom=randomUUID(),source=randomUUID();
    await first.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Issuer','issuer')`,[actor]);
    await first.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[actor,person]);
    await first.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Delegation')`,[targetRoom,workspace]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'member'),($1,$2,$3,'member'),($1,$2,$4,'member'),($1,$2,$5,'owner')`,[workspace,targetRoom,actor,agent,person]);
    await first.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Please delegate')`,[source,targetRoom,person]);
    const command=(await createAgentCommand(first,{roomId:targetRoom,agentId:actor,sourceMessageId:source,reason:'human_tag'}))!;
    await startQueuedTurn(first, targetRoom, actor, command.id);
    let entered!:()=>void,release!:()=>void;
    const written=new Promise<void>(resolve=>entered=resolve),released=new Promise<void>(resolve=>release=resolve);
    const creating=first.transaction(async tx=>{
      await tx.query('SELECT id FROM agent_commands WHERE id=$1 FOR UPDATE',[command.id]);
      await sendOrder(tx,command,actor,targetRoom,'Please check the result','helper');
      entered();await released;
    });
    try {
      await Promise.race([written,creating.then(()=>{throw new Error('Delegation did not reach its commit boundary');})]);
      const removing=second.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2',[targetRoom,actor]);
      release();
      await Promise.all([creating,removing]);
      expect((await first.query(`SELECT id FROM agent_commands WHERE room_id=$1 AND reason='order'`,[targetRoom])).rowCount).toBe(1);
      await expect(sendOrder(first,command,actor,targetRoom,'A later order','helper')).rejects.toThrow('address requires current membership');
    } finally {release();await Promise.allSettled([creating]);}

  },20_000);
});
