import {EventEmitter} from 'node:events';
import type WebSocket from 'ws';
import {afterEach,expect,it,vi} from 'vitest';
import {DaemonApiClient} from './daemon-api-client.js';
import {MachineLink} from './machine-link.js';

const agentId='ab'.repeat(32);
class Socket extends EventEmitter {
  readyState=0;
  onopen?:()=>void;onclose?:()=>void;onmessage?:(message:{data:string})=>void;
  frames:Record<string,any>[]=[];
  send(raw:string){this.frames.push(JSON.parse(raw));}
  receive(frame:Record<string,unknown>){this.onmessage?.({data:JSON.stringify({agentId,...frame})});}
  open(){this.readyState=1;this.onopen?.();}
  register(epoch=1){this.receive({type:'registered',capabilities:{daemonOperationsV1:true,activationConnectionId:'connection',activationConnectionEpoch:epoch,turnConnectionId:'connection',turnConnectionEpoch:epoch}});}
  close(){this.readyState=3;this.onclose?.();}
  terminate(){this.close();}
}
const cleanups:(()=>void)[]=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();vi.useRealTimers();});
function fixture(){
  const sockets:Socket[]=[];
  const machine=new MachineLink({baseUrl:'http://synthetic.invalid',factory:()=>{const socket=new Socket();sockets.push(socket);return socket as unknown as WebSocket;}});
  const fetcher=vi.fn(async()=>{throw new Error('unexpected HTTP request');});
  const api=new DaemonApiClient(machine.origin,'bdt_test',agentId,fetcher,undefined,undefined,machine);
  cleanups.push(()=>machine.stop());return {api,machine,sockets,fetcher};
}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

