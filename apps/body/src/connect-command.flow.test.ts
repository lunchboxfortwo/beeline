import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ install: vi.fn(), start: vi.fn(), select: vi.fn(), text: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readFile: vi.fn(async () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), mkdir: vi.fn(), writeFile: vi.fn(), chmod: vi.fn(), unlink: vi.fn(),
}));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: (...args: unknown[]) => fixture.start(...args) }));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(), outro: vi.fn(), log: { info: vi.fn(), warn: vi.fn() },
  select: (...args: unknown[]) => fixture.select(...args), text: (...args: unknown[]) => fixture.text(...args),
  isCancel: (value: unknown) => typeof value === 'symbol',
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
}));
vi.mock('./runtime.js', async importOriginal => ({ ...await importOriginal<typeof import('./runtime.js')>(), defaultSupervisorRoot: () => '/tmp/beeline-connect-unit', findAgentRuntimeConfigPaths: async () => [] }));
vi.mock('./device-pairing.js', () => ({ completeDevicePairing: vi.fn() }));
vi.mock('./systemd.js', async importOriginal => ({ ...await importOriginal<typeof import('./systemd.js')>(), isCanonicalInstalledLauncher: () => true }));
vi.mock('./connect-command.js', () => ({
  brass: (text: string) => text,
  installCurrentRelease: (...args: unknown[]) => fixture.install(...args),
  clackPrompts: {}, loadConnectModelCatalog: vi.fn(), fileConnectKeyStore: {},
  collectConnectWizard: async () => ({ harness: 'codex', model: 'gpt-5.4' }),
  isReasonableAgentName: () => true, AGENT_NAME_MAX_LENGTH: 40, CONNECT_HARNESSES: ['codex'],
  jsonRequest: async (url: string, body: unknown, fetchImpl: typeof fetch) => {
    const response = await fetchImpl(url, { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },
}));
import { runConnectWizard } from './connect-command-parse-connect-subscriptions.js';

const claimed = {
  agent_name: 'Bruin', agent_face: 'bear', agent_pubkey: 'a'.repeat(64), agent_secret_key: 'b'.repeat(64), body_secret_key: 'c'.repeat(64),
  daemon_exchange_token: 'bde_' + 'd'.repeat(43), workspace_id: 'workspace', workspace_name: 'Builders', workspace_joined: true,
  paired_by: 'e'.repeat(64), harness: 'codex', model: 'gpt-5.4', soul: 'soul',
};
let requests: string[], output: string[], fetchImpl: typeof fetch;
beforeEach(() => {
  vi.clearAllMocks(); requests = []; output = [];
  vi.spyOn(console, 'log').mockImplementation((line = '') => { output.push(String(line)); });
  fixture.install.mockResolvedValue({ binary: '/test/beeline', version: 'test' });
  fixture.select.mockResolvedValue('rename'); fixture.text.mockResolvedValue('Milo');
  fixture.start.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    requests.push('helper-start'); queueMicrotask(() => child.emit('exit', 0, null)); return child;
  });
  fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname; requests.push(path);
    const data = path.endsWith('/name') ? { agent_name: 'Milo' }
      : path.endsWith('/finish') ? { ok: true, agent_handle: 'milo_2' }
      : path.endsWith('/rollback') ? {} : claimed;
    return new Response(JSON.stringify(data));
  }) as typeof fetch;
});

it('finishes only after helper startup and prints the server-assigned name-based handle', async () => {
  await runConnectWizard('ABCD1234-EF567890', fetchImpl, [], undefined);
  expect(requests).toEqual(['/auth/agent/connect','/auth/agent/connect/name','helper-start','/auth/agent/connect/finish']);
  expect(output).toContain('Handle     @milo_2');
});

it('does not register an identity when helper installation fails', async () => {
  fixture.install.mockRejectedValueOnce(new Error('download failed'));
  await expect(runConnectWizard('ABCD1234-EF567890', fetchImpl, [], undefined)).rejects.toThrow('download failed');
  expect(requests).toEqual([]);
});

it('rolls back a claimed identity when helper startup fails, without announcing a join', async () => {
  fixture.start.mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    queueMicrotask(() => child.emit('exit', 1, null)); return child;
  });
  await expect(runConnectWizard('ABCD1234-EF567890', fetchImpl, [], undefined)).rejects.toThrow('exited 1');
  expect(requests).toEqual(['/auth/agent/connect','/auth/agent/connect/name','/v1/auth/daemon/rollback']);
});

it('rolls back when the person cancels the name prompt after claiming', async () => {
  fixture.select.mockResolvedValueOnce(Symbol('cancel'));
  await expect(runConnectWizard('ABCD1234-EF567890', fetchImpl, [], undefined)).rejects.toThrow('Connection cancelled');
  expect(requests).toEqual(['/auth/agent/connect','/v1/auth/daemon/rollback']);
});
