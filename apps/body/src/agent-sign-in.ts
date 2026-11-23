/**
 * `@agent /login` on the agent's own machine: one dispatcher, four kinds.
 *
 * - paste-code (Claude Code): `claude-sign-in.ts` builds the PKCE link and
 *   exchanges the pasted code.
 * - device-code (Codex, Grok) and approve-wait (Cursor): this helper runs a
 *   headless login, reads the link (and code) it prints, and reports the
 *   result when that process ends. Codex and Grok run the machine
 *   CLIProxyAPI's own device login (`cliproxy.ts`), which saves the login
 *   into the proxy, the sole refresher of every session on that account;
 *   Claude's exchanged login is handed to it once. Cursor keeps its native
 *   login under the operator's home (`agent-home.ts` SHARED_CREDENTIALS).
 * - Pi, Goose and OpenCode select proxy sign-in for an unkeyed subscription
 *   provider using the current model/provider configuration; other routes use
 *   api-key sign-in. The pasted key is verified with the
 *   provider (`provider-key-check.ts`, as `beeline connect` does) and written
 *   where that harness reads it.
 *
 * The output shapes below were read from CLIProxyAPI 8.0.77 and Cursor Agent
 * 2026.10.01-e373342; `agent-sign-in.contract.test.ts` pins them. Nothing
 * here logs a code, key, or token.
 */
import { agentBehavior } from './agent-command.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AGENT_SIGN_IN_ATTEMPT_TTL_MS,
  AGENT_SIGN_IN_PROVIDER_LABELS,
  isAgentSignInHarness,
  type AgentSignInFrame,
  type AgentSignInHarness,
  type AgentSignInKeyProvider,
  type AgentSignInLink,
  type ReportAgentSignInInput,
} from '@beeline/api-contract/daemon';
import { readJsonObject, writePrivateFileAtomically } from './atomic-private-file.js';
import { ClaudeSignIn } from './claude-sign-in.js';
import { parseEnvFile } from './config.js';
import { invalidateQuotaReads } from './harness-quota.js';
import { cliProxyLogin, machineCliProxy, type CliProxy, type ProxiedProvider } from './cliproxy.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { verifyProviderKey } from './provider-key-check.js';
import { answer, runOwned, type Settle } from './wait.js';

export type CliSignIn = {
  /** The program the card names; `proxyFlag` runs the machine proxy's login instead. */
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly kind: 'device-code' | 'approve-wait';
  /** Read the accumulated output; undefined until everything the card needs is printed. */
  readonly parse: (output: string, now: number) => AgentSignInLink | undefined;
  readonly proxyFlag?: string;
};

/**
 * CLIProxyAPI's `-codex-device-login` and `-xai-login`. Their device codes
 * outlive this helper's attempt, so the card shows its own limit.
 */
