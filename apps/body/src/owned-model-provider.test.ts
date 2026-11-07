import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeOwnedModelReceipt } from '@beeline/api-contract/helper-model-receipt';
import { OwnedModelFiles } from './owned-model-files.js';
import { installOwnedModelProvider } from './owned-model-install.js';
import { ownedModelStream } from './owned-model-provider.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const token = 'bfmc_v1.' + 'a'.repeat(32) + '.' + 'b'.repeat(64);
const baseUrl = 'https://fixture.invalid/v1/free-agents/model';
const model = {
  id: 'synthetic-model',
  name: 'Synthetic',
  api: 'openai-completions' as const,
  provider: 'beeline',
  baseUrl,
  reasoning: false,
  input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10000,
  maxTokens: 256,
};
const context = {
  messages: [{ role: 'user' as const, content: 'Synthetic request', timestamp: 1 }],
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'owned-provider-'));
  roots.push(root);
  const owner = OwnedModelFiles.create({
    root,
    binding: {
      agentId: 'agent',
      commandId: 'command',
      generationId: 'generation',
      connectionId: 'connection',
      connectionEpoch: 1,
      provider: 'beeline',
      model: 'server-selected',
      baseUrl,
    },
    credential: { v: 1, token, expiresAt: null },
  });
  const path = join(root, 'context.json');
  writeFileSync(
    path,
    JSON.stringify({ generationId: 'generation', ownedModelDirectory: owner.paths().directory }),
    { mode: 0o600 },
  );
  vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', path);
  return owner;
}
it('uses the actual Pi provider with one exact invocation credential and commits its authenticated receipt', async () => {
  const owner = fixture();
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      calls.push(String(url));
      const headers = new Headers(init.headers);
      expect(headers.get('x-beeline-model-invocation')).toBe(token);
      const id = headers.get('x-beeline-model-request')!;
      const receipt = encodeOwnedModelReceipt(token, {
        requestId: id,
        state: 'succeeded',
        evidence: { kind: 'usage', tokens: 3, usd: 0 },
      });
      const chunks = [
        {
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Original answer' },
              finish_reason: null,
            },
          ],
        },
        {
          id: receipt,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        },
      ];
      return new Response(
        chunks.map((chunk) => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }),
  );
  const result = await ownedModelStream(model, context).result();
  expect(result.stopReason).toBe('stop');
  expect(result.content).toContainEqual(
    expect.objectContaining({ type: 'text', text: 'Original answer' }),
  );
  expect(owner.snapshot().state).toBe('idle');
  expect(calls).toEqual([baseUrl + '/chat/completions']);
});
it('keeps transport loss UNKNOWN without a helper receipt request or paid replay', async () => {
  const owner = fixture();
  const calls: { method: string; url: string }[] = [];
  vi.stubGlobal('fetch',vi.fn(async (url,init) => {
    calls.push({method:init?.method ?? 'GET',url:String(url)});
    throw new TypeError('synthetic lost response');
  }));
  expect((await ownedModelStream(model,context).result()).stopReason).toBe('error');
  expect(calls).toEqual([{method:'POST',url:baseUrl+'/chat/completions'}]);
  expect(owner.snapshot().state).toBe('unknown');
  expect(()=>ownedModelStream(model,context)).toThrow('UNKNOWN');
  expect(calls).toHaveLength(1);
});

it.each([true,false])('uses the native provider’s error receipt only when authenticated (%s)', async signed => {
  const owner=fixture();
  const native=vi.fn(async (_url,init)=>{
    const id=new Headers(init.headers).get('x-beeline-model-request')!;
    const receipt=encodeOwnedModelReceipt(token,{requestId:id,state:'refused',evidence:{kind:'provider-refused',status:429}});
    return Response.json({error:{message:'The model provider refused this invocation (HTTP 429).',
      signedReceipt:signed ? receipt : receipt.slice(0,-1)+(receipt.endsWith('0')?'1':'0')}},{status:409});
  });
  vi.stubGlobal('fetch',native);
  const result=await ownedModelStream(model,context).result();
  expect(result.stopReason).toBe('error');
  expect(result.errorMessage).toBe('The model provider refused this invocation (HTTP 429).');
  expect(owner.snapshot().state).toBe(signed?'idle':'unknown');
  expect(native).toHaveBeenCalledOnce();
});

it('loads the immutable provider artifact through the pinned Pi extension host', async () => {
  const { build } = await import('esbuild');
  const { discoverAndLoadExtensions } = await import('@earendil-works/pi-coding-agent');
  const root = mkdtempSync(join(tmpdir(),'owned-extension-')); roots.push(root);
  const artifact = join(root,'owned-model-provider.mjs');
  await build({entryPoints:[new URL('./owned-model-provider.ts',import.meta.url).pathname],outfile:artifact,
    bundle:true,platform:'node',format:'esm',target:'node20',external:['@earendil-works/pi-*'],logLevel:'silent'});
  const loaded = await discoverAndLoadExtensions([artifact],root,root);
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toHaveLength(1);
  expect(loaded.runtime.pendingProviderRegistrations).toContainEqual(expect.objectContaining({name:'beeline'}));
});

it('removes the former generated execution budget from a persisted Pi home', async () => {
  const root=mkdtempSync(join(tmpdir(),'owned-upgrade-')); roots.push(root);
  mkdirSync(join(root,'extensions'));
  const retired=join(root,'extensions','beeline-turn-budget.js');
  writeFileSync(retired,'throw new Error("retired execution deadline loaded")');
  await installOwnedModelProvider(root);
  expect(existsSync(retired)).toBe(false);
  expect(existsSync(join(root,'extensions','beeline-owned-model.js'))).toBe(true);
});

it('keeps the invocation journal inside the Room’s existing writable harness state', async () => {
  const {CommandExecutionContext} = await import('./server-command-intake.js');
  const {roomAgentHomeEnv,harnessStateDirsFromEnv} = await import('./agent-home.js');
  const {sandboxMountPlan} = await import('./bwrap-sandbox.js');
  const root=mkdtempSync(join(tmpdir(),'owned-room-')); roots.push(root);
  const command={id:'command',agentId:'agent',roomId:'room',turnRequestId:'request'} as import('@beeline/api-contract/daemon').AgentCommand;
  const source={connectionId:'connection',epoch:1};
  const context=new CommandExecutionContext(root); context.prepareOwnership(source,command.id);
  context.bindModel(command,{v:1,token,expiresAt:null},source,baseUrl);
  await context.enter(command);
  const active=JSON.parse(readFileSync(context.path,'utf8'));
  const plan=sandboxMountPlan({mode:'readonly',cwd:root,
    harnessStateDirs:harnessStateDirsFromEnv(roomAgentHomeEnv(root)).stateDirs});
  expect(plan.writable.some(path=>active.ownedModelDirectory.startsWith(path+'/'))).toBe(true);
  const owner=OwnedModelFiles.open(active.ownedModelDirectory);
  expect(owner.prepareHeaders().requestId).toMatch(/^[a-f0-9-]{36}$/);
  await context.leave();
  expect(()=>owner.prepareHeaders()).toThrow();
});
