import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDiagnosticClient } from './diagnostics-client.js';
import { parseDiagnosticBatch } from './diagnostics.js';
import type { DiagnosticBatch, DiagnosticDescriptor } from './diagnostics.js';

it('retains both simultaneous browser views when they persist into the same installation storage',async()=>{
  const values=new Map<string,string>();
  const storage={getItem:async(k:string)=>values.get(k)??null,setItem:async(k:string,v:string)=>{values.set(k,v);},
    getAllKeys:async()=>[...values.keys()],removeItem:async(k:string)=>{values.delete(k);}};
  const descriptor:DiagnosticDescriptor={platform:'web',client:'web',version:'0.2.22',environment:'lab'};
  let online=false;const delivered:DiagnosticBatch[]=[];
  const send=async(batch:DiagnosticBatch)=>{if(!online)throw new Error('offline');delivered.push(batch);return{accepted:batch.events.map(e=>e.eventId)};};
  const one=createDiagnosticClient({storage,uuid:randomUUID,descriptor,send});
  const two=createDiagnosticClient({storage,uuid:randomUUID,descriptor,send});
  await Promise.all([one.identify('person'),two.identify('person')]);
  await Promise.all([one.record({name:'screen_viewed',route:'beeline/channels'}),two.record({name:'screen_viewed',route:'beeline/community'})]);
  await Promise.all([one.flush(),two.flush()]);
  online=true;
  const restarted=createDiagnosticClient({storage,uuid:randomUUID,descriptor,send});
  await restarted.identify('person');await restarted.flush();
  const screens=delivered.flatMap(b=>b.events.filter(e=>e.name==='screen_viewed').map(e=>({route:e.route,viewId:b.viewId})));
  expect(screens.map(e=>e.route).sort()).toEqual(['beeline/channels','beeline/community']);
  expect(new Set(screens.map(e=>e.viewId)).size).toBe(2);
});

it('delivers native Expo UUIDv7 update descriptors without weakening session UUIDs', async () => {
  const values = new Map<string,string>();
  const storage = { getItem: async (key:string) => values.get(key) ?? null,
    setItem: async (key:string,value:string) => { values.set(key,value); },
    getAllKeys: async () => [...values.keys()], removeItem: async (key:string) => { values.delete(key); } };
  const batches: DiagnosticBatch[] = [];
  const client = createDiagnosticClient({ storage, uuid: randomUUID,
    descriptor: { platform:'android',client:'expo_native',version:'0.2.22',environment:'production',
      updateId:'019a0000-0000-7000-8000-000000000001' },
    send: async batch => {
      expect(parseDiagnosticBatch(batch,new Set())).not.toBeNull();
      batches.push(batch);
      return { accepted:batch.events.map(event=>event.eventId) };
    } });
  await client.identify('person');
  await client.flush();
  expect(batches).toHaveLength(1);
  expect(parseDiagnosticBatch({ ...batches[0],sessionId:batches[0].descriptor.updateId },new Set())).toBeNull();
  expect([...values.keys()].filter(key=>key.startsWith('beeline.diagnostics.event.'))).toEqual([]);
});

it('bounds an undeliverable queue, frees old diagnostic storage on restart, and preserves user data',async()=>{
  const values=new Map<string,string>([['saved-credential','private'],['unsent-message','keep']]);
  const removals:string[][]=[];
  const storage={getItem:async(k:string)=>values.get(k)??null,setItem:async(k:string,v:string)=>{values.set(k,v);},
    getAllKeys:async()=>[...values.keys()],removeItem:async(k:string)=>{values.delete(k);},
    multiRemove:async(keys:readonly string[])=>{removals.push([...keys]);for(const key of keys)values.delete(key);}};
  const descriptor:DiagnosticDescriptor={platform:'android',client:'expo_native',version:'0.2.22',environment:'lab'};
  let online=false;const delivered:DiagnosticBatch[]=[];
  const send=async(batch:DiagnosticBatch)=>{if(!online)throw new Error('refused');delivered.push(batch);return{accepted:batch.events.map(e=>e.eventId)};};
  const client=createDiagnosticClient({storage,uuid:randomUUID,descriptor,send});
  await client.identify('person');
  for(let i=0;i<700;i++)await client.record({name:'screen_viewed',route:'beeline/channels'});
  await client.flush();
  const stored=[...values.keys()].filter(key=>key.startsWith('beeline.diagnostics.event.'));
  expect(stored.length).toBeLessThanOrEqual(256);
  expect(stored.reduce((sum,key)=>sum+values.get(key)!.length*3,0)).toBeLessThanOrEqual(256*1024);
  // Simulate an older build having left thousands of duplicate diagnostic rows.
  const template=JSON.parse(values.get(stored.at(-1)!)!);
  for(let i=0;i<1000;i++){
    const eventId=randomUUID();
    values.set('beeline.diagnostics.event.v1:'+eventId,JSON.stringify({...template,event:{...template.event,eventId}}));
  }
  const restarted=createDiagnosticClient({storage,uuid:randomUUID,descriptor,send});
  await restarted.identify('person');
  online=true;await restarted.flush();
  expect(delivered.flatMap(batch=>batch.events).length).toBeLessThanOrEqual(258);
  expect(values.get('saved-credential')).toBe('private');
  expect(values.get('unsent-message')).toBe('keep');
  expect([...values.keys()].filter(key=>key.startsWith('beeline.diagnostics.event.'))).toEqual([]);
  expect(removals.some(keys=>keys.length===128)).toBe(true);
  expect(removals.every(keys=>keys.length<=128 && keys.every(key=>key.startsWith('beeline.diagnostics.event.v1:')))).toBe(true);
});

it('keeps sending from memory when storage is full, without retrying failed saves',async()=>{
  const values=new Map<string,string>([['beeline.funnel.install.v1',randomUUID()]]);
  let writes=0;
  const storage={getItem:async(k:string)=>values.get(k)??null,setItem:async()=>{writes++;throw new Error('SQLITE_FULL');},
    getAllKeys:async()=>[...values.keys()],removeItem:async(k:string)=>{values.delete(k);}};
  let online=false;const delivered:DiagnosticBatch[]=[];
  const client=createDiagnosticClient({storage,uuid:randomUUID,
    descriptor:{platform:'android',client:'expo_native',version:'0.2.22',environment:'lab'},
    send:async batch=>{if(!online)throw new Error('offline');delivered.push(batch);return{accepted:batch.events.map(e=>e.eventId)};} });
  await client.identify('person');
  const failedWrites=writes;
  for(let i=0;i<20;i++)await client.record({name:'foreground'});
  online=true;await client.flush();
  expect(delivered.flatMap(batch=>batch.events).some(event=>event.name==='foreground')).toBe(true);
  expect(writes).toBe(failedWrites);
});
