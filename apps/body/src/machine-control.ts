import { chmod, rm } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { resolve } from 'node:path';
import type { HelperStatusFile } from './helper-status.js';
import { privateSocketPath, preparePrivateSocketDirectory } from './local-socket.js';
import { ask, tryLock } from './wait.js';
import { waitForProcessExit } from './process-exit.js';

export interface MachineRequest {
  operation: 'status' | 'converge' | 'stop' | 'update';
  releaseId?: string;
  agentId?: string;
  sourceGeneration?: string;
  force?: boolean;
  startup?: HelperStatusFile | { error: string };
}

/**
 * The helper's one answer to one request. An `update` answer names its
 * outcome: `handoff` means the helper is exiting for the requested release,
 * `current` means the loaded release already satisfies it. A helper that
 * predates one-answer control omits it.
 */
export type MachineAnswer = HelperStatusFile & { readonly outcome?: 'handoff' | 'current' };

export function machineControlPath(stateRoot: string): string {
  // Darwin truncates Unix socket paths at 104 bytes. Neither the install/home
  // path nor os.tmpdir() (usually /var/folders/.../T on macOS) is bounded.
  // A private, installation-specific directory under literal /var/tmp keeps
  // both sides on the same short endpoint, including for Unicode state homes.
  return privateSocketPath(resolve(stateRoot));
}

/** The serving helper holds this kernel lock for its whole life; the kernel releases it on exit. */
export function helperLockKey(stateRoot: string): string {
  return `beeline-helper:${resolve(stateRoot)}`;
}

/** Marks an update request the helper answers later, when its handoff starts or fails. */
const HELD = Symbol('held');
export type HeldAnswer = typeof HELD;

/** One request, one answer: the live connection, not a PID or a snapshot on disk, proves the generation. */
export class MachineControl {
  readonly #held = new Set<Socket>();
  readonly #peers = new Set<Socket>();
  readonly #server = createServer((socket) => {
    this.#peers.add(socket);
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    socket.once('close', () => {
      this.#held.delete(socket);
      this.#peers.delete(socket);
      if (!received) this.onIncompleteClose?.();
    });
    let input = '';
    let received = false;
    socket.on('data', (chunk: string) => {
      if (received) return;
      input += chunk;
      if (input.length > 4096) {
        socket.destroy();
        return;
      }
      const end = input.indexOf('\n');
      if (end < 0) return;
      const line = input.slice(0, end);
      received = true;
      void (async () => {
        const request = JSON.parse(line) as MachineRequest;
        if (!['status', 'converge', 'stop', 'update'].includes(request.operation))
          throw new Error('invalid helper operation');
        const answer = await this.onRequest(request, () => {
          this.#held.add(socket);
          return HELD;
        });
        if (answer === HELD) return;
        this.#held.delete(socket);
        if (!socket.writableEnded) socket.end(`${JSON.stringify(answer)}\n`);
      })().catch((error) => {
        this.#held.delete(socket);
        this.onIncompleteClose?.();
        if (!socket.writableEnded) socket.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
      });
    });
  });

  constructor(
    readonly path: string,
    readonly onRequest: (
      request: MachineRequest,
      hold: () => HeldAnswer,
    ) => Promise<MachineAnswer | HeldAnswer>,
    readonly onIncompleteClose?: () => void,
  ) {}

  async start(): Promise<void> {
    await preparePrivateSocketDirectory(this.path);
    // Machine ownership is held by the native supervisor and the process lock.
    await rm(this.path, { force: true });
    await new Promise<void>((done, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.path, done);
    });
    await chmod(this.path, 0o600);
  }

  /** Answer every held update request; resolves once each answer has been written. */
  settleHeld(answer: MachineAnswer | { error: string }): Promise<void> {
    const line = `${JSON.stringify(answer)}\n`;
    const sockets = [...this.#held];
    this.#held.clear();
    return Promise.all(sockets.map((socket) => new Promise<void>((done) => {
      if (socket.destroyed) done();
      else socket.end(line, () => done());
    }))).then(() => undefined);
  }

  async stop(): Promise<void> {
    if (!this.#server.listening) return;
    await this.settleHeld({ error: 'helper stopped before answering the update' });
    for (const peer of this.#peers) {
      if (!peer.writableEnded) peer.end(`${JSON.stringify({ error: 'helper control stopped before answering' })}\n`);
      peer.destroySoon();
    }
    await new Promise<void>((done) => this.#server.close(() => done()));
    await rm(this.path, { force: true });
  }
}

/** Follow the serving helper's kernel lock until the kernel releases it on that process's exit. */
export async function followHelperExit(stateRoot: string, predecessor: Pick<MachineAnswer, 'pid' | 'generation'>): Promise<void> {
  const lock = await tryLock(helperLockKey(stateRoot));
  if (lock.held) await lock.release();
  else if (lock.holder.key === helperLockKey(stateRoot) && lock.holder.pid === predecessor.pid &&
      (lock.holder.generation === undefined || lock.holder.generation === predecessor.generation)) await lock.released();
  else lock.close();
}

/** No helper is listening: its socket is missing or refused. Any other failure is reported as is. */
export function helperAbsent(error: unknown): boolean {
  return ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}

/** Ask the helper once. It answers what it did or why it refused; nothing here waits for a state. */
export async function askMachine(
  stateRoot: string,
  request: MachineRequest,
  wait: { report?: (line: string) => void; machineRead?: boolean } = {},
): Promise<MachineAnswer> {
  const path = machineControlPath(stateRoot);
  await preparePrivateSocketDirectory(path);
  const answer = await ask<MachineAnswer>(
    { socket: path, peer: `helper ${request.operation}`, ...wait },
    request,
  );
  if (
    typeof answer.generation !== 'string' ||
    !answer.generation ||
    !Number.isSafeInteger(answer.pid) ||
    answer.pid <= 0 ||
    !['starting', 'serving', 'stopping'].includes(answer.processState) ||
    !answer.agents ||
    typeof answer.agents !== 'object' ||
    Array.isArray(answer.agents)
  )
    throw new Error('invalid helper answer');
  return answer;
}

/** Read the existing host adb server directly: invoking adb could start a server. */
export async function hostEmulatorSerials(connect = () => createConnection({ host: '127.0.0.1', port: 5037 })): Promise<string[]> {
  const devices = await hostAdbQuery('host:devices', connect);
  const serials = devices.split('\n').flatMap((line) => {
    const [serial, state] = line.trim().split(/\s+/);
    return serial && /^emulator-\d+$/.test(serial) && state === 'device' ? [serial] : [];
  });
  // A transport can disappear after enumeration. Confirm each serial before offering it.
  const ready = await Promise.all(serials.map(async serial => {
    try { return await hostAdbQuery(`host-serial:${serial}:get-state`, connect) === 'device'; }
    catch { return false; }
  }));
  return serials.filter((_, index) => ready[index]);
}

function hostAdbQuery(query: string, connect: () => ReturnType<typeof createConnection>): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect();
    let bytes = Buffer.alloc(0);
    socket.once('connect', () => {
      socket.write(query.length.toString(16).padStart(4, '0') + query);
    });
    socket.on('data', (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 8) return;
      const status = bytes.subarray(0, 4).toString();
      const header = bytes.subarray(4, 8).toString();
      if (status !== 'OKAY' || !/^[0-9a-f]{4}$/i.test(header)) {
        socket.destroy(new Error('host adb device list unavailable'));
        return;
      }
      const length = Number.parseInt(header, 16);
      if (bytes.length < 8 + length) return;
      socket.destroy();
      resolve(bytes.subarray(8, 8 + length).toString());
    });
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('host adb server closed')));
  });
}

