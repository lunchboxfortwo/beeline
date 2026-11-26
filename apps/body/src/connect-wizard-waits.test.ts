import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { collectConnectWizard, isInteractiveConnectTerminal } from './connect-command.js';
import { runInstalledFinish } from './connect-command-parse-connect-subscriptions.js';

const roots: string[] = [];
const pids: number[] = [];
afterEach(async () => {
  // A failed run must not leave the wizard or its adapter behind.
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-connect-waits-'));
  roots.push(root);
  return root;
}
/** A stand-in for the installed `beeline` whose `connect-finish` runs `body`. */
async function fakeBeeline(root: string, body: string): Promise<string> {
  const path = join(root, 'beeline');
  await writeFile(path, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return path;
}

it('streams connect-finish lines while the child runs, and cancel kills its group', async () => {
  const root = await scratch();
  const binary = await fakeBeeline(
    root,
    `console.error('[body] imported provider credentials');
console.log('[body] openrouter routing for z-ai/glm: a, b');
process.stdin.resume(); setInterval(() => {}, 1 << 30);`,
  );
  const cancel = new AbortController();
  const said: string[] = [];
  const finishing = runInstalledFinish(binary, join(root, 'grant.json'), {
    signal: cancel.signal,
    say: (line) => {
      said.push(line);
      // Both lines arrived while the child is still running: cancel now.
      if (said.length === 2) cancel.abort();
    },
  });
  await expect(finishing).rejects.toThrow('cancelled; process group killed');
  expect(said).toEqual(
    expect.arrayContaining([
      '[body] imported provider credentials',
      '[body] openrouter routing for z-ai/glm: a, b',
    ]),
  );
});

it('keeps the connect-finish output tail for the failure message', async () => {
  const root = await scratch();
  const binary = await fakeBeeline(
    root,
    `console.error('Connecting your agent failed: refused'); process.exit(3);`,
  );
  await expect(runInstalledFinish(binary, join(root, 'grant.json'))).rejects.toThrow(
    'installed Beeline exited 3: Connecting your agent failed: refused',
  );
});

it('treats stdout redirected to a file or /dev/null as nobody reading the prompts', async () => {
  const root = await scratch();
  const tty = { isTTY: true };
  const file = openSync(join(root, 'out.txt'), 'w');
  const devNull = openSync('/dev/null', 'w');
  execFileSync('mkfifo', [join(root, 'pipe')]);
  // O_RDWR keeps the open from waiting for a reader.
  const pipe = openSync(join(root, 'pipe'), 'r+');
  try {
    expect(isInteractiveConnectTerminal(tty, { isTTY: false, fd: file })).toBe(false);
    expect(isInteractiveConnectTerminal(tty, { isTTY: false, fd: devNull })).toBe(false);
    // A mobile terminal shell that proxies stdout through its UI still reaches a person.
    expect(isInteractiveConnectTerminal(tty, { isTTY: false, fd: pipe })).toBe(true);
    expect(isInteractiveConnectTerminal(tty, { isTTY: true, fd: file })).toBe(true);
    expect(isInteractiveConnectTerminal({ isTTY: undefined }, { isTTY: true, fd: pipe })).toBe(
      false,
    );
  } finally {
    for (const fd of [file, devNull, pipe]) closeSync(fd);
  }
});

it('opens the harness picker without running a slow agy on PATH', async () => {
  const root = await scratch();
  const marker = join(root, 'agy-ran');
  await writeFile(
    join(root, 'agy'),
    `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(marker)}, '');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
console.log('Available subcommands:\\n  acp   Start ACP');
`,
    { mode: 0o755 },
  );
  vi.stubEnv('PATH', root);
  vi.stubEnv('BEELINE_HARNESS_PATH_AUGMENT', '0');
  const cancelled = new Error('Stop at the harness picker');
  const select = vi.fn().mockRejectedValue(cancelled);
  try {
    await expect(
      collectConnectWizard({ select, autocomplete: vi.fn(), text: vi.fn(), password: vi.fn() }),
    ).rejects.toBe(cancelled);
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Choose harness',
        options: expect.arrayContaining([expect.objectContaining({ value: 'antigravity' })]),
      }),
    );
    expect(existsSync(marker)).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});

