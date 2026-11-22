import { progress } from './update-progress.js';
import { createHash } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';

class KernelLockBusyError extends Error {
  constructor(holder = 'unknown') { super(`installer lock observer expired; holder ${holder}; owner was not stopped`); }
}

/** Cache reuse is optional: never queue a serving agent behind its owner. */
export async function tryWithKernelLock<T>(key: string, work: () => Promise<T>): Promise<T | undefined> {
  let entered = false;
  try {
    return await withKernelLock(key, () => { entered = true; return work(); }, 0);
  } catch (error) {
    if (!entered && error instanceof KernelLockBusyError) return undefined;
    throw error;
  }
}

/** A kernel-owned local socket is released on process death, with no stale-age takeover. */
export async function withKernelLock<T>(
  key: string,
  work: () => Promise<T>,
  waitMs = 600_000,
): Promise<T> {
  const hash = createHash('sha256').update(key).digest();
  // Linux abstract sockets have no stale filesystem inode and cannot collide
  // with HTTP fixture ports. Node supports them from 20.8 (our minimum is 20.11).
  // macOS uses loopback ports below its ephemeral range; hash collisions only
  // serialize otherwise unrelated owners rather than granting duplicate ownership.
  const address =
    process.platform === 'linux'
      ? { path: `\0beeline-lock-${hash.toString('hex')}` }
      : { port: 20_000 + (hash.readUInt32BE(0) % 10_000), host: '127.0.0.1' };
  const deadline = Date.now() + waitMs;
  let holder = `lock ${key}`;
  for (;;) {
    const peers = new Set<Socket>();
    const since = new Date().toISOString();
    const server = createServer((peer) => {
      peers.add(peer);
      peer.write(JSON.stringify({ pid: process.pid, key, since }) + '\n');
      peer.on('error', () => undefined);
      peer.once('close', () => peers.delete(peer));
    });
    const acquired = await new Promise<boolean>((done, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) =>
        error.code === 'EADDRINUSE' ? done(false) : reject(error),
      );
      server.listen(address, () => done(true));
    });
    if (acquired) {
      try {
        return await work();
      } finally {
        for (const peer of peers) peer.destroy();
        await new Promise<void>((done) => server.close(() => done()));
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new KernelLockBusyError(holder);
    // Wait for owner death/completion on the connection, rather than rereading a lock file.
    progress(`waiting for installer ${holder}`);
    await new Promise<void>((done) => {
      const peer = createConnection(address);
      // Consume EOF so a completed owner's connection closes. A paused
      // client can otherwise keep a Linux abstract address referenced after
      // the listener has gone, preventing the next owner from binding it.
      peer.setEncoding('utf8');
      peer.on('data', (chunk: string) => { holder = chunk.trim().slice(0, 1024); progress(`installer held by ${holder}`); });
      const heartbeat = setInterval(() => progress(`waiting for installer ${holder}`), 5000);
      const timer = setTimeout(() => finish(), remaining);
      const finish = () => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        peer.destroy();
        done();
      };
      peer.once('close', finish);
      peer.once('error', finish); // Owner disappeared between bind and connect.
    });
  }
}
