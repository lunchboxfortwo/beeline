import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDiagnosticClient } from './diagnostics-client.js';
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
