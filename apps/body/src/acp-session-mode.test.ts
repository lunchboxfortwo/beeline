import { expect, it } from 'vitest';
import { AcpClient } from './acp.js';
import { startAgentProcess, stopAgentProcess } from './agent-process.js';

// Model the adapter's documented INITIAL_AGENT_MODE policy across both open
// paths, using a child process so this covers the actual spawn environment.
const modeFixture = `
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (!request.id) return;
  const result = request.method === 'initialize'
    ? {protocolVersion:1,agentCapabilities:{loadSession:true}}
    : {sessionId:'live',modes:{currentModeId:process.env.INITIAL_AGENT_MODE,
        availableModes:[{id:'read-only'},{id:'agent-full-access'}]}};
  const response = ['initialize','session/new','session/load'].includes(request.method)
    ? {result} : {error:{code:-32601,message:'Unexpected startup RPC: '+request.method}};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,...response})+'\\n');
});`;

it.each([
  { label: '/adapter/codex-acp', osSandbox: true, expected: 'agent-full-access' },
  { label: '/adapter/codex-acp', osSandbox: false, expected: 'read-only' },
  { label: 'opencode', osSandbox: true, expected: 'read-only' },
])('starts $label with sandbox=$osSandbox in $expected for create and reload', async ({label,osSandbox,expected}) => {
  for (const operation of ['new','load'] as const) {
    const agentEnv = { INITIAL_AGENT_MODE: 'read-only' };
    const client = new AcpClient({agentCommand:process.execPath,agentArgs:['-e',modeFixture],
      agentLabel:label,osSandbox,agentEnv,resourceScope:'none'});
    try {
      await startAgentProcess(client);
      const session = operation === 'new'
        ? await client.sessionNew({cwd:process.cwd(),mode:'readonly'})
        : await client.sessionLoad({cwd:process.cwd(),sessionId:'live',mode:'readonly'});
      expect(session.raw).toMatchObject({modes:{currentModeId:expected}});
      expect(agentEnv.INITIAL_AGENT_MODE).toBe('read-only');
    } finally { await stopAgentProcess(client); }
  }
});

it('does not promote a pre-tool preamble when the harness ends without closing text', async () => {
  const client = new AcpClient({agentCommand:'pi-acp',agentEnv:{},resourceScope:'none'});
  client.request = async () => {
    client.emit('session/update', {sessionId:'live',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:"I'll pull fresh market data for the briefing."}}});
    client.emit('session/update', {sessionId:'live',update:{sessionUpdate:'tool_call',toolCallId:'markets',status:'in_progress',title:'Fetch markets'}});
    client.emit('session/update', {sessionId:'live',update:{sessionUpdate:'tool_call_update',toolCallId:'markets',status:'completed'}});
    return {stopReason:'end_turn'};
  };
  expect(await client.sessionPrompt('live','Please post the briefing')).toMatchObject({stopReason:'end_turn',agentText:''});
});

it('keeps closing prose when an earlier tool result arrives after its last token', async () => {
  const client = new AcpClient({agentCommand:'codex-acp',agentEnv:{},resourceScope:'none'});
  client.request = async () => {
    for (const update of [
      {sessionUpdate:'tool_call',toolCallId:'markets',status:'in_progress'},
      {sessionUpdate:'agent_message_chunk',content:{type:'text',text:'The briefing is ready.'}},
      {sessionUpdate:'tool_call_update',toolCallId:'markets',status:'completed'},
    ]) client.emit('session/update',{sessionId:'live',update});
    return {stopReason:'end_turn'};
  };
  expect(await client.sessionPrompt('live','Please post the briefing')).toMatchObject({agentText:'The briefing is ready.'});
});

const harnesses = [
  { command:'codex-acp',setter:'session/set_mode',raw:(sandboxed:boolean) => ({
    modes:{currentModeId:sandboxed?'read-only':'agent-full-access',
      availableModes:[{id:'read-only'},{id:'agent-full-access'}]},
  }) },
  { command:'opencode',setter:'session/set_config_option',raw:() => ({
    configOptions:[{id:'mode',category:'mode',currentValue:'build',options:[{value:'plan'},{value:'build'}]}],
  }) },
];

for (const harness of harnesses) {
  it.each(['new','load'] as const)(`delivers a sandboxed ${harness.command} %s session without waiting for a native mode RPC`, async operation => {
    const client=new AcpClient({agentCommand:harness.command,agentEnv:{},osSandbox:true,resourceScope:'none'});
    client.supportsSessionLoading=true;
    const calls:string[]=[];
    const pendingMode=new Promise<unknown>(()=>{});
    client.request=async method=>{
      calls.push(method);
      if (method===`session/${operation}`) return {sessionId:'live',...harness.raw(true)};
      if (method===harness.setter) return pendingMode;
      return {stopReason:'end_turn'};
    };
    const opening=operation==='new'
      ? client.sessionNew({cwd:process.cwd(),mode:'readonly'})
      : client.sessionLoad({cwd:process.cwd(),sessionId:'live',mode:'readonly'});
    const answer=opening.then(session=>client.sessionPrompt(session.sessionId,'Please answer'));
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(calls).toEqual([`session/${operation}`,'session/prompt']);
    expect((await answer).stopReason).toBe('end_turn');
  });

  it.each(['new','load'] as const)(`retains the native safety mode for an unsandboxed ${harness.command} %s session`, async operation => {
    const client=new AcpClient({agentCommand:harness.command,agentEnv:{},osSandbox:false,resourceScope:'none'});
    client.supportsSessionLoading=true;
    const calls:string[]=[];
    let release!: (value:unknown)=>void;
    const pendingMode=new Promise<unknown>(resolve=>{release=resolve;});
    client.request=async method=>{
      calls.push(method);
      if (method===`session/${operation}`) return {sessionId:'live',...harness.raw(false)};
      if (method===harness.setter) return pendingMode;
      return {stopReason:'end_turn'};
    };
    const opening=operation==='new'
      ? client.sessionNew({cwd:process.cwd(),mode:'readonly'})
      : client.sessionLoad({cwd:process.cwd(),sessionId:'live',mode:'readonly'});
    const answer=opening.then(session=>client.sessionPrompt(session.sessionId,'Please answer'));
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(calls).toEqual([`session/${operation}`,harness.setter]);
    release({});
    expect((await answer).stopReason).toBe('end_turn');
    expect(calls).toEqual([`session/${operation}`,harness.setter,'session/prompt']);
  });
}
