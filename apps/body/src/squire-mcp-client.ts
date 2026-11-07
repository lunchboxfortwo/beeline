import { randomUUID } from 'node:crypto';
import { SquireOperationError } from './squire-outcome.js';
/**
 * The REAL Squire MCP client — one stdio JSON-RPC session with the Squire MCP
 * server process on this helper. Everything the connector lifecycle does
 * (`list_credentials`, `audit_log`, `list_app_access`, `revoke_app_access`)
 * goes through `call()`, shaped to the `SquireMcpClient` interface
 * (`connector-squire.ts`) so the assignment loop stays Squire-shaped and
 * tests keep driving a mock.
 *
 * The server is spawned on demand through the NON-ELECTING façade
 * (`squireFacadeLaunch`), never as a bare `npx … server`: N helper daemons
 * restarting together each spawn this client, and an electing server per
 * daemon is the eight-brokers-at-100-percent-CPU incident. The façade reaches
 * the one host broker or reports `broker unavailable` and exits — a bounded
 * refusal while the host unit comes up, instead of another browser. It is
 * initialized once and left running until an explicit account reconnect or a
 * dead child. Reconnecting never replays a pending tool call.
 * Tests may inject a command; omitting `server` on a raw npx spawn runs
 * Squire's connect CLI instead of the vault MCP.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { squireConnectProcessEnv } from './connector-squire.js';
import { squireFacadeLaunch, type SquireAgentScope } from './squire-host.js';

export type SquireMcpClientOptions = {
  readonly scope: SquireAgentScope;
  readonly home?: string;
  /** Spawn command; defaults to the published package through npx. */
  readonly command?: string;
  readonly args?: readonly string[];
  readonly log?: (message: string) => void;
  /** Spawn implementation; defaults to node:child_process (tests fake it). */
  readonly spawn?: typeof spawn;
  /** Process env for the MCP server; defaults to the helper chrome profile. */
  readonly env?: NodeJS.ProcessEnv;
  readonly onSpawn?: (pid: number | undefined) => void;
  readonly onExit?: (pid: number | undefined, code: number | null) => void;
  /** Task-owned relays kill the whole façade → npx → Squire process group. */
  readonly processGroup?: boolean;
  /**
   * An unsolicited (id-less) JSON-RPC message from the Squire MCP server over
   * this same stdio session — e.g. a future decision notification for an
   * approval it returned pending. Absent, every notification is dropped, as
   * before.
   */
  readonly onNotification?: (message: Record<string, unknown>) => void;
};