it('waits for registration before bootstrap or any ordinary request',async()=>{
  const {api,sockets,fetcher}=fixture();
  const request=api.execute('getDaemonBootstrap',{agentId});
  expect(sockets).toHaveLength(1);sockets[0]!.open();await flush();
  expect(sockets[0]!.frames).toEqual([expect.objectContaining({type:'register-machine',agents:[expect.objectContaining({agentId})]})]);
  sockets[0]!.register();await flush();
  const frame=sockets[0]!.frames.find(frame=>frame.type==='daemon-operation')!;
  sockets[0]!.receive({type:'daemon-operation-result',requestId:frame.requestId,result:{id:'bootstrap'}});
  await expect(request).resolves.toEqual({id:'bootstrap'});expect(fetcher).not.toHaveBeenCalled();
});
it('delivers committed reply ids and carries the last queue into a reconnect subscription',async()=>{
  const {api,sockets}=fixture(), listener=vi.fn();
  api.setQueueListener(listener);api.subscribeQueue();
  sockets[0]!.open();sockets[0]!.register();await flush();
  const item={id:'command',agentId,roomId:'room',turnRequestId:'command',sourceMessageId:'source',
    rootCommandId:'command',rootSourceMessageId:'source',reason:'human_tag',action:'input',agentDepth:0,
    source:{id:'source',authorId:'human',body:'hello',createdAt:1,attachments:[]}};
  sockets[0]!.receive({type:'commands',commandProtocol:2,commands:[item],completedCommandIds:[]});
  expect(listener).toHaveBeenLastCalledWith([item],[],[]);
  sockets[0]!.close();await flush();
  sockets[1]!.open();sockets[1]!.register(2);await flush();
  expect(sockets[1]!.frames).toContainEqual({type:'subscribe-queue',agentId,knownCommandIds:['command']});
  sockets[1]!.receive({type:'commands',commandProtocol:2,commands:[],completedCommandIds:['command']});
  expect(listener).toHaveBeenLastCalledWith([],['command'],[]);
  sockets[1]!.receive({type:'commands',commandProtocol:2,commands:[],completedCommandIds:[],stoppedCommandIds:['command',7]});
  expect(listener).toHaveBeenLastCalledWith([],[],['command']);
});
it('registration refusal ends waiting requests with its code without another socket or a timer',async()=>{
  const {api,sockets,machine}=fixture();
  const request=api.execute('getAgentConfiguration',{agentId});
  sockets[0]!.open();sockets[0]!.receive({type:'register-refused',code:'registration_failed'});
  await expect(request).rejects.toMatchObject({message:'Agent registration refused: registration_failed',code:'registration_failed'});
  expect(sockets).toHaveLength(1);expect(machine.link.reconnects).toBe(0);
  expect(sockets[0]!.frames.some(frame=>frame.type==='daemon-operation')).toBe(false);
});
it('elapsed time, pongs, and refused requests never reconnect a living socket',async()=>{
  vi.useFakeTimers();const {api,sockets,machine}=fixture();
  const request=api.execute('getAgentConfiguration',{agentId});const outcome=request.catch(error=>error);
  sockets[0]!.open();sockets[0]!.register();await flush();
  await vi.advanceTimersByTimeAsync(24*60*60*1000);sockets[0]!.emit('pong');
  const frame=sockets[0]!.frames.find(frame=>frame.type==='daemon-operation')!;
  sockets[0]!.receive({type:'daemon-operation-result',requestId:frame.requestId,error:'access denied',status:403});
  expect(await outcome).toMatchObject({status:403,retryable:false});expect(machine.link.reconnects).toBe(0);expect(sockets).toHaveLength(1);
});
it('ends an in-flight request on close and independently reconnects',async()=>{
  const {api,sockets,machine}=fixture();const request=api.execute('getAgentConfiguration',{agentId});
  const outcome=request.catch(error=>error);
  sockets[0]!.open();sockets[0]!.register();await flush();
  sockets[0]!.close();await flush();expect(sockets).toHaveLength(2);
  expect(await outcome).toMatchObject({message:'Agent connection closed; outcome unknown'});
  sockets[1]!.open();sockets[1]!.register(2);await flush();
  expect(sockets[1]!.frames.some(frame=>['daemon-operation','request-result'].includes(frame.type))).toBe(false);
  expect(machine.link.reconnects).toBe(1);
});
it('sends unsent waiting requests once after reconnect without replaying failed work',async()=>{
  const {api,sockets}=fixture();const first=api.execute('getAgentConfiguration',{agentId});
  const outcome=first.catch(error=>error);
  sockets[0]!.open();sockets[0]!.register();await flush();
  const original=sockets[0]!.frames.find(frame=>frame.type==='daemon-operation')!;
  sockets[0]!.close();const waiting=api.execute('getDaemonBootstrap',{agentId});await flush();
  sockets[1]!.open();sockets[1]!.register(2);await flush();
  sockets[1]!.receive({type:'request-missing',requestId:original.requestId});await flush();
  const operations=sockets[1]!.frames.filter(frame=>frame.type==='daemon-operation');expect(operations).toHaveLength(1);
  expect(operations[0]!.requestId).not.toBe(original.requestId);
  for(const frame of operations)sockets[1]!.receive({type:'daemon-operation-result',requestId:frame.requestId,result:{id:'ok'}});
  expect(await outcome).toMatchObject({message:expect.stringContaining('outcome unknown')});
  await expect(waiting).resolves.toEqual({id:'ok'});
});
it('uses one operation path for answers, usage, and queue reads',async()=>{
  const {api,sockets}=fixture();const ready=api.waitForConnection();sockets[0]!.open();sockets[0]!.register();await ready;
  const tasks=[api.execute('postRoomMessage',{roomId:'room',requestId:'request',text:'answer'}),
    api.execute('getAgentCommands',{}),
    api.execute('publishAgentUsageAccount',{agentId} as never)];
  await flush();const operations=sockets[0]!.frames.filter(frame=>frame.type==='daemon-operation');expect(operations).toHaveLength(3);
  for(const frame of operations)sockets[0]!.receive({type:'daemon-operation-result',requestId:frame.requestId,result:{id:'ok'}});
  await Promise.all(tasks);
});
