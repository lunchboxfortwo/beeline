import { beforeEach, expect, it, vi } from 'vitest';
import type { DiagnosticBatch } from '@beeline/api-contract/diagnostics';
const controls=vi.hoisted(()=>({values:new Map<string,string>(),identity:'person-a' as string|null,
  lifecycle:undefined as undefined|((state:string)=>void)}));
vi.mock('@react-native-async-storage/async-storage',()=>({default:{
  getItem:async(k:string)=>controls.values.get(k)??null,
  getAllKeys:async()=>[...controls.values.keys()],
  setItem:async(k:string,v:string)=>{controls.values.set(k,v);},
  removeItem:async(k:string)=>{controls.values.delete(k);},
}}));
vi.mock('expo-crypto',async()=>({randomUUID:(await import('node:crypto')).randomUUID}));
vi.mock('expo-constants',()=>({default:{expoConfig:{version:'0.2.22'}}}));
vi.mock('expo-updates',()=>({runtimeVersion:'21',updateId:null}));
vi.mock('@/sync/appConfig',()=>({loadAppConfig:()=>({releaseSha:'a'.repeat(40)})}));
vi.mock('@/utils/isDesktopShell',()=>({isDesktopShell:()=>false}));
vi.mock('@/auth/monolith-session',()=>({monolithSession:{identityId:async()=>controls.identity}}));
vi.mock('react-native',()=>({Platform:{OS:'android',Version:34},AppState:{currentState:'active',
  addEventListener:(_event:string,fn:(state:string)=>void)=>{controls.lifecycle=fn;return{remove:()=>{controls.lifecycle=undefined;}};}}}));
beforeEach(()=>{vi.resetModules();controls.values.clear();controls.identity='person-a';controls.lifecycle=undefined;});

it('pre-auth foreground and browser background steps flush through the anonymous owner without opening a socket',async()=>{
  const telemetry=await import('./diagnostics');
  const batches:DiagnosticBatch[]=[];
  const { setAnonymousDiagnosticSender }=await import('@/auth/anonymous-diagnostics');
  setAnonymousDiagnosticSender(async b=>{batches.push(b);return{accepted:b.events.map(e=>e.eventId)};});
  const stop=telemetry.startDiagnosticLifecycle();
  controls.lifecycle!('background');controls.lifecycle!('active');
  await vi.waitFor(()=>expect(batches.flatMap(b=>b.events).map(e=>e.name)).toContain('background'));
  expect(batches.flatMap(b=>b.events).filter(e=>e.name==='foreground')).toHaveLength(2);
  stop();expect(controls.lifecycle).toBeUndefined();
});

it('checks the actual account immediately before flushing an offline batch and retains the preceding person’s queue',async()=>{
  const telemetry=await import('./diagnostics');
  const sent:DiagnosticBatch[]=[];
  telemetry.attachDiagnosticSocket({ready:()=>true,send:async b=>{sent.push(b);return{accepted:b.events.map(e=>e.eventId)};}});
  await telemetry.identifyDiagnostics('person-a');
  const originalSession=telemetry.diagnosticOrigin()!.sessionId;
  controls.identity='person-b';
  telemetry.diagnostic({name:'screen_viewed',route:'beeline/channels'});
  telemetry.flushDiagnostics();
  await vi.waitFor(()=>{
    expect(telemetry.diagnosticOrigin()!.sessionId).not.toBe(originalSession);
  });
  expect(sent.flatMap(b=>b.events).some(e=>e.name==='screen_viewed')).toBe(false);
  const pending=[...controls.values.entries()].filter(([k])=>k.startsWith('beeline.diagnostics.event.v1:')).map(([,v])=>JSON.parse(v));
  expect(pending.some((p:{owner:string;event:{name:string}})=>p.owner==='person-a' && p.event.name==='screen_viewed')).toBe(true);
});
