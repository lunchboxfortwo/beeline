import { describe,expect,it,vi } from 'vitest';
import type { CommandActivationInput,CommandActivationSnapshot } from '@beeline/api-contract/helper-activation';
import { CommandActivationContext,type ActivationTransport } from './helper-activation-context.js';
const input={agentId:'agent',workspaceId:'workspace',roomId:'room',commandId:'command',generationId:'generation'};
const snapshot=(identity:CommandActivationInput):CommandActivationSnapshot=>({...identity,v:1,capturedAt:100,authority:{generation:'a'.repeat(32),revision:1,commandRevision:'b'.repeat(64)},
  configuration:{fastMode:false,commands:[],yoloMode:false,isReviewer:false},roster:{members:[]},grants:{grants:[]},repository:{resolution:'none'}});
describe('command setup admission and reuse',()=>{
  it('joins repeated setup consumers and never writes or requests a second snapshot for the same command',async()=>{
    const scope={origin:'https://synthetic.invalid',generation:1,source:{connectionId:'source',epoch:1}};
    const read=vi.fn(async(value:CommandActivationInput)=>snapshot(value));
    const context=new CommandActivationContext({scope:()=>scope,machine:()=>true,ready:async()=>{},read},()=>100);
    const values=await Promise.all(Array.from({length:20},()=>context.read(input)));
    expect(new Set(values).size).toBe(1);expect(read).toHaveBeenCalledTimes(1);
    await context.read({...input,commandId:'next-command'});expect(read).toHaveBeenCalledTimes(2);
  });
  it('joins a refused capture while it is pending, asks again on the next setup step and keeps machine transport while disconnected',async()=>{
    let available=true;const read=vi.fn(async(value:CommandActivationInput)=>snapshot(value));
    read.mockRejectedValueOnce(new Error('capture unavailable'));
    const transport:ActivationTransport={scope:()=>available?{origin:'https://synthetic.invalid',generation:1,source:{connectionId:'source',epoch:1}}:undefined,machine:()=>true,ready:async()=>{},read};
    const context=new CommandActivationContext(transport,()=>100);
    const joined=[context.read(input),context.read(input)];
    for(const value of joined)await expect(value).rejects.toThrow('capture unavailable');
    expect(read).toHaveBeenCalledTimes(1);
    await context.read(input);expect(read).toHaveBeenCalledTimes(2);
    available=false;await expect(context.read(input)).rejects.toThrow('Activation capability unavailable');expect(read).toHaveBeenCalledTimes(2);
  });
  it('keeps the same command across a reconnect while capture is pending and after it settles, without a second capture',async()=>{
    let epoch=1,finish!:(value:CommandActivationSnapshot)=>void;
    const read=vi.fn((_value:CommandActivationInput)=>new Promise<CommandActivationSnapshot>(resolve=>{finish=resolve;}));
    const context=new CommandActivationContext({scope:()=>({origin:'https://synthetic.invalid',generation:epoch,source:{connectionId:'socket-'+epoch,epoch}}),machine:()=>true,ready:async()=>{},read},()=>100);
    const pending=context.read(input);epoch=2;
    const joined=context.read(input);
    finish(snapshot({...input,source:{connectionId:'socket-1',epoch:1}}));
    const value=await pending;expect(await joined).toBe(value);
    epoch=3;expect(await context.read(input)).toBe(value);expect(read).toHaveBeenCalledTimes(1);
  });
  it('refuses a late result for a replaced command, a changed origin and an expired held grant without refetching',async()=>{
    let origin='https://synthetic.invalid',at=100,finish!:(snapshot:CommandActivationSnapshot)=>void;
    const read=vi.fn((value:CommandActivationInput)=>value.commandId==='command'&&read.mock.calls.length===1?new Promise<CommandActivationSnapshot>(resolve=>{finish=resolve;}):Promise.resolve({...snapshot(value),validUntil:101}));
    const context=new CommandActivationContext({scope:()=>({origin,generation:1,source:{connectionId:'source',epoch:1}}),machine:()=>true,ready:async()=>{},read},()=>at);
    const pending=context.read(input);await context.read({...input,commandId:'next-command'});finish(snapshot({...input,source:{connectionId:'source',epoch:1}}));
    await expect(pending).rejects.toThrow('ownership changed');
    const settled=context.read({...input,commandId:'next-command'});await settled;
    origin='https://other.invalid';await expect(context.read({...input,commandId:'next-command'})).resolves.toBeDefined();
    expect(read).toHaveBeenCalledTimes(3);
    at=102;await expect(context.read({...input,commandId:'next-command'})).rejects.toThrow('expired');expect(read).toHaveBeenCalledTimes(3);
  });
});
