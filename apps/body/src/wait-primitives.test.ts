import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserShareHost, startHostedBrowserShare } from './browser-share-host.js';
import { createHash } from 'node:crypto';
import {
  followHelperExit,
  helperLockKey,
  MachineControl,
  type MachineAnswer,
} from './machine-control.js';
import { postToClaude } from './session-join/claude.js';
import {
  answer,
  ask,
  connect,
  launchDetached,
  listen,
  onEnd,
  ownedCommandModule,
  watchChanges,
} from './wait.js';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'beeline-wait-primitives-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
/** A local server whose handler the test drives; closed (with its peers) after the test. */
async function server(onConnection: (peer: Socket) => void, path?: string) {
  const at = path ?? join(await scratch(), 'peer.sock');
  const peers = new Set<Socket>();
  const fixture = createServer({ allowHalfOpen: true }, (peer) => {
    peers.add(peer);
    peer.on('error', () => undefined);
    onConnection(peer);
  });
  await new Promise<void>((done) => fixture.listen(at, done));
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        for (const peer of peers) peer.destroy();
        fixture.close(() => done());
      }),
  );
  return at;
}

it('answer settles once on its own reply and removes every listener', async () => {
  const channel = new EventEmitter();
  const reply = answer<number>(
    'peer',
    [
      [channel, 'close'],
      [channel, 'error'],
    ],
    ({ resolve }) => {
      channel.once('reply', resolve);
    },
  );
  channel.emit('reply', 7);
  channel.emit('close');
  await expect(reply).resolves.toBe(7);
  expect(channel.listenerCount('close')).toBe(0);
  expect(channel.listenerCount('error')).toBe(0);
});

it("answer fails on the channel's end event, with its error or a named one", async () => {
  const channel = new EventEmitter();
  const closed = answer('json-rpc peer', [
    [channel, 'close'],
    [channel, 'error'],
  ]);
  channel.emit('close');
  await expect(closed).rejects.toMatchObject({
    message: 'json-rpc peer closed before answering',
    code: 'ECONNRESET',
  });
  const errored = answer('json-rpc peer', [[channel, 'error']]);
  channel.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
  await expect(errored).rejects.toMatchObject({ code: 'EPIPE' });
  const mapped = answer('runtime', [
    [channel, 'exit', (code: number) => new Error(`exited ${code}`)],
  ]);
  channel.emit('exit', 3);
  await expect(mapped).rejects.toThrow('exited 3');
  const ended = answer<boolean>('flush', [[channel, 'close', 'answer']]);
  channel.emit('close', true);
  await expect(ended).resolves.toBe(true);
});

it('answer sees an end that already happened, and a failure thrown by start', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((done) => child.once('exit', done));
  // The exit is latched: registering after it still fails the wait at once.
  await expect(answer('runtime', [[child, 'exit']])).rejects.toThrow(
    'runtime: exit before answering',
  );
  const controller = new AbortController();
  controller.abort(new Error('turn cancelled'));
  const started = vi.fn();
  await expect(answer('peer', [controller.signal], started)).rejects.toThrow('turn cancelled');
  expect(started).not.toHaveBeenCalled();
  await expect(
    answer('peer', [], () => {
      throw new Error('send failed');
    }),
  ).rejects.toThrow('send failed');
});

it('answer ends on a later abort and removes its abort listener', async () => {
  const controller = new AbortController();
  const add = vi.spyOn(controller.signal, 'addEventListener');
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const parked = answer('runner wake', [controller.signal]);
  controller.abort();
  await expect(parked).rejects.toThrow();
  expect(add).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledTimes(1);
});

it('onEnd runs once across its events and drops the siblings', () => {
  const channel = new EventEmitter();
  const seen: string[] = [];
  onEnd(channel, ['end', 'close', 'error'], (event) => seen.push(event));
  channel.emit('end');
  channel.emit('close');
  expect(seen).toEqual(['end']);
  expect(channel.listenerCount('close') + channel.listenerCount('error')).toBe(0);
  const off = onEnd(channel, ['close'], () => seen.push('late'));
  off();
  channel.emit('close');
  expect(seen).toEqual(['end']);
});

