import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { withKernelLock } from './kernel-lock.js';
import { machineControlPath, requestMachine, MachineObservationError, helperAbsent } from './machine-control.js';
import { preparePrivateSocketDirectory } from './local-socket.js';
import { downloadBytes } from './update-download.js';
import { observeChild } from './update-child.js';

it('names a live lock holder and lets only the waiter expire', async () => {
  const lines = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const key = `observer-test-${process.pid}-${Math.random()}`;
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(done => { entered = done; });
  let completed = false;
  const owner = withKernelLock(key, async () => {
    entered();
    await new Promise<void>(done => { release = done; });
    completed = true;
  });
  try {
    await ready;
    await expect(withKernelLock(key, async () => { throw new Error('overlapping owner'); }, 60))
      .rejects.toThrow(`"pid":${process.pid}`);
    expect(completed).toBe(false);
    expect(lines.mock.calls.flat().join('')).toContain('waiting for installer');
    release();
    await owner;
    expect(completed).toBe(true);
  } finally { release?.(); await owner; lines.mockRestore(); }
});

it.each([false, true])('expires a socket observer, responded=%s, without killing the peer', async responded => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-socket-observer-'));
  const path = machineControlPath(root);
  await preparePrivateSocketDirectory(path);
  const server = createServer(peer => {
    peer.on('error', () => {});
    peer.on('data', () => {
      if (responded) peer.write(JSON.stringify({ pid: process.pid, generation: 'live', processState: 'starting', agents: {} }) + '\n');
    });
  });
  await new Promise<void>(done => server.listen(path, done));
  try {
    const error = await requestMachine(root, { operation: 'status' }, () => false, 50).catch(e => e);
    expect(error).toBeInstanceOf(MachineObservationError);
    expect(error.responded).toBe(responded);
    expect(helperAbsent(error)).toBe(!responded);
    expect(server.listening).toBe(true);
  } finally { await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
});

it('distinguishes a protocol error from helper absence', async () => {
  expect(helperAbsent(new Error('invalid helper acknowledgment'))).toBe(false);
});

it.each(['headers', 'body', 'trickle'])('observes a %s download with byte progress', async mode => {
  const server = httpServer((_req, res) => {
    if (mode === 'headers') return;
    res.writeHead(200);
    res.write('a');
    if (mode === 'body') return;
    let count = 0;
    const timer = setInterval(() => {
      res.write('b');
      if (++count === 8) { clearInterval(timer); res.end(); }
    }, 20);
    res.once('close', () => clearInterval(timer));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const lines: string[] = [];
  try {
    const work = downloadBytes(`http://127.0.0.1:${port}/bundle`, fetch, { idleMs: 70, report: line => lines.push(line) });
    if (mode === 'trickle') expect((await work).byteLength).toBe(9);
    else await expect(work).rejects.toThrow(`network ${mode === 'headers' ? 'DNS/connect/headers' : 'body'}`);
    expect(lines[0]).toContain('DNS/connect/headers');
    if (mode !== 'headers') expect(lines.some(line => line.includes('1 bytes'))).toBe(true);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});

it('leaves a dependency owner running when its observer expires', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-child-owner-'));
  const marker = join(root, 'finished');
  try {
    await expect(observeChild({ step: 'dependency install', timeoutMs: 50, env: process.env,
      args: ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'done'), 150)`] }))
      .rejects.toThrow('owner pid');
    await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('done'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('follows successor socket replacement and bounds successor connection loss', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-successor-observer-'));
  const path = machineControlPath(root);
  await preparePrivateSocketDirectory(path);
  const status = (generation: string) => JSON.stringify({ pid: process.pid, generation,
    processState: 'serving', loadedRelease: generation, agents: {} }) + '\n';
  const old = createServer(peer => peer.on('data', () => { peer.end(status('old')); }));
  await new Promise<void>(done => old.listen(path, done));
  const successor = createServer(peer => peer.on('data', () => peer.write(status('target'))));
  let replaced = false;
  const observation = requestMachine(root, { operation: 'update', releaseId: 'target' }, snapshot => {
    if (snapshot.loadedRelease === 'old' && !replaced) {
      replaced = true;
      old.close(() => successor.listen(path));
    }
    return snapshot.loadedRelease === 'target';
  }, 1000);
  try {
    expect((await observation).generation).toBe('target');
    await new Promise<void>(done => successor.close(() => done()));
    await expect(requestMachine(root, { operation: 'update' }, () => true, 50)).rejects.toThrow('observer expired');
  } finally {
    old.close(); successor.close();
    await rm(root, { recursive: true, force: true });
  }
});
