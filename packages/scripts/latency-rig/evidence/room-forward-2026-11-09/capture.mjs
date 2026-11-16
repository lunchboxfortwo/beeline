import { chromium } from 'playwright';
import pg from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture, seedWebFixtures, resetWebFixture, verifyWebEffect, workspace, uuid, viewer, peer, hash } from '../../web-fixtures.mjs';
import { steps } from '../../web-steps.mjs';
import { armForwardTiming, readForwardTiming } from '../../web-forward-timing.mjs';
const out=resolve(process.argv[2]);
await mkdir(out,{recursive:true});
const origin=process.env.PROOF_ORIGIN??'http://127.0.0.1:18089', backend='http://127.0.0.1:18090';
const db=new pg.Client({connectionString:'postgresql://localhost/beeline_latency_rig_inventory?host=%2Fvar%2Frun%2Fpostgresql'});
await db.connect();
await seedWebFixtures(db);
const dm={...fixture('open-room'),roomId:uuid('proof-existing-dm'),messageId:hash('proof-existing-dm-message'),text:'Latency fixture existing direct message'};
await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,direct_participants) VALUES($1,$2,$3,'DM',$4::jsonb) ON CONFLICT(id) DO NOTHING`,[dm.roomId,workspace,viewer,JSON.stringify([viewer,peer])]);
for(const who of [viewer,peer]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) SELECT $1,$2,$3,'owner' WHERE NOT EXISTS(SELECT 1 FROM memberships WHERE room_id=$2 AND identity_id=$3 AND removed_at IS NULL)`,[workspace,dm.roomId,who]);
await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,[dm.messageId,dm.roomId,peer,dm.text]);
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const results=[];
const screenshots=[];
let signedInState;
try {
for(const [device,viewport] of [['phone-web',{width:390,height:844}],['web',{width:1365,height:900}]]) {
 if(process.env.PROOF_DEVICE&&process.env.PROOF_DEVICE!==device)continue;
 for(const [theme,colorScheme] of [['Bone','light'],['Obsidian','dark']]) {
  const context=await browser.newContext({viewport,colorScheme,baseURL:origin,serviceWorkers:'block',storageState:signedInState});
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin===origin)return route.continue();
   if(url.origin!==backend)return route.abort();
   if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':origin,'access-control-allow-headers':'*','access-control-allow-methods':'*'}});
   const response=await route.fetch();return route.fulfill({response,headers:{...response.headers(),'access-control-allow-origin':origin}});
  });
  await context.routeWebSocket('**/*',socket=>{const url=new URL(socket.url());if(url.hostname==='127.0.0.1'&&url.port==='18090')socket.connectToServer();else socket.close();});
  const page=await context.newPage();page.setDefaultTimeout(12000);
  await page.goto(signedInState?origin+'/beeline/channels':origin+'/review/latency-fixture-local-only-web-inventory');await page.waitForURL('**/beeline/channels**');
  signedInState=await context.storageState();
  await page.evaluate((appearance)=>{
   localStorage.setItem('beeline.settings.local-settings',JSON.stringify({appearance,uiSize:'medium'}));
   localStorage.setItem('beeline.settings.appearance-system-v1','done');
  },colorScheme);
  for(const name of ['open-room','open-dm','forward-message']){
   const f=name==='open-dm'?dm:fixture(name);
   const count=device==='phone-web'&&theme==='Obsidian'?40:1;
   const samples=[];
   for(let sample=0;sample<count;sample++){
    await page.goto(origin+'/__latency_blank.html');
    await page.evaluate(async()=>{
     for(const key of Object.keys(localStorage))if(key.startsWith('beeline.surface.')||key.startsWith('beeline.outbox.'))localStorage.removeItem(key);
     sessionStorage.clear();
     for(const database of await indexedDB.databases())await new Promise((resolve,reject)=>{const req=indexedDB.deleteDatabase(database.name);req.onsuccess=resolve;req.onerror=reject;req.onblocked=reject;});
    });
    if(name!=='open-dm')await resetWebFixture(db,f);
    if(device==='web'&&name==='forward-message')await page.setViewportSize({width:390,height:844});
    const prepared=device==='web'&&name!=='forward-message'
      ? {act:()=>page.goto(`/beeline/chat/${f.roomId}?communityId=${workspace}`),done:()=>page.getByText(f.text,{exact:true}).first().waitFor({state:'visible'})}
      : await steps[name==='open-dm'?'open-room':name](page,f);
    if(device==='web'&&name==='forward-message')await page.setViewportSize(viewport);
    if(name==='forward-message')await page.evaluate(armForwardTiming,{messageText:f.text});
    if(sample===0&&name==='forward-message')await page.screenshot({path:resolve(out,`${device}-${theme}-forward-picker.png`)});
    const feedbackShot=sample===0&&name==='forward-message'&&process.argv[3]==='after'
      ? page.getByText('FORWARDED',{exact:true}).waitFor({state:'visible'}).then(()=>page.screenshot({path:resolve(out,`${device}-${theme}-forward-result.png`)}))
      : Promise.resolve();
    await page.evaluate(()=>{window.__latencyStart=performance.now();});
    await prepared.act();await prepared.done();await feedbackShot;
    const driverMs=await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-window.__latencyStart)))));
    const timing=name==='forward-message'?await page.evaluate(readForwardTiming):{durationMs:driverMs};
    await verifyWebEffect(db,f);
    samples.push({...timing,driverMs});
    if(sample===0){
     const path=resolve(out,`${device}-${theme}-${name}.png`);await page.screenshot({path});screenshots.push(path);
    }
   }
   const sorted=samples.map(x=>x.durationMs).sort((a,b)=>a-b);
   results.push({device,theme,name,samples,p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1]});
   console.log(JSON.stringify({...results.at(-1),samples:samples.length}));
   await writeFile(resolve(out,'results.json'),JSON.stringify({browser:browser.version(),results,screenshots},null,2));
  }
  await context.close();
 }
}
}finally{await browser.close();await db.end();}