export function parseProxyDeviceLogin(output: string, now: number): AgentSignInLink | undefined {
  const url = /(?:Codex device URL:|please visit:)\s*(https:\/\/\S+)/.exec(output)?.[1];
  const code = /(?:Codex device code:|enter this code:)\s*([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/.exec(
    output,
  )?.[1];
  return url && code
    ? {
        kind: 'device-code',
        authorizeUrl: url,
        userCode: code,
        expiresAt: now + AGENT_SIGN_IN_ATTEMPT_TTL_MS,
      }
    : undefined;
}

/** `NO_OPEN_BROWSER=1 cursor-agent login` (Cursor Agent 2026.10.01-e373342). */
export function parseCursorLogin(output: string): AgentSignInLink | undefined {
  const url = /navigate to this link:\s*(https:\/\/\S+)/.exec(output)?.[1];
  return url ? { kind: 'approve-wait', authorizeUrl: url } : undefined;
}

/** The proxy's own device login for each proxied account; Claude uses Beeline's paste-code exchange. */
const PROXY_SIGN_INS: Readonly<Record<ProxiedProvider, 'codex' | 'grok' | undefined>> = {
  claude: undefined,
  codex: 'codex',
  xai: 'grok',
};

export const CLI_SIGN_INS: Readonly<Record<'codex' | 'grok' | 'cursor', CliSignIn>> = {
  codex: {
    command: 'codex',
    args: [],
    env: {},
    kind: 'device-code',
    parse: parseProxyDeviceLogin,
    proxyFlag: '-codex-device-login',
  },
  grok: {
    command: 'grok',
    args: [],
    env: {},
    kind: 'device-code',
    parse: parseProxyDeviceLogin,
    proxyFlag: '-xai-login',
  },
  cursor: {
    command: 'cursor-agent',
    args: ['login'],
    env: { NO_OPEN_BROWSER: '1' },
    kind: 'approve-wait',
    parse: (output) => parseCursorLogin(output),
  },
};

/** The environment variable a Pi or Goose agent reads each provider's key from. */
export const PROVIDER_KEY_ENV: Readonly<Record<AgentSignInKeyProvider, string>> = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  xai: 'XAI_API_KEY',
};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function lastLine(output: string): string {
  const lines = output
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return (lines.at(-1) ?? '').slice(0, 200);
}

/** Which provider a Pi or Goose agent was connected with, read from its env file. */
export async function keyProviderFromEnvFile(
  llmEnvFile: string | undefined,
): Promise<AgentSignInKeyProvider | undefined> {
  if (!llmEnvFile) return undefined;
  const text = await readFile(llmEnvFile, 'utf8').catch(() => '');
  const goose = /^GOOSE_PROVIDER=("?)([a-z]+)\1\s*$/m.exec(text)?.[2];
  const providers = Object.keys(PROVIDER_KEY_ENV) as AgentSignInKeyProvider[];
  if (goose && providers.includes(goose as AgentSignInKeyProvider))
    return goose as AgentSignInKeyProvider;
  return providers.find((provider) =>
    new RegExp(`^${PROVIDER_KEY_ENV[provider]}=`, 'm').test(text),
  );
}

/** Replace one `KEY=value` line of an env file atomically, keeping every other line. */
export async function writeEnvFileKey(path: string, name: string, value: string): Promise<void> {
  const text = await readFile(path, 'utf8').catch(() => '');
  const line = `${name}=${JSON.stringify(value)}`;
  const lines = text.split('\n').filter((entry, index, all) => entry || index < all.length - 1);
  const at = lines.findIndex((entry) => entry.startsWith(`${name}=`));
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  await writePrivateFileAtomically(path, `${lines.filter(Boolean).join('\n')}\n`);
}

/** Merge one provider key into OpenCode's own credential store. */
export async function writeOpenCodeKey(
  operatorHome: string,
  provider: AgentSignInKeyProvider,
  key: string,
): Promise<string> {
  const path = join(operatorHome, '.local', 'share', 'opencode', 'auth.json');
  const next = { ...(await readJsonObject(path)), [provider]: { type: 'api', key } };
  await writePrivateFileAtomically(path, `${JSON.stringify(next, null, 2)}\n`);
  return path;
}

export type AgentSignInOptions = {
  readonly harness: AgentSignInHarness;
  readonly operatorHome: string;
  /** The live agent env (shared with session spawn); a saved key is applied to it. */
  readonly agentEnv: Record<string, string>;
  /** The Pi/Goose provider env file `beeline connect` wrote. */
  readonly llmEnvFile?: string;
  /** The model the agent runs, `provider/model` for OpenCode. */
  readonly model?: () => string | undefined | Promise<string | undefined>;
  /** A result that arrives on its own, after `start` answered. */
  readonly onResult: (
    attemptId: string,
    result: { ok: true } | { ok: false; error: string },
  ) => void;
  /**
   * After any sign-in succeeds: retire idle sessions so the next turn starts
   * cold, relinks the shared login file (a first login may have just created
   * it) and reads the new login.
   */
  readonly onSignedIn?: () => void;
  /** The machine's CLIProxyAPI, which owns every proxied login. */
  readonly proxy?: () => Promise<Pick<CliProxy, 'saveLogin' | 'login'> | undefined>;
  readonly spawn?: typeof spawn;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
};

type Pending =
  | { readonly kind: 'cli'; readonly child: ChildProcess }
  | { readonly kind: 'key'; readonly provider: AgentSignInKeyProvider; readonly expiresAt: number };

/** One agent runtime's sign-in attempts. Secrets never leave this process. */
export class AgentSignIn {
  readonly #claude: ClaudeSignIn;
  readonly #pending = new Map<string, Pending>();
  readonly #spawn: typeof spawn;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(private readonly options: AgentSignInOptions) {
    this.#spawn = options.spawn ?? spawn;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#claude = new ClaudeSignIn({
      fetch: this.#fetch,
      now: this.#now,
    });
  }

  async start(attemptId: string): Promise<AgentSignInLink> {
    const { harness } = this.options;
    const env = {
      ...(this.options.llmEnvFile ? parseEnvFile(this.options.llmEnvFile) : {}),
      ...this.options.agentEnv,
    };
    const model = await this.options.model?.();
    const login = await cliProxyLogin(harness, model, env, this.options.operatorHome);
    const cliSignIn = login ? PROXY_SIGN_INS[login] : agentBehavior(harness).cliSignIn;
    if (login && !cliSignIn)
      return { kind: 'paste-code', authorizeUrl: this.#claude.start(attemptId) };
    if (cliSignIn) return this.#startCli(attemptId, cliSignIn);
    return this.#startKey(attemptId, model);
  }

  /** A pasted code (Claude) or key (Pi, Goose, OpenCode). */
  async submit(attemptId: string, value: string): Promise<void> {
    const pending = this.#pending.get(attemptId);
    if (!pending) {
      await (
        await this.#proxy()
      ).saveLogin('claude', await this.#claude.complete(attemptId, value));
      this.#signedIn();
      return;
    }
    if (pending.kind !== 'key' || pending.expiresAt <= this.#now())
      throw new Error(
        'This sign-in expired or was already used. Send the agent `/login` again to start a new one.',
      );
    await this.#saveKey(pending.provider, value.trim());
    this.#pending.delete(attemptId);
    this.#signedIn();
  }

  /** Stop every CLI login this runtime started (runtime shutdown). */
  stop(): void {
    for (const [attemptId, pending] of this.#pending) {
      this.#pending.delete(attemptId);
      if (pending.kind === 'cli') {
        pending.child.kill('SIGTERM');
      }
    }
  }

  async #proxy(): Promise<Pick<CliProxy, 'saveLogin' | 'login'>> {
    const proxy = await (this.options.proxy ?? machineCliProxy)();
    if (!proxy) throw new Error('CLIProxyAPI is not running');
    return proxy;
  }

  #signedIn(): void {
    invalidateQuotaReads();
    this.options.onSignedIn?.();
  }

  async #startCli(
    attemptId: string,
    provider: keyof typeof CLI_SIGN_INS,
  ): Promise<AgentSignInLink> {
    const login = CLI_SIGN_INS[provider];
    // One headless login at a time: a new `login` replaces an unfinished one.
    for (const [id, pending] of this.#pending) {
      if (pending.kind !== 'cli') continue;
      this.#pending.delete(id);
      pending.child.kill('SIGTERM');
    }
    // Cursor's own login lands in the operator's home, never an isolated one.
    const { CURSOR_HOME: _isolated, ...ambient } = process.env;
    const launch = login.proxyFlag
      ? (await this.#proxy()).login(login.proxyFlag)
      : {
          command: login.command,
          args: [...login.args],
          env: {
            ...ambient,
            HOME: this.options.operatorHome,
            PATH: this.options.agentEnv.PATH || process.env.PATH || '',
            ...login.env,
          },
        };
    let output = '';
    let child: ChildProcess | undefined;
    let link!: Settle<AgentSignInLink>;
    // The link arrives on the login's own output; the run settling first fails it.
    const linked = answer<AgentSignInLink>(`${login.command} login`, [], (settle) => {
      link = settle;
    });
    let answered = false;
    const fail = (message: string) => {
      if (answered) return;
      answered = true;
      link.reject(new Error(message));
    };
    const read = (chunk: Buffer) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-16_000);
      if (answered) return;
      const parsed = login.parse(output.replace(ANSI, '').replace(/\r/g, ''), this.#now());
      if (!parsed) return;
      answered = true;
      link.resolve(parsed);
    };
    const run = runOwned(
      {
        step: `${login.command} login`,
        file: launch.command,
        args: launch.args,
        env: launch.env,
        cwd: this.options.operatorHome,
        captureOutput: false,
        machineRead: true,
        onSpawn: (spawned) => {
          child = spawned;
          this.#pending.set(attemptId, { kind: 'cli', child: spawned });
          spawned.once('error', (error) => {
            this.#pending.delete(attemptId);
            const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
            fail(
              missing
                ? `\`${login.command}\` is not installed on the agent's machine.`
                : `\`${login.command}\` could not start: ${error.message}`,
            );
          });
          spawned.stdout?.on('data', read);
          spawned.stderr?.on('data', read);
        },
      },
      { spawn: this.#spawn },
    );
    run.then(
      ({ code, signal }) => {
        const owned = this.#pending.get(attemptId);
        if (owned?.kind === 'cli' && owned.child === child) this.#pending.delete(attemptId);
        else return; // replaced, expired, or stopped: its outcome is already decided
        const failure = `\`${login.command} login\` stopped: ${lastLine(output) || (signal ?? `exit ${code}`)}`;
        if (!answered) {
          answered = true;
          link.reject(new Error(failure));
          return;
        }
        // The proxy's login exits 0 either way; only its success line means saved.
        const ok =
          code === 0 &&
          (!login.proxyFlag ||
            /^(?:Codex device|xAI) authentication successful!$/.test(lastLine(output)));
        if (ok) this.#signedIn();
        this.options.onResult(attemptId, ok ? { ok: true } : { ok: false, error: failure });
      },
      () => {
        // Without a child the spawn itself threw, as for a command that is not installed.
        if (!child) fail(`\`${login.command}\` is not installed on the agent's machine.`);
      },
    );
    return linked;
  }

  async #startKey(attemptId: string, model: string | undefined): Promise<AgentSignInLink> {
    const { harness } = this.options;
    let provider: AgentSignInKeyProvider | undefined;
    if (agentBehavior(harness).providerKeyStore === 'auth-file') {
      const prefix = model?.split('/')[0];
      provider =
        prefix && prefix in PROVIDER_KEY_ENV ? (prefix as AgentSignInKeyProvider) : undefined;
      if (!provider)
        throw new Error(
          "This OpenCode agent's model is not served by a provider key Beeline can set. Run `opencode auth login` on its machine.",
        );
    } else {
      provider = await keyProviderFromEnvFile(this.options.llmEnvFile);
      if (!provider)
        throw new Error(
          'This agent has no provider key to replace. Run `beeline connect` on its machine.',
        );
    }
    this.#pending.set(attemptId, {
      kind: 'key',
      provider,
      expiresAt: this.#now() + AGENT_SIGN_IN_ATTEMPT_TTL_MS,
    });
    return { kind: 'api-key', provider };
  }

  async #saveKey(provider: AgentSignInKeyProvider, key: string): Promise<void> {
    if (!key) throw new Error(`Paste the ${AGENT_SIGN_IN_PROVIDER_LABELS[provider]} key.`);
    await verifyProviderKey({ provider, apiKey: key, fetchImpl: this.#fetch });
    if (agentBehavior(this.options.harness).providerKeyStore === 'auth-file') {
      await writeOpenCodeKey(this.options.operatorHome, provider, key);
    } else {
      if (!this.options.llmEnvFile)
        throw new Error(
          'This agent has no provider key to replace. Run `beeline connect` on its machine.',
        );
      await writeEnvFileKey(this.options.llmEnvFile, PROVIDER_KEY_ENV[provider], key);
      this.options.agentEnv[PROVIDER_KEY_ENV[provider]] = key;
    }
  }
}