it('listen reports a taken address, and close is not held by an idle peer', async () => {
  const path = join(await scratch(), 'listen.sock');
  const first = await listen(createServer(), path);
  await expect(listen(createServer(), path)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  // An audit probe: a peer that connects and never finishes its request held server.close().
  const idle = await connect(path, { peer: 'test listener' });
  idle.on('error', () => undefined);
  idle.write('{"partial":');
  await first.close();
  await first.close();
  expect(
    idle.destroyed || (await new Promise((done) => idle.once('close', done))) !== undefined,
  ).toBe(true);
});

it('listen binds loopback TCP port zero', async () => {
  const tcp = createServer((peer) => peer.end('hi'));
  const bound = await listen(tcp, { port: 0, host: '127.0.0.1' });
  const address = tcp.address();
  if (!address || typeof address === 'string') throw new Error('no TCP address');
  const socket = await connect({ host: '127.0.0.1', port: address.port }, { peer: 'loopback' });
  socket.destroy();
  await bound.close();
});

it('connect fails with the transport error and can be abandoned', async () => {
  const missing = join(await scratch(), 'missing.sock');
  await expect(connect(missing, { peer: 'broker' })).rejects.toMatchObject({ code: 'ENOENT' });
  const path = await server(() => undefined);
  const controller = new AbortController();
  controller.abort(new Error('link stopped'));
  await expect(connect(path, { peer: 'broker', signal: controller.signal })).rejects.toThrow(
    'link stopped',
  );
});

it.runIf(process.platform !== 'win32')(
  'a failed socket preserves native errno and its readiness probe exits cleanly',
  () => {
    // An overlong Unix address fails synchronously on newer Node versions,
    // but older versions truncate it and report ENOENT asynchronously. Native
    // createConnection supplies the errno oracle for the current runtime.
    // The public probe must return false without an unhandled error killing it.
    const script = `import { connect } from ${JSON.stringify(resolve(__dirname, 'wait.ts'))};
      import { squireBrokerSocketReady } from ${JSON.stringify(resolve(__dirname, 'squire-host.ts'))};
      import { createConnection } from 'node:net';
      import { strictEqual } from 'node:assert';
      const path = 'x'.repeat(200);
      const nativeError = await new Promise((resolve) => {
        const socket = createConnection({ path });
        socket.once('error', resolve);
      });
      try { await connect(path, { peer: 'invalid address' }); process.exitCode = 2; }
      catch (error) { strictEqual(error.code, nativeError.code); }
      console.log(await squireBrokerSocketReady(path));`;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('false');
    expect(result.stderr).not.toContain('Unhandled');
  },
);

it('watchChanges pushes changes until stopped and hands its error to the caller', async () => {
  const dir = await scratch();
  const names: Array<string | null> = [];
  let changed!: () => void;
  const seen = new Promise<void>((done) => {
    changed = done;
  });
  const stop = watchChanges(
    dir,
    (name) => {
      names.push(name);
      changed();
    },
    { onError: (error) => names.push(`error ${error.message}`) },
  );
  await writeFile(join(dir, 'state.json'), '{}');
  await seen;
  stop();
  expect(names).toContain('state.json');
  expect(() =>
    watchChanges(join(dir, 'gone'), () => undefined, { onError: () => undefined }),
  ).toThrow(/ENOENT/);
});

it('launchDetached starts its own session, reports exit and never rejects', async () => {
  const launched = launchDetached({
    file: process.execPath,
    args: ['-e', 'process.exit(4)'],
  });
  expect(launched.child.pid).toBeGreaterThan(0);
  await expect(launched.exited).resolves.toEqual({ code: 4, signal: null });
  const missing = launchDetached({ file: '/nonexistent/beeline-binary', args: [] });
  const end = await missing.exited;
  expect('error' in end && (end.error as NodeJS.ErrnoException).code).toBe('ENOENT');
});

it('launchDetached keeps an IPC handshake until release, in a process group of its own', async () => {
  const launched = launchDetached({
    file: process.execPath,
    args: ['-e', "process.send('ready'); process.on('disconnect', () => process.exit(0));"],
    ipc: true,
  });
  await answer(
    'candidate',
    [
      [launched.child, 'exit'],
      [launched.child, 'error'],
    ],
    ({ resolve }) => launched.child.once('message', resolve),
  );
  const group = spawnSync('ps', ['-o', 'pgid=', '-p', String(launched.child.pid)], {
    encoding: 'utf8',
  });
  expect(Number(group.stdout.trim())).toBe(launched.child.pid);
  launched.release();
  await expect(launched.exited).resolves.toEqual({ code: 0, signal: null });
});

it('ask answers a half-closed request with everything before orderly EOF', async () => {
  const path = await server((peer) => {
    let request = '';
    peer.on('data', (chunk) => (request += chunk));
    peer.on('end', () => {
      peer.write('{"echo":');
      peer.end(`${request}}`);
    });
  });
  const output = await ask<string>(
    { socket: path, peer: 'host', framing: 'eof', machineRead: true },
    '"hello"',
  );
  expect(JSON.parse(output)).toEqual({ echo: 'hello' });
  // A peer that goes away mid-request is the transport's failure, never an answer.
  const reset = await server((peer) => peer.destroy());
  await expect(
    ask({ socket: reset, peer: 'host', framing: 'eof', machineRead: true }, 'x'.repeat(1 << 20)),
  ).rejects.toThrow(/^host(:| closed)/);
});

it('ask flushes exact frames in order, and Claude gets its auth line first', async () => {
  let received!: (text: string) => void;
  const frames = new Promise<string>((done) => {
    received = done;
  });
  const path = await server((peer) => {
    let text = '';
    peer.on('data', (chunk) => (text += chunk));
    peer.on('end', () => received(text));
  });
  await postToClaude({ path, token: 'secret' }, 'hello');
  expect((await frames).split('\n')).toEqual([
    JSON.stringify({ type: 'auth', token: 'secret' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
    '',
  ]);
  await expect(
    postToClaude({ path: join(await scratch(), 'gone.sock') }, 'x'),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('ask decodes a byte frame incrementally while the peer keeps the connection open', async () => {
  const payload = 'emulator-5554\tdevice ✓';
  const bytes = Buffer.from(payload);
  const path = await server((peer) => {
    peer.once('data', () => {
      const reply = Buffer.concat([
        Buffer.from(`OKAY${bytes.length.toString(16).padStart(4, '0')}`),
        bytes,
      ]);
      // Split inside the multibyte character; the peer then stays open.
      peer.write(reply.subarray(0, reply.length - 2));
      peer.write(reply.subarray(reply.length - 2));
    });
  });
  const read = (input: Buffer) => {
    if (input.length < 8) return undefined;
    if (input.subarray(0, 4).toString('latin1') !== 'OKAY') throw new Error('refused');
    const length = Number.parseInt(input.subarray(4, 8).toString('latin1'), 16);
    return input.length < 8 + length ? undefined : input.subarray(8, 8 + length).toString();
  };
  await expect(
    ask({ socket: path, peer: 'adb', framing: { read }, machineRead: true }, '000chost:devices'),
  ).resolves.toBe(payload);
});

it('the hosted browser share host answers a half-closed request and stops past an idle peer', async () => {
  const host = new BrowserShareHost(join(await scratch(), 'share.sock'));
  await host.start();
  cleanup.push(() => host.stop());
  await expect(
    startHostedBrowserShare(host.socketPath, {
      page: { id: 'p', webSocketDebuggerUrl: '' } as never,
      shareId: 's',
      roomId: 'r',
      serverBaseUrl: 'http://127.0.0.1:1',
      daemonToken: 't',
    }),
  ).rejects.toThrow('Invalid browser share request');
  const idle = await connect(host.socketPath, { peer: 'idle share client' });
  idle.on('error', () => undefined);
  idle.write('{"page":');
  await host.stop();
});

it('a requester that leaves during the held answer does not hold the other handoff', async () => {
  const path = join(await scratch(), 'control.sock');
  let held = 0;
  let bothHeld!: () => void;
  const ready = new Promise<void>((done) => {
    bothHeld = done;
  });
  const control = new MachineControl(path, async (_request, hold) => {
    if (++held === 2) bothHeld();
    return hold();
  });
  await control.start();
  cleanup.push(() => control.stop());
  const update = (socketPath: string) =>
    ask<MachineAnswer>(
      { socket: socketPath, peer: 'helper update', machineRead: true },
      {
        operation: 'update',
      },
    );
  const staying = update(path);
  const leaving = await connect(path, { peer: 'leaving CLI' });
  leaving.on('error', () => undefined);
  leaving.write(`${JSON.stringify({ operation: 'update' })}\n`);
  await ready;
  leaving.destroy();
  await control.settleHeld({ error: 'handoff failed' });
  await expect(staying).rejects.toThrow('handoff failed');
});

it('the standalone module runs answer and watchChanges in a separate process', async () => {
  const dir = await scratch();
  const script = join(dir, 'probe.mjs');
  await writeFile(
    script,
    `const { answer, watchChanges } = await import(${JSON.stringify(ownedCommandModule())});
     const { EventEmitter } = await import('node:events');
     const { writeFileSync } = await import('node:fs');
     const channel = new EventEmitter();
     const replied = answer('peer', [[channel, 'close']], ({ resolve }) => channel.once('reply', resolve));
     channel.emit('reply', 'ok');
     let stop;
     const changed = new Promise((done) => {
       stop = watchChanges(${JSON.stringify(dir)}, (name) => { if (name === 'inbox') done(name); }, { onError: () => {} });
     });
     writeFileSync(${JSON.stringify(join(dir, 'inbox'))}, 'x');
     console.log(await replied, await changed);
     stop();`,
  );
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).toBe('ok inbox');
});

it('a shared-signal child is left to the service manager signal instead of being killed first', async () => {
  const owner = `import { runOwned } from ${JSON.stringify(resolve(__dirname, 'wait.ts'))};
    void runOwned({ step: 'broker', file: process.execPath, interactive: true, sharedSignals: true, machineRead: true,
      args: ['-e', "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)"] });`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', owner], {
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: true,
  });
  let output = '';
  const brokerPid = await new Promise<number>((done) =>
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      if (output.includes('\n')) done(Number(output.trim()));
    }),
  );
  cleanup.push(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
  });
  // The manager signals the whole group: the owner leaves, the broker handles its own SIGTERM.
  process.kill(-child.pid!, 'SIGTERM');
  await new Promise((done) => child.once('exit', done));
  expect(alive(brokerPid)).toBe(true);
});