it('SIGINT during the harness probe stops the silent adapter and ends the wizard as cancelled', async () => {
  const root = await scratch();
  const adapter = join(root, 'silent-adapter.mjs');
  // Reads ACP requests and never answers: `initialize` would wait forever.
  await writeFile(
    adapter,
    'process.stderr.write(`pid ${process.pid}\\n`); process.stdin.resume();\n',
  );
  const entry = join(root, 'entry.mjs');
  const register = createRequire(import.meta.url).resolve('tsx/esm/api');
  const connect = fileURLToPath(new URL('./connect-command.ts', import.meta.url));
  const acp = fileURLToPath(new URL('./acp.ts', import.meta.url));
  await writeFile(
    entry,
    `import { register } from ${JSON.stringify(register)};
register();
const { collectConnectWizard, loadConnectModelCatalog } = await import(${JSON.stringify(connect)});
const { AcpClient } = await import(${JSON.stringify(acp)});
const prompts = { select: async () => 'codex', autocomplete: async () => 'x', text: async () => 'x', password: async () => 'x' };
const loadModels = (input) => loadConnectModelCatalog(input, {
  refreshAdapter: async () => undefined,
  resolveAgent: () => ({ kind: 'codex', command: process.execPath, args: [] }),
  fetchCatalog: async () => {
    const client = new AcpClient({ agentCommand: process.execPath, agentArgs: [${JSON.stringify(adapter)}],
      agentEnv: {}, inheritProcessEnv: true, resourceScope: 'none' });
    client.on('stderr', (chunk) => console.log('adapter ' + chunk.trim()));
    await client.startProcess();
    return { raw: [], catalog: [] };
  },
});
try {
  await collectConnectWizard(prompts, loadModels, undefined, { NO_COLOR: '1' }, undefined,
    { checkProgram: () => {}, announce: () => {} });
  console.log('wizard went on');
} catch (error) { console.log('ended: ' + error.message); }
`,
  );
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_STATE_HOME: join(root, 'state'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pids.push(child.pid!);
  let stdout = '';
  let adapterPid = 0;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    const match = /adapter pid (\d+)/.exec(stdout);
    if (match && !adapterPid) {
      adapterPid = Number(match[1]);
      pids.push(adapterPid);
      child.kill('SIGINT');
    }
  });
  const exit = await new Promise<number | null>((resolve) =>
    child.on('exit', (code) => resolve(code)),
  );
  expect(stdout).toContain('ended: Connection cancelled.');
  expect(stdout).not.toContain('wizard went on');
  expect(exit).toBe(0);
  expect(adapterPid).toBeGreaterThan(0);
  expect(() => process.kill(adapterPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
});

it('does not spawn after cancellation during ACP startup preparation', async () => {
  const root = await scratch();
  const marker = join(root, 'spawned');
  const { AcpClient } = await import('./acp.js');
  const { startAgentProcess } = await import('./agent-process.js');
  let resume!: () => void;
  const priming = new Promise<void>((done) => {
    resume = done;
  });
  const client = new AcpClient({
    agentCommand: process.execPath,
    agentArgs: [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'spawned'); process.exit(1);`,
    ],
    agentEnv: {},
    resourceScope: 'none',
    oomKills: { prime: () => priming, consume: async () => false },
  });
  const cancel = new AbortController();
  const starting = startAgentProcess(client, cancel.signal);
  cancel.abort();
  resume();
  await expect(starting).rejects.toBe(cancel.signal.reason);
  expect(existsSync(marker)).toBe(false);
});

it('carries connect cancellation through the real catalog startup', async () => {
  const root = await scratch();
  const marker = join(root, 'catalog-spawned');
  const { loadConnectModelCatalog } = await import('./connect-command.js');
  const { fetchAgentModelCatalog } = await import('./model-catalog.js');
  const cancel = new AbortController();
  const catalog = loadConnectModelCatalog(
    { harness: 'codex', signal: cancel.signal },
    {
      refreshAdapter: async () => {},
      resolveAgent: () => ({
        kind: 'codex',
        command: process.execPath,
        args: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},'spawned'); process.exit(1);`,
        ],
      }),
      fetchCatalog: (agent, env, selection, signal) => {
        cancel.abort();
        return fetchAgentModelCatalog(agent, env, selection, signal);
      },
    },
  );
  const error = await catalog.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  // The abort happens inside the catalog fetch, so read its reason only after the rejection.
  expect(error).toBe(cancel.signal.reason);
  expect(error).toBeDefined();
  expect(existsSync(marker)).toBe(false);
});
