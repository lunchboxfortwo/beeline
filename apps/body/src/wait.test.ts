import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { KernelLockBusyError, withKernelLock } from './kernel-lock.js';
import { preparePrivateSocketDirectory } from './local-socket.js';
import {
  askMachine,
  followHelperExit,
  helperAbsent,
  helperLockKey,
  machineControlPath,
} from './machine-control.js';
import { downloadBytes } from './update-download.js';
import { ask, PeerRefusal, runOwned, tryLock } from './wait.js';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function machineSocket(onConnection: (peer: import('node:net').Socket) => void) {
  const root = await mkdtemp(join(tmpdir(), 'beeline-wait-'));
  const path = machineControlPath(root);
  await preparePrivateSocketDirectory(path);
  const server = createServer((peer) => {
    peer.on('error', () => undefined);
    onConnection(peer);
  });
  await new Promise<void>((done) => server.listen(path, done));
  return {
    root,
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

it('reports a busy lock at once with its holder instead of queueing behind it', async () => {
  // Audit repro: a lock held by a scratch socket left "waiting for installer…" forever.
  const key = `wait-test-${process.pid}-${Math.random()}`;
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((done) => {
    entered = done;
  });
  const owner = withKernelLock(
    key,
    async () => {
      entered();
      await new Promise<void>((done) => {
        release = done;
      });
    },
    { step: 'adapter refresh', log: '/tmp/owner.log' },
  );
  try {
    await ready;
    const error = await withKernelLock(key, async () => 'second').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KernelLockBusyError);
    expect(String(error)).toContain(`adapter refresh already running as pid ${process.pid}`);
    expect(String(error)).toContain('log /tmp/owner.log');
    const busy = await tryLock(key);
    expect(busy.held).toBe(false);
    if (busy.held) throw new Error('unreachable');
    // Following the holder ends on the kernel's close, never on a timer.
    const followed = busy.released();
    release();
    await owner;
    await followed;
    const free = await tryLock(key);
    expect(free.held).toBe(true);
    if (free.held) await free.release();
  } finally {
    release?.();
    await owner;
  }
});

it.each([
  ['a missing socket', 'none'],
  ['a peer that accepts and closes without answering', 'close'],
])('fails a helper request at once on %s', async (_name, mode) => {
  // Audit repro: `stop --agent` against no socket and against accept-then-close ran out its 90 s.
  if (mode === 'none') {
    const root = await mkdtemp(join(tmpdir(), 'beeline-wait-'));
    try {
      const error = await askMachine(root, { operation: 'stop', agentId: 'a' }).catch(
        (e: unknown) => e,
      );
      expect(helperAbsent(error)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    return;
  }
  const socket = await machineSocket((peer) => peer.on('data', () => peer.end()));
  try {
    await expect(askMachine(socket.root, { operation: 'stop', agentId: 'a' })).rejects.toThrow(
      'closed the connection before answering',
    );
  } finally {
    await socket.close();
  }
});

it("settles on the helper's one answer and surfaces its refusal", async () => {
  const status = {
    pid: process.pid,
    generation: 'g',
    processState: 'serving',
    updatedAt: 'now',
    agents: { a: { state: 'starting', status: '', since: 'then' } },
  };
  // An agent stuck in `starting` is reported, never waited on.
  const answering = await machineSocket((peer) =>
    peer.on('data', () => peer.end(`${JSON.stringify(status)}\n`)),
  );
  try {
    const answer = await askMachine(answering.root, { operation: 'converge' });
    expect(answer.agents.a?.state).toBe('starting');
  } finally {
    await answering.close();
  }
  const refusing = await machineSocket((peer) =>
    peer.on('data', () => peer.end('{"error":"generation mismatch"}\n')),
  );
  try {
    const error = await askMachine(refusing.root, { operation: 'update', releaseId: 'r' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PeerRefusal);
    expect(String(error)).toContain('generation mismatch');
    expect(helperAbsent(error)).toBe(false);
  } finally {
    await refusing.close();
  }
});

it("reports download bytes and fails on the transport's explicit close", async () => {
  const server = httpServer((req, res) => {
    res.writeHead(200);
    if (req.url === '/cut') {
      res.write('a', () => setImmediate(() => res.socket?.destroy()));
      return;
    }
    res.write('a');
    res.end('bcd');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const lines: string[] = [];
  try {
    expect(
      (
        await downloadBytes(`http://127.0.0.1:${port}/ok`, fetch, {
          report: (line) => lines.push(line),
        })
      ).byteLength,
    ).toBe(4);
    expect(lines[0]).toContain(`waiting for 127.0.0.1:${port}`);
    expect(lines.some((line) => line.includes('4 bytes'))).toBe(true);
    await expect(
      downloadBytes(`http://127.0.0.1:${port}/cut`, fetch, { report: () => undefined }),
    ).rejects.toThrow('network body');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

it('settles an owned child on exit even while a grandchild holds its pipes', async () => {
  // Audit repro G: `exit` at +7 ms, `close` at +12 s because a grandchild kept stdout open.
  const started = Date.now();
  const lines: string[] = [];
  const result = await runOwned({
    step: 'grandchild holder',
    file: process.execPath,
    args: [
      '-e',
      `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'inherit' }).unref();
      console.error('child progress'); console.log('{"ok":true}');`,
    ],
    onLine: (line) => lines.push(line),
  });
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true });
  expect(lines).toContain('child progress');
});

it('kills the owned process group when the caller leaves', async () => {
  const controller = new AbortController();
  const lines: string[] = [];
  const work = runOwned({
    step: 'cancelled owner',
    file: process.execPath,
    args: [
      '-e',
      `const g=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});
      console.error('grandchild '+g.pid); setTimeout(()=>{},60000);`,
    ],
    onLine: (line) => {
      lines.push(line);
      if (line.startsWith('grandchild')) controller.abort();
    },
    signal: controller.signal,
  });
  await expect(work).rejects.toThrow('cancelled; process group killed');
  const grandchild = Number(lines.find((line) => line.startsWith('grandchild'))!.split(' ')[1]);
  await vi.waitFor(() => expect(alive(grandchild)).toBe(false));
});

it('leaves no orphan when the owning command exits', async () => {
  // Audit repro: the observer left at 75 s and `npm install` was re-parented to PID 1, still running at 759 s.
  const owner = `import { runOwned } from ${JSON.stringify(resolve(__dirname, 'wait.ts'))};
    void runOwned({ step: 'install', file: process.execPath, args: ['-e', "console.log(process.pid); setTimeout(()=>{},60000)"],
      onLine: (line) => { console.log(line); setImmediate(() => process.exit(3)); } });`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', owner], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((done) => child.once('exit', done));
  expect(code).toBe(3);
  const installer = Number(output.trim().split('\n')[0]);
  expect(installer).toBeGreaterThan(0);
  await vi.waitFor(() => expect(alive(installer)).toBe(false));
});

it('ends a linked worker and its group when the owner is SIGKILLed', async () => {
  // Proof finding: a SIGKILLed `beeline update` left its preparation worker holding the install lock.
  const worker = `import { exitWithOwner } from ${JSON.stringify(resolve(__dirname, 'owner-link.ts'))};
    exitWithOwner();
    const g = (await import('node:child_process')).spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
    console.log(process.pid + ' ' + g.pid); setInterval(() => {}, 1000);`;
  const owner = `import { runOwned } from ${JSON.stringify(resolve(__dirname, 'wait.ts'))};
    void runOwned({ step: 'worker', file: process.execPath, ownerLink: true,
      args: ['--import', 'tsx', '--input-type=module', '-e', ${JSON.stringify(worker)}],
      onLine: (line) => console.log(line) });`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', owner], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  const pids = new Promise<number[]>((done) =>
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      if (output.includes('\n')) done(output.trim().split(/\s+/).map(Number));
    }),
  );
  const [linked, grandchild] = await pids;
  child.kill('SIGKILL');
  await vi.waitFor(() => {
    expect(alive(linked!)).toBe(false);
    expect(alive(grandchild!)).toBe(false);
  });
});

it('follows the recorded holder connection even if a successor binds before following', async () => {
  const key = `lock-successor-${process.pid}-${Math.random()}`;
  const owner = await tryLock(key);
  if (!owner.held) throw new Error('expected owner');
  const follower = await tryLock(key);
  if (follower.held) throw new Error('expected follower');
  await owner.release();
  const successor = await tryLock(key);
  if (!successor.held) throw new Error('expected successor');
  try {
    await follower.released();
  } finally {
    await successor.release();
  }
});

it('does not follow a successor helper generation after an acknowledged handoff', async () => {
  const root = `helper-successor-${process.pid}-${Math.random()}`;
  const successor = await tryLock(helperLockKey(root), { generation: 'successor' });
  if (!successor.held) throw new Error('expected successor');
  try {
    await followHelperExit(root, { pid: process.pid, generation: 'predecessor' });
  } finally {
    await successor.release();
  }
});

it('a nested owner settles when its own child exits with a background pipe holder', async () => {
  const worker = `import { runOwned } from ${JSON.stringify(resolve(__dirname, 'wait.ts'))};
    const result = await runOwned({ step: 'nested install', file: process.execPath,
      args: ['-e', "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}).unref(); console.log('done');"],
      onLine: () => {} });
    console.log(result.stdout.trim());`;
  const result = await runOwned({
    step: 'worker',
    file: process.execPath,
    args: ['--import', 'tsx', '--input-type=module', '-e', worker],
    onLine: () => {},
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe('done\n');
});

it('returns every stdout and stderr byte written before child exit', async () => {
  const count = 1024 * 1024;
  const result = await runOwned({
    step: 'complete pipe output',
    file: process.execPath,
    args: [
      '-e',
      `const fs=require('node:fs');
      for (const fd of [1,2]) { const bytes=Buffer.from(String(fd).repeat(${count})+'TAIL'+fd); let n=0;
        while(n<bytes.length)n+=fs.writeSync(fd,bytes,n); }`,
    ],
    onLine: () => {},
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe('1'.repeat(count) + 'TAIL1');
  expect(result.stderr).toBe('2'.repeat(count) + 'TAIL2');
});

it('follows an acknowledged legacy helper whose lock record has no generation', async () => {
  const root = `legacy-helper-${process.pid}-${Math.random()}`;
  const owner = await tryLock(helperLockKey(root));
  if (!owner.held) throw new Error('expected owner');
  let settled = false;
  const followed = followHelperExit(root, { pid: process.pid, generation: 'legacy' }).then(() => {
    settled = true;
  });
  try {
    for (let i = 0; i < 8; i++) await new Promise<void>((done) => setImmediate(done));
    expect(settled).toBe(false);
  } finally {
    await owner.release();
  }
  await followed;
  expect(settled).toBe(true);
});

it('names the peer of every wait on stderr unless the output is machine-read', async () => {
  const server = httpServer((_req, res) => res.end('ok'));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await (await ask({ url: `http://127.0.0.1:${port}/human` })).text();
    await (await ask({ url: `http://127.0.0.1:${port}/tool`, machineRead: true })).text();
    const lines = writes.mock.calls.map(([chunk]) => String(chunk));
    expect(lines).toContain(`[beeline] waiting for 127.0.0.1:${port} (GET /human)\n`);
    expect(lines.some((line) => line.includes('/tool'))).toBe(false);
  } finally {
    writes.mockRestore();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
