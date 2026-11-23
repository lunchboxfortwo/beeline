import { spawn } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { identityFromKey, writeRuntimeRecord } from './runtime.js';

const AGENT = 'ab'.repeat(32);
const TOKEN = `bdt_${'a'.repeat(43)}`;
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-storage-waits-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A local server; `answer` undefined means it accepts and never responds. */
async function server(
  answer?: (path: string) => unknown,
): Promise<{ baseUrl: string; host: string }> {
  const held: ServerResponse[] = [];
  const http: Server = createServer((request, response) => {
    if (!answer) {
      held.push(response);
      return;
    }
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(answer(request.url!)));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const response of held) response.destroy();
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  );
  const host = `127.0.0.1:${(http.address() as { port: number }).port}`;
  return { baseUrl: `http://${host}`, host };
}

/** Run `call` from `module` in a child with an isolated HOME/XDG tree. */
function runChild(root: string, module: string, call: string) {
  const entry = join(root, 'entry.mjs');
  const register = createRequire(import.meta.url).resolve('tsx/esm/api');
  const source = fileURLToPath(new URL(module, import.meta.url));
  const written = writeFile(
    entry,
    `import { register } from ${JSON.stringify(register)};
register();
const m = await import(${JSON.stringify(source)});
${call}
`,
  );
  return written.then(() => {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_STATE_HOME: join(root, 'state'),
        BEELINE_SENTRY_DSN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cleanup.push(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    const output = { stdout: '', stderr: '' };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output.stdout += chunk));
    const stderrLines: Array<(text: string) => void> = [];
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output.stderr += chunk;
      for (const listener of stderrLines) listener(output.stderr);
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.on('exit', (code, signal) => resolve({ code, signal })),
    );
    return {
      child,
      output,
      exited,
      onStderr: (listener: (text: string) => void) => stderrLines.push(listener),
    };
  });
}

async function storageFixture(root: string, baseUrl: string): Promise<void> {
  const runtimeDir = join(root, 'state', 'beeline', 'agents', AGENT);
  await mkdir(join(runtimeDir, 'rooms', 'room-1'), { recursive: true });
  await writeFile(
    join(runtimeDir, 'runtime.json'),
    JSON.stringify({
      agent: { publicKey: AGENT },
      communityId: 'ws',
      transport: { baseUrl, daemonToken: TOKEN },
    }),
  );
}

it('storage names the host and step before a silent read, and Ctrl-C ends it', async () => {
  const root = await scratch();
  const { baseUrl, host } = await server();
  await storageFixture(root, baseUrl);
  const run = await runChild(
    root,
    './storage-report.ts',
    `await m.runStorageReportCommand(['--orphans']);`,
  );
  const line = `[beeline] waiting for ${host} for agent ${AGENT.slice(0, 12)} (POST /v1/daemon/operations/getDaemonBootstrap)`;
  run.onStderr((text) => {
    if (text.includes(line)) run.child.kill('SIGINT');
  });
  expect(await run.exited).toEqual({ code: null, signal: 'SIGINT' });
  expect(run.output.stderr).toContain(line);
  expect(run.output.stdout).toBe('');
});

it('storage reports each sequential read on stderr and keeps stdout one JSON report', async () => {
  const root = await scratch();
  const { baseUrl, host } = await server((path) =>
    path.endsWith('/getDaemonBootstrap')
      ? { rooms: [{ roomId: 'room-1' }], workspaceIds: ['ws'] }
      : { corners: [{ cornerId: 'room-1', archived: true }] },
  );
  await storageFixture(root, baseUrl);
  const run = await runChild(
    root,
    './storage-report.ts',
    `await m.runStorageReportCommand(['--orphans']);`,
  );
  expect(await run.exited).toEqual({ code: 0, signal: null });
  expect(run.output.stderr).toContain(
    `[beeline] waiting for ${host} for agent ${AGENT.slice(0, 12)} (POST /v1/daemon/operations/getDaemonBootstrap)`,
  );
  expect(run.output.stderr).toContain(
    `[beeline] waiting for ${host} for room room-1 (POST /v1/daemon/operations/listRoomCorners)`,
  );
  expect(run.output.stderr).toContain('[storage dry-run] running /usr/bin/python3 (payload scan)');
  expect(JSON.parse(run.output.stdout)).toEqual({
    mode: 'dry-run',
    orphans: [
      {
        path: join(root, 'state', 'beeline', 'agents', AGENT, 'rooms', 'room-1'),
        owner: 'room-1',
        reason: 'server-confirmed archived Room/corner',
      },
    ],
    unknown: [],
    archivedCheckouts: [],
  });
});

it('corner-read-token names the host and step before a silent read, and Ctrl-C ends it', async () => {
  const root = await scratch();
  const { baseUrl, host } = await server();
  const identity = identityFromKey('01'.repeat(32), 'fixture');
  const configPath = await writeRuntimeRecord({
    version: 2,
    supervisorRoot: root,
    communityId: 'fixture',
    pairedBy: 'fixture',
    agent: { name: 'fixture', secretKeyHex: '01'.repeat(32), publicKey: identity.publicKey },
    body: { name: 'fixture', secretKeyHex: '01'.repeat(32), publicKey: identity.publicKey },
    rooms: [],
    agentBinary: 'unused',
    mcpBinary: 'unused',
    transport: { kind: 'monolith', baseUrl, daemonToken: TOKEN },
  });
  const run = await runChild(
    root,
    './daemon-api-client.ts',
    `await m.DaemonApiClient.readRepositoryCredential(${JSON.stringify(configPath)}, 'fixture-room');`,
  );
  const line = `[beeline] waiting for ${host} (POST /v1/daemon/operations/getRoomGitHubToken)`;
  run.onStderr((text) => {
    if (text.includes(line)) run.child.kill('SIGINT');
  });
  expect(await run.exited).toEqual({ code: null, signal: 'SIGINT' });
  expect(run.output.stderr).toContain(line);
});