type PendingEntry = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class StdioSquireMcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private buffer = '';
  private initialized?: Promise<void>;
  private closed = false;
  private readonly log: (message: string) => void;

  constructor(private readonly options: SquireMcpClientOptions) {
    this.log = options.log ?? (() => {});
  }

  /** One Squire MCP tool call; resolves with the tool's parsed result. */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const response = (await this.requestMcp('tools/call', { name: tool, arguments: args })) as {
      isError?: boolean;
      content?: readonly { type?: string; text?: string }[];
    };
    if (response.isError) {
      const text = response.content?.find((entry) => entry.type === 'text')?.text ?? 'tool error';
      let code: string | undefined;
      try { code = JSON.parse(text).error?.code; } catch { /* Prose tool error. */ }
      throw new SquireOperationError(code === 'reconnect_required' ? 'Trusty Squire needs sign-in' : `${tool} failed: ${text}`,
        { cause:code === 'reconnect_required' ? 'needs-sign-in' : 'request-refused',accepted:true,completed:true });
    }
    const text = response.content?.find((entry) => entry.type === 'text')?.text;
    if (typeof text !== 'string') return response;
    try {
      return JSON.parse(text);
    } catch {
      return response;
    }
  }

  /** Raw MCP request for the helper-owned task relay. The child remains the owner. */
  async requestMcp(method: 'tools/list' | 'tools/call', params: Record<string, unknown>): Promise<unknown> {
    const operationId = randomUUID();
    try {
      await this.ensureSession();
      return await this.request(method, { ...params, _meta: { ...(params._meta as Record<string,unknown>),beelineOperationId:operationId } });
    } catch (error) {
      if (!(error instanceof SquireOperationError) || error.outcome.completed || error.outcome.cause === 'needs-sign-in') throw error;
      if(error.outcome.reconnect==='failed')throw error;
      if(error.outcome.reconnect!=='in-progress')this.reconnect();
      try {
        await this.ensureSession();
        if(method==='tools/list')return await this.request(method,params);
        const reply = await this.request('tools/call',{ name:'beeline_read_operation',arguments:{operationId} }) as {content?:{text?:string}[]};
        const receipt = JSON.parse(reply.content?.[0]?.text ?? '{}');
        if (receipt.completed && receipt.outcome === 'completed') return receipt.result;
        throw new SquireOperationError('Browser result is unknown. Do not repeat the browser action.',
          { cause:'result-unknown',operationId,accepted:receipt.accepted ?? null,completed:false },{cause:error});
      } catch (readError) {
        if (readError instanceof SquireOperationError && readError.outcome.operationId) throw readError;
        throw new SquireOperationError('Browser connection is unavailable; the previous action may have completed. Do not repeat it.',
          { cause:'connection-lost',operationId,accepted:null,completed:false },{cause:error});
      }
    }
  }

  get pid(): number | undefined { return this.child?.pid; }

  /** Tear the session down; safe to call repeatedly. */
  close(): void {
    this.closed = true;
    this.reconnect();
  }

  /** Discard only this client's facade; an explicit connect owns the next read. */
  reconnect(): void {
    const child = this.child;
    this.child = undefined;
    this.initialized = undefined;
    for (const entry of this.pending.values()) {
      entry.reject(new Error('Squire MCP session closed'));
    }
    this.pending.clear();
    if (this.options.processGroup && child?.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    } else {
      child?.kill();
    }
  }

  private ensureSession(): Promise<void> {
    if (this.closed) throw new Error('Squire MCP client is closed');
    if (!this.initialized) {
      const session = this.initialize().catch((error) => {
        if (this.initialized === session) this.initialized = undefined;
        throw error;
      });
      this.initialized = session;
    }
    return this.initialized;
  }

  private initialize(): Promise<void> {
    const launch = squireFacadeLaunch(this.options.home ?? homedir(), this.options.scope);
    const env = { ...(this.options.env ?? { ...squireConnectProcessEnv(), ...launch.env }) };
    if (!this.options.scope.relay) {
      delete env.BEELINE_SQUIRE_RELAY_URL;
      delete env.BEELINE_SQUIRE_RELAY_TOKEN;
      delete env.BEELINE_TURN_CONTEXT_FILE;
    }
    const child = (this.options.spawn ?? spawn)(
      this.options.command ?? launch.command,
      [...(this.options.args ?? launch.args)],
      {
        detached: this.options.processGroup ?? false,
        env,
      },
    ) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.options.onSpawn?.(child.pid);
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.child === child) this.onData(chunk);
    });
    child.stderr.on('data', (chunk: string) => this.log(`squire mcp stderr: ${chunk.trim()}`));
    let exited = false;
    const fail = (code: number | null, error?: Error) => {
      if (exited) return;
      exited = true;
      this.log(`squire mcp exited (${String(code)})`);
      this.options.onExit?.(child.pid, code);
      if (this.child !== child) return;
      this.initialized = undefined;
      this.child = undefined;
      for (const entry of this.pending.values()) {
        entry.reject(new SquireOperationError('Squire process exited', {cause:'process-exit',accepted:null,completed:false}, {cause:error}));
      }
      this.pending.clear();
    };
    child.on('error', (error) => fail(null, error));
    child.on('exit', (code) => fail(code));
    return this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'beeline-helper', version: '1.0.0' },
    }).then(() => {
      if (this.child !== child) throw new Error('Squire MCP session closed');
      this.notify('notifications/initialized');
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    _toolName?: string,
  ): Promise<unknown> {
    const id = this.nextId++;
    const child = this.child;
    if (!child) return Promise.reject(new SquireOperationError('Squire connection is not running',{cause:'connection-lost',accepted:false,completed:false}));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = typeof message.id === 'number' ? message.id : undefined;
      if (id === undefined) {
        this.options.onNotification?.(message);
        continue;
      }
      const entry = this.pending.get(id);
      if (!entry) continue;
      this.pending.delete(id);
      if (message.error) {
        const error = message.error as { code?: number; message?: string; data?: { outcome?:string; cause?:string; reconnect?:'in-progress'|'failed' } };
        const refused=[-32600,-32601,-32602].includes(error.code ?? 0);
        entry.reject(new SquireOperationError(error.message ?? 'Squire MCP error', {
          cause:error.data?.cause === 'needs-sign-in' ? 'needs-sign-in' : refused ? 'request-refused' : error.data?.outcome ? 'connection-lost' : 'result-unknown',
          accepted:refused || error.data?.outcome === 'not-sent' ? false : null,completed:refused,
          ...(error.data?.reconnect ? {reconnect:error.data.reconnect} : {}),
        }));
      } else {
        entry.resolve(message.result);
      }
    }
  }
}

/**
 * The one Squire MCP client the helper loop uses. Injectable so tests drive a
 * mock; the real helper gets one lazily-spawned stdio session.
 */
export function defaultSquireMcpClient(scope: SquireAgentScope): SquireMcpClientContract {
  return new StdioSquireMcpClient({ scope });
}

/** The shape `connector-squire.ts` speaks, re-declared to avoid a cycle. */
export interface SquireMcpClientContract {
  call(tool: string, args?: Record<string, unknown>): Promise<unknown>;
  reconnect?(): void;
}
