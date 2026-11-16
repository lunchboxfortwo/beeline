import {evaluateRule} from './prompt-case-rules.ts';
import {createStub} from './prompt-replay-stub.mjs';
import {gradeNative} from './prompt-subscription-replay.mjs';
import {loadCases} from './prompt-cases.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {replay,verdict,markdown,MODEL_PINS} from './prompt-pr-replay.mjs';

test('both pinned models run all three samples even after a failed assertion; the table cannot turn 2/3 into PASS',async()=>{
  const out=mkdtempSync(join(tmpdir(),'beeline-message-replay-'));
  const head='a'.repeat(40),calls=[];let published=0;
  try {
    const run=await replay({repository:'Beeline-Work/beeline',number:1,head,out},{
      liveHead:()=>({state:'open',head}),checkout:()=>head,loadCases:()=>[{id:'case',pass:{call:'reply'}}],
      loadSource:async()=>({}),publish:()=>published++,executeSample:async sample=>{
        calls.push([sample.model,sample.seed]);
        return {status:'behavior',pass:calls.length!==2,reason:'expected reply',exitCode:0};
      },
    });
    assert.equal(run.status,'fail');
    assert.deepEqual(calls,Object.values(MODEL_PINS).flatMap(model=>[1000,1001,1002].map(seed=>[model,seed])));
    assert.equal(published,1);
    assert.match(markdown(run.result),/2\/3 \| FAIL/);
    assert.match(markdown(run.result),/sample 2: expected reply/);
    assert.equal(verdict({...run.result,rows:run.result.rows.map(row=>({...row,pass:true}))}),false);
  } finally {rmSync(out,{recursive:true,force:true});}
});
test('a changed PR head never publishes an obsolete model verdict',async()=>{
  const out=mkdtempSync(join(tmpdir(),'beeline-message-replay-'));
  const head='a'.repeat(40);let reads=0,published=0;
  try {
    const run=await replay({repository:'Beeline-Work/beeline',number:1,head,out},{
      liveHead:()=>({state:'open',head:++reads===1?head:'b'.repeat(40)}),checkout:()=>head,
      loadCases:()=>[{id:'case'}],loadSource:async()=>({}),publish:()=>published++,
      executeSample:async()=>({status:'behavior',pass:true,exitCode:0}),
    });
    assert.equal(run.status,'superseded');assert.equal(published,0);
  } finally {rmSync(out,{recursive:true,force:true});}
});

test('messaging fixture envelopes use the declared recipient, sender and System event place',()=>{
  const saved=loadCases();
  for(const c of saved) assert.ok(c.scenario?.results?.some(r=>r.call==='reply' && r.result?.delivered===true),`${c.id} needs a recorded reply receipt`);
  const cases=saved.filter(c=>c.id.startsWith('messaging-'));
  for(let number=1;number<=15;number++) assert.ok(cases.some(c=>c.id.startsWith(`messaging-b${String(number).padStart(2,'0')}-`)),`missing catalog case ${number}`);
  for(const c of cases) {
    const body=c.turn.task.body;
    assert.equal(body.match(/Destination: \(([^,]+),/)?.[1],c.session.agentName.toLowerCase(),c.id);
    assert.equal(body.match(/^From: (.+)$/m)?.[1],c.turn.task.fromName,c.id);
    assert.ok(c.turn.members.includes(`You are ${c.session.agentName}.`),c.id);
    if(c.turn.task.fromName==='System') assert.match(body,/From-place: 33333333-3333-4333-8333-333333333333/,c.id);
  }
});

test('reply completes its request without creating a global turn boundary or hiding later forbidden calls',()=>{
  const tools=['reply','read','message'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{}}}));
  const testCase={pass:{noCall:'message'},scenario:{results:[
    {call:'reply',result:{id:'receipt',delivered:true}},{call:'read',result:{state:'review'}},
    {call:'message',result:{id:'forbidden-message'}},
  ]}};
  const variant={mode:'full'};
  const stub=createStub({testCase,tools,skills:{},variant});
  stub.call('reply',{});stub.call('read',{});
  assert.equal(stub.trace.terminal,null);
  assert.equal(stub.trace.failure,undefined);
  assert.equal(gradeNative(testCase,stub.trace,[{type:'turn.completed'}],variant,tools).pass,true);
  stub.call('message',{});
  assert.equal(gradeNative(testCase,stub.trace,[{type:'turn.completed'}],variant,tools).pass,false);
});

test('claim and PR assertions recognize repository options without accepting a push before claim or a merge',()=>{
  const cases=loadCases();
  const push=cases.find(c=>c.id==='messaging-b09-claim-before-push');
  for(const command of ['git push origin feature/thread-case','git -C /replay/widget push origin feature/thread-case',`git -C "/replay/widget project" push origin feature/thread-case`]) {
    const claim={name:'claim_thread',args:{}},action={name:'Bash',args:{command}};
    assert.equal(evaluateRule(push.pass,{calls:[claim,action],text:''}).pass,true,command);
    assert.equal(evaluateRule(push.pass,{calls:[action,claim,action],text:''}).pass,false,command);
  }
  const pr=cases.find(c=>c.id==='messaging-b10-pr-no-merge');
  const create={name:'Bash',args:{command:'gh --repo Beeline-Work/beeline pr create --fill'}};
  assert.equal(evaluateRule(pr.pass,{calls:[create],text:''}).pass,true);
  assert.equal(evaluateRule(pr.pass,{calls:[create,{name:'Bash',args:{command:'gh -R Beeline-Work/beeline pr merge --squash'}}],text:''}).pass,false);
});
