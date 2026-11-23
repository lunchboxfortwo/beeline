import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installOwnedModelProvider } from './owned-model-install.js';
import { ownedModelStream } from './owned-model-provider.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const token = 'bfm_' + 'a'.repeat(43);
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
it('uses the provisioned bearer for both prompts even when the sandbox sees the first turn context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owned-provider-'));
  roots.push(root);
  const path = join(root, 'context.json');
  writeFileSync(path, JSON.stringify({ itemId: 'first', ownedModelDirectory: join(root, 'revoked') }));
  vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', path);
  vi.stubEnv('BEELINE_FREE_AGENT_MODEL_TOKEN', token);
  vi.stubEnv('BEELINE_MODEL_ROOM_ID', 'general');
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    expect(String(url)).toBe(baseUrl + '/chat/completions');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer ' + token);
    expect(headers.get('x-beeline-model-room')).toBe('general');
    requests.push(headers.get('x-beeline-model-request')!);
    const chunk = JSON.stringify({
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Answer' }, finish_reason: 'stop' }],
    });
    return new Response('data: ' + chunk + '\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  }));

  for (const text of ['First prompt', 'Second prompt']) {
    const result = await ownedModelStream(model, {
      ...context, messages: [{ ...context.messages[0]!, content: text }],
    }).result();
    expect(result.stopReason).toBe('stop');
    expect(result.content).toContainEqual(expect.objectContaining({ type: 'text', text: 'Answer' }));
  }
  expect(requests).toHaveLength(2);
  expect(new Set(requests).size).toBe(2);
});

it('loads the immutable provider artifact through the pinned Pi extension host', async () => {
  const { build } = await import('esbuild');
  const { discoverAndLoadExtensions, ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const root = mkdtempSync(join(tmpdir(),'owned-extension-')); roots.push(root);
  const artifact = join(root,'owned-model-provider.mjs');
  await build({entryPoints:[new URL('./owned-model-provider.ts',import.meta.url).pathname],outfile:artifact,
    bundle:true,platform:'node',format:'esm',target:'node20',external:['@earendil-works/pi-*'],logLevel:'silent'});
  const loaded = await discoverAndLoadExtensions([artifact],root,root);
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toHaveLength(1);
  expect(loaded.runtime.pendingProviderRegistrations).toContainEqual(expect.objectContaining({name:'beeline'}));
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'),
    modelsPath: join(root, 'models.json'), modelsStorePath: join(root, 'catalog.json'), refreshOnCreate: false });
  // Discovery only queues registrations. Pi applies them on startup, where an
  // invalid transport declaration exits the process beneath pi-acp.
  for (const registration of loaded.runtime.pendingProviderRegistrations)
    runtime.registerProvider(registration.name, registration.config);
  expect(runtime.getRegisteredProviderIds()).toContain('beeline');
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
