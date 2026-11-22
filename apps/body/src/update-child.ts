import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { progress } from './update-progress.js';

/** A detached owner writes to files so an observer may leave without breaking its pipes. */
export async function observeChild(options: {
  step: string;
  forwardStdout?: boolean;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'beeline-update-'));
  const outPath = join(directory, 'stdout');
  const errPath = join(directory, 'stderr');
  const out = await open(outPath, 'w+');
  const err = await open(errPath, 'w+');
  progress(`${options.step}; logs ${directory}`);
  const child = spawn(process.execPath, options.args, {
    detached: true, env: options.env, stdio: ['ignore', out.fd, err.fd],
  });
  void out.close();
  void err.close();
  return new Promise<string>((resolve, reject) => {
    let lastProgress = 'waiting for child output';
    let offset = 0;
    let outOffset = 0;
    let streaming = Promise.resolve();
    let settled = false;
    const forward = async (path: string, position: number): Promise<number> => {
      const file = await open(path, 'r');
      try {
        const end = (await file.stat()).size;
        const buffer = Buffer.alloc(16_384);
        while (position < end) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, end - position), position);
          if (!bytesRead) break;
          position += bytesRead;
          lastProgress = buffer.subarray(0, bytesRead).toString('utf8').trim().split('\n').at(-1)!.slice(-500);
          process.stderr.write(buffer.subarray(0, bytesRead));
        }
        return position;
      } finally { await file.close(); }
    };
    const readProgress = async () => {
      offset = await forward(errPath, offset);
      if (options.forwardStdout) outOffset = await forward(outPath, outOffset);
    };
    const stream = () => streaming = streaming.then(readProgress);
    const stop = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      child.unref();
      if (error) reject(error); else resolve(output!);
    };
    const abort = () => stop(new Error(`${options.step}: observer stopped; owner pid ${child.pid} continues; last progress: ${lastProgress}; logs ${directory}`));
    const heartbeat = setInterval(() => {
      progress(`${options.step}; owner pid ${child.pid}; still working`);
      void stream().catch(error => stop(new Error(`${options.step}: reading progress: ${String(error)}`)));
    }, 1000);
    const timer = setTimeout(abort, options.timeoutMs ?? 600_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => stop(new Error(`${options.step}: ${error.message}`)));
    child.once('exit', code => {
      if (settled) return;
      void (async () => {
        await stream();
        if (code !== 0) throw new Error(`${options.step}: child exited ${code}; logs ${directory}`);
        stop(undefined, options.forwardStdout ? '' : await readFile(outPath, 'utf8'));
      })().catch(error => stop(error));
    });
    if (options.signal?.aborted) abort();
  });
}
