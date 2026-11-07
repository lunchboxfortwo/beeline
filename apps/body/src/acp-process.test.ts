import { once } from 'node:events';
import { expect, it } from 'vitest';
import { AcpClient, AcpRuntimeExitedError } from './acp.js';
import { startAgentProcess, stopAgentProcess } from './agent-process.js';

const fixture = `
const readline = require('node:readline');
const input = readline.createInterface({input:process.stdin});
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1,agentCapabilities:{}}})+'\\n');
  if (request.method === 'session/new') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{sessionId:'fixture'}})+'\\n');
  if (request.method === 'session/prompt') process.stderr.write('prompt-ready');
});`;

it('settles a silent prompt from actual process death and never restarts it', async () => {
  const client = new AcpClient({
    agentCommand: process.execPath,
    agentArgs: ['-e', fixture],
    agentEnv: {},
    inheritProcessEnv: false,
    resourceScope: 'none',
  });
  try {
    await startAgentProcess(client);
    const session = await client.sessionNew({ cwd: process.cwd() });
    const ready = once(client, 'stderr');
    const prompt = client.sessionPrompt(session.sessionId, 'work');
    const rejected = expect(prompt).rejects.toBeInstanceOf(AcpRuntimeExitedError);
    await ready;
    process.kill(client.processPid()!, 'SIGKILL');
    await rejected;
    expect(client.isAlive).toBe(false);
  } finally {
    await stopAgentProcess(client);
  }
});

it('stopping a process rejects its pending request without a timer or shutdown wait', async () => {
  const client = new AcpClient({
    agentCommand: process.execPath,
    agentArgs: ['-e', fixture],
    agentEnv: {},
    inheritProcessEnv: false,
    resourceScope: 'none',
  });
  try {
    await startAgentProcess(client);
    const session = await client.sessionNew({ cwd: process.cwd() });
    const ready = once(client, 'stderr');
    const prompt = client.sessionPrompt(session.sessionId, 'work');
    const rejected = expect(prompt).rejects.toBeInstanceOf(AcpRuntimeExitedError);
    await ready;
    await stopAgentProcess(client);
    await rejected;
    expect(client.isAlive).toBe(false);
  } finally {
    await stopAgentProcess(client);
  }
});

it('cleans up an unspawnable program without waiting for an exit event it cannot emit', async () => {
  const client = new AcpClient({
    agentCommand: '/does-not-exist/beeline-agent',
    agentEnv: {},
    inheritProcessEnv: false,
    resourceScope: 'none',
  });
  await expect(startAgentProcess(client)).rejects.toThrow();
  expect(client.isAlive).toBe(false);
  await stopAgentProcess(client);
});


it.each(['tool', 'async'] as const)('keeps a background %s completion in the original invocation without another prompt', async kind => {
  const source=fixture.replace("if (request.method === 'session/prompt') process.stderr.write('prompt-ready');", `
    if(request.method==='session/prompt') {
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture',update:{sessionUpdate:'tool_call',toolCallId:'build',title:'Build',status:'in_progress'}}})+'\\n');
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{stopReason:'end_turn'}})+'\\n');
      process.stderr.write('tool-pending');
    }
    if(request.method==='fixture/complete') {
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture',update:{sessionUpdate:'tool_call_update',toolCallId:'build',status:'completed',rawOutput:'original-result'}}})+'\\n');
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{}})+'\\n');
    }
  `);
  const script = kind === 'async' ? source
    .replace("sessionUpdate:'tool_call',toolCallId:'build',title:'Build',status:'in_progress'","sessionUpdate:'async_task_spawned',asyncTaskId:'build',name:'Build'")
    .replace("sessionUpdate:'tool_call_update',toolCallId:'build',status:'completed',rawOutput:'original-result'","sessionUpdate:'async_task_state_update',asyncTaskId:'build',state:'completed'") : source;
  const client=new AcpClient({agentCommand:process.execPath,agentArgs:['-e',script],agentEnv:{},inheritProcessEnv:false,resourceScope:'none'});
  let settled=false,bookkeeping=0;
  try {
    await startAgentProcess(client);await client.sessionNew({cwd:process.cwd()});
    const ready=once(client,'stderr');
    const prompt=client.sessionPrompt('fixture','build',undefined,undefined,undefined,()=>{bookkeeping++;}).then(result=>{settled=true;return result;});
    await ready;await new Promise<void>(resolve=>setImmediate(resolve));
    expect(settled).toBe(false);
    await client.request('fixture/complete',{});
    const result=await prompt;
    expect(result.toolCalls).toContainEqual(expect.objectContaining(kind === 'async' ? {id:'async:build',status:'completed'} : {id:'build',status:'completed',rawOutput:'original-result'}));
    expect(bookkeeping).toBe(0);
  } finally { await stopAgentProcess(client); }
});