function helperStartupPath(stateRoot: string): string {
  return privateSocketPath(JSON.stringify(['helper-startup', resolve(stateRoot)]));
}

export function reportHelperStartup(stateRoot: string, startup: HelperStatusFile | { error: string }): void {
  const peer = createConnection(helperStartupPath(stateRoot));
  peer.unref();
  peer.on('error', () => undefined);
  peer.on('data', () => undefined);
  const answer = 'error' in startup ? startup : { pid: startup.pid, generation: startup.generation,
    processState: startup.processState, updatedAt: startup.updatedAt, agents: {} };
  peer.end(`${JSON.stringify({ operation: 'status', startup: answer })}\n`);
}

export async function startHelperWithAcknowledgment(stateRoot: string, start: () => Promise<number>): Promise<HelperStatusFile> {
  let channel: MachineControl | undefined;
  const controller = new AbortController();
  return ask<HelperStatusFile>({ peer: 'launchd helper startup acknowledgment', send: async (ready, failed) => {
    let status: HelperStatusFile | undefined;
    let pid: number | undefined;
    const complete = () => {
      if (!status || pid === undefined) return;
      if (status.pid !== pid) failed(new Error(`helper startup answered from pid ${status.pid}, expected ${pid}`));
      else ready(status);
    };
    channel = new MachineControl(helperStartupPath(stateRoot), async request => {
      const value = request.startup;
      if (!value || typeof value !== 'object') throw new Error('helper startup answer missing');
      if ('error' in value) {
        const error = new Error(value.error);
        failed(error);
        throw error;
      }
      status = value;
      complete();
      return value;
    }, () => failed(new Error('helper exited before its startup acknowledgment')));
    await channel.start();
    pid = await start();
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('launchd start completed without a process');
    void waitForProcessExit(pid, controller.signal).then(
      () => { if (!controller.signal.aborted) failed(new Error(`helper pid ${pid} exited before its startup acknowledgment`)); },
      error => { if (!controller.signal.aborted) failed(error); },
    );
    if (!status) {
      const current = await askMachine(stateRoot, { operation: 'status' }).catch(error => {
        if (helperAbsent(error)) return undefined;
        throw error;
      });
      if (current?.processState === 'serving') status = current;
    }
    complete();
  } }).finally(async () => { controller.abort(); await channel?.stop(); });
}