it('a linked worker kills its own owned groups before its group when the owner is SIGKILLed', async () => {
  const wait = JSON.stringify(resolve(__dirname, 'wait.ts'));
  const worker = `import { exitWithOwner } from ${JSON.stringify(resolve(__dirname, 'owner-link.ts'))};
    import { runOwned } from ${wait};
    exitWithOwner();
    void runOwned({ step: 'nested', file: process.execPath, machineRead: true,
      args: ['-e', 'console.log(process.pid); setInterval(() => {}, 1000)'],
      onLine: (line) => console.log(process.pid + ' ' + line) });
    setInterval(() => {}, 1000);`;
  const owner = `import { runOwned } from ${wait};
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
  const [linked, nested] = await pids;
  child.kill('SIGKILL');
  await vi.waitFor(() => {
    expect(alive(linked!)).toBe(false);
    // The nested child runs in its own process group, which only the worker's exit hook reaches.
    expect(alive(nested!)).toBe(false);
  });
});

// Linux proof repro: `beeline update` failed with "read ECONNRESET" while following
// an exiting helper whose lock socket was still bound but closing.
it.runIf(process.platform === 'linux')(
  'following a helper that vanishes between its busy bind and its record ends as its exit',
  async () => {
    const root = join(await scratch(), 'state');
    const key = helperLockKey(root);
    let connections = 0;
    const exiting = createServer((peer) => {
      connections++;
      peer.destroy();
    });
    const address = `\0beeline-lock-${createHash('sha256').update(key).digest('hex')}`;
    await new Promise<void>((done) => exiting.listen(address, done));
    cleanup.push(() => new Promise<void>((done) => exiting.close(() => done())));
    await followHelperExit(root, { pid: 999_999, generation: 'predecessor' });
    expect(exiting.listening).toBe(true);
    expect(connections).toBe(1);
  },
);
