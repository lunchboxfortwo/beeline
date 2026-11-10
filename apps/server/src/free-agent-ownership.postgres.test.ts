import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it,describe} from 'vitest';
import {migrate,PostgresDatabase,type SqlDatabase} from './database.js';
import {FreeAgentService,freeAgentConfigFromEnv} from './free-agents.js';
import type {FreeAgentMachines} from './fly-machines.js';
import {seedOwnedModelFixture,MODEL_AGENT,MODEL_ROOM} from './test-fixtures/owned-model.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw new Error('Isolated loopback PostgreSQL required');
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return{promise,resolve};};
describe.skipIf(!url)('two independent PostgreSQL lifecycle owners',()=>{
  const name='free_agent_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});
  const target=new URL(url??'postgres://localhost/postgres');target.pathname='/'+name;
  const first=new PostgresDatabase('',2,{pool:new Pool({connectionString:target.toString(),max:2})});
  const second=new PostgresDatabase('',2,{pool:new Pool({connectionString:target.toString(),max:2})});
  const config=freeAgentConfigFromEnv({BEELINE_FREE_AGENT_SEAL_KEY:'fixture',FLY_FREE_AGENT_IMAGE:'current'},'http://fixture')!;
  beforeAll(async()=>{
    await admin.query(`CREATE DATABASE ${name}`);await migrate(first);await seedOwnedModelFixture(first,{installSchema:false});
    await first.query(`UPDATE agent_commands SET state='complete',completed_at=now(); UPDATE agent_connections SET released_at=now(); UPDATE free_agents SET fly_machine_id='m1'`);
  },60_000);
  afterAll(async()=>{await first.close();await second.close();await admin.query(`DROP DATABASE IF EXISTS ${name} WITH(FORCE)`);await admin.end();});
  const command=async(db:SqlDatabase,id:string)=>db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth,state)
    VALUES($1,$2,$3,$1,'input','human_tag',$1,$1,0,'pending')`,[id,MODEL_ROOM,MODEL_AGENT]);
  it('a command committed after the final facts read waits for the same ownership handoff',async()=>{
    const entered=deferred(),release=deferred();let intercept=true,state='stopped';const effects:string[]=[];
    const provider:FreeAgentMachines={
      async list(){return[];},async find(){return undefined;},async read(){return{id:'m1',state,instance_id:'v1',config:{image:'current'}};},
      async create(){throw new Error('must not create');},async update(){throw new Error('must not update');},
      async start(){effects.push('start');state='started';},async suspend(){throw new Error('must not suspend');},
      async waitFor(){},async destroy(){throw new Error('must not destroy');},reconnect(){return this;},
    };
    const observed:SqlDatabase={query:first.query.bind(first),transaction:work=>first.transaction(tx=>work({
      ...tx,transaction:tx.transaction.bind(tx),query:async(sql,values)=>{
        const result=await tx.query(sql,values);
        if(intercept&&sql.includes('FOR UPDATE OF f')){intercept=false;entered.resolve();await release.promise;}
        return result;
      },
    }))};
    const owner=new FreeAgentService(observed,config,provider,async()=>({exchangeToken:'fixture'}),undefined,'owner-one');
    const peer=new FreeAgentService(second,config,provider,async()=>({exchangeToken:'fixture'}),undefined,'owner-two');
    const a=owner.reconcile(MODEL_AGENT);let b:Promise<void>|undefined;
    try{
      await entered.promise;await command(second,'handoff');
      b=peer.reconcile(MODEL_AGENT);release.resolve();await Promise.all([a,b]);
      expect(effects).toEqual(['start']);expect(state).toBe('started');
      expect((await first.query(`SELECT state FROM agent_commands WHERE id='handoff'`)).rows).toEqual([{state:'pending'}]);
    }finally{release.resolve();await Promise.allSettled([a,...(b?[b]:[])]);}
  });
  it('simultaneous sources produce one effect under the operation token',async()=>{
    const entered=deferred(),release=deferred();let state='stopped';const effects:string[]=[];
    const provider:FreeAgentMachines={
      async list(){return[];},async find(){return undefined;},async read(){return{id:'m1',state,instance_id:'v1',config:{image:'current'}};},
      async create(){throw new Error('must not create');},async update(){throw new Error('must not update');},
      async start(){effects.push('start');entered.resolve();await release.promise;state='started';},
      async suspend(){throw new Error('must not suspend');},async waitFor(){},async destroy(){throw new Error('must not destroy');},reconnect(){return this;},
    };
    const owner=new FreeAgentService(first,config,provider,async()=>({exchangeToken:'fixture'}),undefined,'owner-one');
    const peer=new FreeAgentService(second,config,provider,async()=>({exchangeToken:'fixture'}),undefined,'owner-two');
    const a=owner.reconcile(MODEL_AGENT);
    try{await entered.promise;await peer.reconcile(MODEL_AGENT);release.resolve();await a;expect(effects).toEqual(['start']);}
    finally{release.resolve();await a;}
  });
});