/** Validate one live frame from the server; anything else is ignored. */
export function agentSignInFrame(event: Record<string, unknown>): AgentSignInFrame | undefined {
  if (event.type !== 'agent-sign-in' || typeof event.attemptId !== 'string' || !event.attemptId)
    return undefined;
  if (event.step === 'start' && typeof event.cardId === 'string' && event.cardId)
    return {
      type: 'agent-sign-in',
      step: 'start',
      attemptId: event.attemptId,
      cardId: event.cardId,
    };
  if (event.step === 'code' && typeof event.code === 'string')
    return { type: 'agent-sign-in', step: 'code', attemptId: event.attemptId, code: event.code };
  return undefined;
}

/** The harness an agent runtime signs in with, or undefined when Beeline cannot. */
export function agentSignInHarness(kind: string): AgentSignInHarness | undefined {
  return isAgentSignInHarness(kind) ? kind : undefined;
}

/**
 * Run one frame and report its answer. Logs name the attempt and the error,
 * never the code, key, verifier, or token.
 */
export async function answerAgentSignInFrame(
  api: Pick<DaemonApiClient, 'execute'>,
  agentId: string,
  signIn: Pick<AgentSignIn, 'start' | 'submit'>,
  frame: AgentSignInFrame,
  cards: Map<string, string>,
  log: (message: string) => void = () => {},
): Promise<void> {
  let report: ReportAgentSignInInput;
  try {
    if (frame.step === 'start') {
      cards.set(frame.attemptId, frame.cardId);
      report = { agentId, attemptId: frame.attemptId, ...(await signIn.start(frame.attemptId)) };
    } else {
      await signIn.submit(frame.attemptId, frame.code);
      const cardId = cards.get(frame.attemptId);
      report = {
        agentId,
        attemptId: frame.attemptId,
        ...(cardId ? { cardId } : {}),
        outcome: 'signed-in',
      };
      log(`sign-in ${frame.attemptId} saved`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`sign-in ${frame.attemptId} ${frame.step} failed: ${message}`);
    const cardId = cards.get(frame.attemptId);
    report = {
      agentId,
      attemptId: frame.attemptId,
      ...(cardId ? { cardId } : {}),
      outcome: 'failed',
      error: message,
    };
  }
  try {
    await api.execute('reportAgentSignIn', report);
  } catch (error) {
    log(
      `sign-in ${frame.attemptId} report failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Report a result that arrived on its own (a device code approved, a login that expired). */
export async function reportAgentSignInResult(
  api: Pick<DaemonApiClient, 'execute'>,
  agentId: string,
  attemptId: string,
  cards: Map<string, string>,
  result: { ok: true } | { ok: false; error: string },
  log: (message: string) => void = () => {},
): Promise<void> {
  const cardId = cards.get(attemptId);
  const report: ReportAgentSignInInput = result.ok
    ? { agentId, attemptId, ...(cardId ? { cardId } : {}), outcome: 'signed-in' }
    : { agentId, attemptId, ...(cardId ? { cardId } : {}), outcome: 'failed', error: result.error };
  log(`sign-in ${attemptId} ${result.ok ? 'finished' : `failed: ${result.error}`}`);
  try {
    await api.execute('reportAgentSignIn', report);
  } catch (error) {
    log(
      `sign-in ${attemptId} report failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
