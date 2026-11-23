import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommandGrantTarget } from '@beeline/api-contract/agent-grants';
import { GrantCommandRunner, type GrantCommandRunnerOptions } from './grant-runner.js';
import { readGrantScript } from './read-only-mcp-agent-grant-deps.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function run(
  scriptText: string,
  options: Partial<GrantCommandRunnerOptions> = {},
  useStdin = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'grant-execution-'));
  roots.push(root);
  const argv = useStdin ? ['node', '-'] : ['node', '-e', scriptText];
  const stdin = useStdin ? scriptText : undefined;
  const target = JSON.stringify({ argv, ...(useStdin ? { stdin } : {}) });
  const script = readGrantScript(parseCommandGrantTarget(target), {
    roomId: 'room',
    scriptRoots: [root],
    scriptEnv: { PATH: process.env.PATH },
    execute: async () => ({}),
  });
  const grants = [
    {
      grantId: 'approved',
      workspaceId: 'workspace',
      kind: 'command',
      target,
      status: 'approved',
      requestedBy: 'owner',
      script,
    },
  ];
  const runner = new GrantCommandRunner({
    agentId: 'agent',
    env: { PATH: process.env.PATH, HOME: root },
    ...options,
    api: {
      execute: async (operation: string) => (operation === 'listTurnAgentGrants' ? { grants } : {}),
    } as never,
  });
  runner.register('room', {
    workspaceId: 'workspace',
    cwd: root,
    turn: () => ({ requestId: 'request' }),
    writePolicy: () => ({ surface: 'corner' }),
  });
  return runner.run({ roomId: 'room', argv, stdin });
}

// Runner contract: approved argv receives stdin, returns stdout then stderr,
// and preserves the command's exit status (rather than reporting spawn success).
it('preserves granted command stdin, Unicode output, stderr and nonzero exit status', async () => {
  const result = await run(
    'process.stdout.write("hello 🐝"); process.stderr.write("diagnostic"); process.exitCode = 7;',
    {},
    true,
  );
  expect(result).toMatchObject({ exitCode: 7, timedOut: false, output: 'hello 🐝\ndiagnostic' });
  expect(result.signal).toBeUndefined();
});

// Runner limits must terminate commands instead of waiting indefinitely or
// buffering unbounded data. These commands never exit without intervention.
it('terminates a granted command at its deadline', async () => {
  const result = await run('setInterval(() => {}, 1000)', { timeoutMs: 200 });
  expect(result).toMatchObject({ exitCode: null, signal: 'SIGKILL', timedOut: true });
});

it('terminates and caps a granted command that floods output', async () => {
  const result = await run('setInterval(() => process.stdout.write("x".repeat(8192)), 1)', {
    outputCapBytes: 128,
  });
  expect(result).toMatchObject({ exitCode: null, signal: 'SIGKILL', timedOut: false });
  expect(result.output).toContain('bytes omitted');
  expect(result.output.length).toBeLessThan(256);
});

// A killed process is gone or a zombie awaiting its (re)parent's reap.
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  return /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
};
// Repro G: the direct child exited at once while a grandchild held stdout, and
// the runner waited for that grandchild's `close` (12 s in the audit).
it.skipIf(process.platform !== 'linux')(
  'settles when the granted command exits, killing a grandchild that holds its output',
  async () => {
    const started = Date.now();
    const result = await run(
      'const c = require("node:child_process").spawn("sleep", ["30"], { stdio: ["ignore", "inherit", "inherit"] }); c.unref(); console.log(c.pid);',
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(gone(Number(result.output.trim()))).toBe(true);
  },
);

it.skipIf(process.platform !== 'linux')(
  'the time limit kills the whole process group, not only the direct child',
  async () => {
    const result = await run(
      'const c = require("node:child_process").spawn("sleep", ["30"], { stdio: ["ignore", "inherit", "inherit"] }); console.log(c.pid); setInterval(() => {}, 1000);',
      { timeoutMs: 300 },
    );
    expect(result).toMatchObject({ exitCode: null, signal: 'SIGKILL', timedOut: true });
    expect(gone(Number(result.output.trim()))).toBe(true);
  },
);
