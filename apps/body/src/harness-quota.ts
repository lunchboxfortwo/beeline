/**
 * Plan quota for every harness quota-axi can read (Claude, Codex, Cursor,
 * Grok, OpenCode Go). After a turn the helper runs the pinned quota-axi CLI
 * and turns its report into the `AgentUsage` windows the owner's Profile
 * shows. Cursor and OpenCode Go read the agent's own environment. Claude,
 * Codex and Grok logins live in the machine's CLIProxyAPI: quota-axi reads a
 * private, access-token-only copy of the proxy's current login, which it
 * cannot refresh, so the proxy stays the only refresher.
 *
 * quota-axi never refreshes credentials here (`--no-credential-refresh`). It
 * prompts no keychain and spends no Claude inference, because neither
 * `--allow-keychain-prompt` nor `--allow-claude-inference` is ever passed. Its
 * output carries no token.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import {
  usageReason,
  type AgentUsage,
  type UsageRead,
  type UsageRefreshOutcome,
  type UsageWindow,
} from '@beeline/api-contract/daemon';
import { agentBehavior, type AgentKind } from './agent-command.js';
import { writePrivateFileAtomically } from './atomic-private-file.js';
import { cliProxyDir, machineCliProxy, type CliProxy, type ProxiedProvider } from './cliproxy.js';
import { runOwned } from './wait.js';

/** Bundled next to `beeline-cli.mjs` by `packages/scripts/build-beeline-bundle.mjs`. */
export const QUOTA_AXI_BUNDLE_FILE = 'quota-axi.mjs';
/** One vendor read per plan account per interval keeps clear of usage-endpoint limits. */
export const QUOTA_READ_INTERVAL_MS = 5 * 60_000;
/** A refresh this soon after the last read shares that read instead of asking again. */
const REFRESH_REUSE_MS = 30_000;
const MAX_WINDOWS = 8;
/** xAI's OIDC issuer and the Grok CLI client the proxy refreshes as. */
const XAI_ISSUER = 'https://auth.x.ai';
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

/**
 * The quota-axi provider for a harness, or undefined when the agent bills
 * through OpenRouter (its key spend is read instead) or quota-axi has none.
 */
export function quotaAxiProvider(kind: AgentKind | undefined, openRouter: boolean): string | undefined {
  if (openRouter) return;
  switch (kind) {
    case 'claude':
    case 'codex':
    case 'cursor':
    case 'grok':
      return kind;
    case 'opencode':
      return 'opencode-go';
    default:
      return;
  }
}

export function quotaAxiLaunch(
  meta: string = import.meta.url,
  entry: string | undefined = process.argv[1],
): { command: string; args: string[] } {
  if (meta.startsWith('beeline:')) {
    if (!entry) throw new Error('quota-axi cannot resolve the Beeline CLI entry');
    return { command: process.execPath, args: [join(dirname(entry), QUOTA_AXI_BUNDLE_FILE)] };
  }
  // The package exports only its library entry; its CLI sits beside it.
  const library = createRequire(meta).resolve('quota-axi');
  return { command: process.execPath, args: [join(dirname(library), '../bin/quota-axi.js')] };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** quota-axi's provider state as the read Beeline shows; unknown states count as failed. */
function quotaAxiRead(state: Record<string, unknown> | undefined, at: number): UsageRead {
  const status = state?.status;
  const reason = usageReason(state?.error);
  const retryAfter = typeof state?.retryAfter === 'string' ? Date.parse(state.retryAfter) / 1000 : NaN;
  if (status === 'fresh' && state?.stale !== true) return { status: 'fresh', at };
  if (status === 'auth_required' || state?.reason === 'credentials_expired' || state?.authStatus === 'unusable')
    return { status: 'signed_out', at };
  if (status === 'rate_limited' || Number.isFinite(retryAfter))
    return { status: 'rate_limited', at, ...(Number.isFinite(retryAfter) ? { retryAfter } : {}) };
  if (status === 'stale') return { status: 'stale', at, ...(reason ? { reason } : {}) };
  return { status: 'failed', at, reason: reason ?? usageReason(status) ?? 'no reading' };
}

/**
 * One provider's quota-axi `--json` report as Beeline usage; unknown fields
 * are ignored. Windows carry the time the vendor answered (`refreshedAt` for
 * a cached or reused reading), and `read` says how this read went.
 */
export function quotaAxiUsage(
  report: unknown,
  provider: string,
  now = Date.now() / 1000,
): AgentUsage | undefined {
  const providers = record(report)?.providers;
  if (!Array.isArray(providers)) return;
  const entry = providers.map(record).find((p) => p?.provider === provider);
  if (!entry) return;
  const state = record(entry.state);
  const refreshedAt = typeof state?.refreshedAt === 'string' ? Date.parse(state.refreshedAt) / 1000 : NaN;
  const readAt = Number.isFinite(refreshedAt) ? Math.min(refreshedAt, now) : now;
  const windows = new Map<string, UsageWindow>();
  for (const raw of Array.isArray(entry.windows) ? entry.windows : []) {
    const w = record(raw);
    const remaining = w?.percentRemaining;
    if (!w || typeof w.id !== 'string' || typeof remaining !== 'number' || !Number.isFinite(remaining))
      continue;
    const rateLimitType = w.id
      .toLowerCase()
      .replace(/[^a-z]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64);
    if (!rateLimitType || windows.has(rateLimitType) || windows.size >= MAX_WINDOWS) continue;
    const left = Math.min(100, Math.max(0, remaining));
    const resetsAt = typeof w.resetsAt === 'string' ? Date.parse(w.resetsAt) / 1000 : NaN;
    const label = typeof w.label === 'string' ? w.label.trim().slice(0, 40) : '';
    windows.set(rateLimitType, {
      rateLimitType,
      status: left <= 0 ? 'rejected' : 'allowed',
      utilization: (100 - left) / 100,
      ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
      updatedAt: readAt,
      ...(label ? { label } : {}),
    });
  }
  const credits = record(entry.credits);
  const creditsLeft =
    credits?.unit === 'credits' &&
    credits.unlimited !== true &&
    typeof credits.remaining === 'number' &&
    Number.isFinite(credits.remaining) &&
    credits.remaining >= 0
      ? credits.remaining
      : undefined;
  const read = quotaAxiRead(state, now);
  // A provider with nothing to show and nothing wrong is not reported.
  if (!windows.size && creditsLeft === undefined && read.status === 'fresh') return;
  const plan = typeof entry.plan === 'string' ? entry.plan.trim().slice(0, 40) : '';
  return {
    // Numbers carry when the vendor answered; a bare failure is stamped now.
    updatedAt: windows.size || creditsLeft !== undefined ? readAt : now,
    windows: [...windows.values()],
    ...(plan ? { plan } : {}),
    ...(creditsLeft !== undefined ? { credits: { remaining: creditsLeft } } : {}),
    read,
  };
}

const digest = (...parts: string[]) =>
  createHash('sha256').update(['beeline-usage-account-v1', ...parts].join('\0')).digest('hex').slice(0, 32);

/**
 * The plan account a report was read from, when the vendor verified it: a
 * hash of the account id and organization, so agents on one login share it
 * wherever their homes are. The id itself never leaves this process.
 */
export function quotaAxiAccountKey(report: unknown, provider: string): string | undefined {
  const providers = record(report)?.providers;
  if (!Array.isArray(providers)) return;
  const account = record(providers.map(record).find((p) => p?.provider === provider)?.account);
  if (account?.identityStatus !== 'verified' || typeof account.accountId !== 'string' || !account.accountId) return;
  return `id:${digest(provider, account.accountId, typeof account.organization === 'string' ? account.organization : '')}`;
}

class SignedOut extends Error {}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** Where quota-axi reads each proxied login, and that login as its store holds it. */
const QUOTA_STORES: Readonly<Record<ProxiedProvider, {
  dir: string; file: string; homeEnv: string;
  store: (accessToken: string | undefined, expiresAt: number, login: Record<string, unknown>) => unknown;
}>> = {
  claude: { dir: 'claude', file: '.credentials.json', homeEnv: 'CLAUDE_CONFIG_DIR',
    store: (accessToken, expiresAt) => ({ claudeAiOauth: { accessToken, expiresAt, scopes: ['user:inference', 'user:profile'] } }) },
  codex: { dir: 'codex', file: 'auth.json', homeEnv: 'CODEX_HOME',
    store: (accessToken, _expiresAt, login) => ({ auth_mode: 'chatgpt',
      tokens: { id_token: text(login.id_token), access_token: accessToken, account_id: text(login.account_id) } }) },
  xai: { dir: 'grok', file: 'auth.json', homeEnv: 'GROK_HOME',
    store: (accessToken, expiresAt, login) => ({ [`${XAI_ISSUER}::${XAI_CLIENT_ID}`]: {
      key: accessToken, auth_mode: 'oidc', email: text(login.email),
      expires_at: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : undefined,
      oidc_issuer: XAI_ISSUER, oidc_client_id: XAI_CLIENT_ID,
    } }) },
};

/**
 * Write the proxy's current access token where quota-axi reads this provider,
 * with no refresh token, and return the env that selects it.
 */
export async function proxiedQuotaHome(
  provider: ProxiedProvider,
  login: Record<string, unknown>,
  home: string,
): Promise<Record<string, string>> {
  const { dir, file, homeEnv, store } = QUOTA_STORES[provider];
  const value = store(text(login.access_token), Date.parse(text(login.expired) ?? ''), login);
  await writePrivateFileAtomically(join(home, dir, file), JSON.stringify(value));
  return { HOME: home, [homeEnv]: join(home, dir) };
}

export type QuotaAxiRun = (
  launch: { command: string; args: string[] },
  env: Record<string, string>,
) => Promise<string>;

/**
 * The quota-axi flags; never add a refresh, keychain or inference opt-in here.
 * `--full` adds the verified account id that keys a shared plan; it makes no
 * extra vendor call.
 */
export function quotaAxiArgs(provider: string): string[] {
  return ['--provider', provider, '--json', '--full', '--no-credential-refresh'];
}

/** Exit 1 still prints the report (every provider failed), so read stdout either way. */
const runQuotaAxi: QuotaAxiRun = async (launch, env) => {
  const result = await runOwned({
    step: 'quota-axi',
    file: launch.command,
    args: launch.args,
    env,
    onLine: () => undefined,
  });
  if (result.stdout) return result.stdout;
  throw new Error(
    result.code === 0
      ? 'quota-axi printed nothing'
      : `Command failed: ${[launch.command, ...launch.args].join(' ')}\n${result.stderr}`,
  );
};

type ReadSlot = {
  lastStartedAt: number;
  running?: Promise<AgentUsage>;
  last?: AgentUsage;
  /** Each agent's post of the latest read, so it lands once per agent. */
  posts: Map<string, { boundary: string; result: Promise<void> }>;
  publicationScope?:string;
  publicationSourceValid?:()=>boolean;
  publicationSourceInvalid?:boolean;
  /** The account the last verified read named, for reads that cannot say. */
  accountKey?: string;
};
/**
 * Every agent loop on this machine shares these slots, one per provider: the
 * machine holds one login for each (the proxy's, or Cursor's and OpenCode
 * Go's operator login), so its agents get one read per interval.
 */
const ACCOUNT_READ_SLOTS = new Map<string, ReadSlot>();

/** A new login makes every cached read stale; the next read asks again. */
export function invalidateQuotaReads(slots = ACCOUNT_READ_SLOTS): void {
  slots.clear();
}

const outcomeOf = (usage: AgentUsage): UsageRefreshOutcome =>
  usage.read && usage.read.status !== 'fresh'
    ? {
        status: usage.read.status,
        ...(usage.read.reason ? { reason: usage.read.reason } : {}),
        ...(usage.read.retryAfter ? { retryAfter: usage.read.retryAfter } : {}),
      }
    : { status: 'fresh' };

/**
 * Throttled plan reader for one agent. `publish` never throws and never
 * blocks the turn. At most one read per login runs at a time and one starts
 * per interval; an agent that arrives while a read runs joins it, and an
 * agent throttled behind a sibling still gets that sibling's latest read.
 */
export class HarnessQuotaReader {
  constructor(
    private readonly options: {
      agentId: string;
      post: (usage: AgentUsage) => Promise<unknown>;
      accountPublisher?:{scopeKey:()=>string;publicationKey?:()=>string;captureSource?:()=>()=>boolean;deliver:(usage:AgentUsage)=>Promise<boolean>};
      slots?: Map<string, ReadSlot>;
      run?: QuotaAxiRun;
      launch?: () => { command: string; args: string[] };
      now?: () => number;
      intervalMs?: number;
      proxy?: () => Promise<Pick<CliProxy, 'readLogin'> | undefined>;
    },
  ) {}

  /** Read (or share a read) and post it; resolves with what the read found. */
  publish(
    provider: string | undefined,
    env: Record<string, string>,
    force = false,
  ): Promise<UsageRefreshOutcome | undefined> {
    return provider ? this.start(provider, env, force) : Promise.resolve(undefined);
  }

  private start(
    provider: string,
    env: Record<string, string>,
    force: boolean,
  ): Promise<UsageRefreshOutcome | undefined> {
    const now = this.options.now?.() ?? Date.now();
    const publicationScope=this.options.accountPublisher?.scopeKey()??'legacy';
    const login = `${publicationScope}:${provider}`;
    const slots = this.options.slots ?? ACCOUNT_READ_SLOTS;
    let slot = slots.get(login);
    if (!slot) slots.set(login, (slot = { lastStartedAt: -Infinity, posts: new Map() }));
    if (slot.running) return this.deliver(slot, slot.running, login);
    if(slot.publicationSourceInvalid)Object.assign(slot,{lastStartedAt:-Infinity,last:undefined,posts:new Map(),accountKey:undefined,publicationSourceInvalid:false});
    const intervalMs = this.options.intervalMs ?? QUOTA_READ_INTERVAL_MS;
    const since = now - slot.lastStartedAt;
    if (since < (force ? REFRESH_REUSE_MS : intervalMs))
      return slot.last ? this.deliver(slot, Promise.resolve(slot.last), login) : Promise.resolve(undefined);
    // Turn-loop tests must never read the developer's real vendor quota.
    if (!this.options.run && process.env.VITEST) return Promise.resolve(undefined);
    const held = slot;
    held.lastStartedAt = now;
    held.publicationScope=publicationScope;
    held.publicationSourceValid=this.options.accountPublisher?.captureSource?.();
    held.publicationSourceInvalid=false;
    held.posts = new Map();
    held.running = this.read(provider, env, held, login, now).finally(() => {
      held.running = undefined;
    });
    return this.deliver(held, held.running, login);
  }

  private async read(
    provider: string,
    env: Record<string, string>,
    slot: ReadSlot,
    login: string,
    nowMs: number,
  ): Promise<AgentUsage> {
    const now = nowMs / 1000;
    let usage: AgentUsage;
    const proxied = agentBehavior(provider).cliProxy?.login;
    let home: string | undefined;
    try {
      let runEnv = env;
      if (proxied) {
        const login = await (await (this.options.proxy ?? machineCliProxy)())?.readLogin(proxied);
        // No proxy login for this provider: nothing to read until `/login`.
        if (!login) throw new SignedOut();
        await mkdir(cliProxyDir(env.HOME || homedir()), { recursive: true, mode: 0o700 });
        home = await mkdtemp(join(cliProxyDir(env.HOME || homedir()), 'quota-'));
        runEnv = { ...env, ...await proxiedQuotaHome(proxied, login, home) };
      }
      const launch = (this.options.launch ?? quotaAxiLaunch)();
      const stdout = await (this.options.run ?? runQuotaAxi)(
        { command: launch.command, args: [...launch.args, ...quotaAxiArgs(provider)] },
        runEnv,
      );
      const report: unknown = JSON.parse(stdout);
      const accountKey = quotaAxiAccountKey(report, provider);
      if (accountKey) slot.accountKey = accountKey;
      usage = quotaAxiUsage(report, provider, now) ?? {
        updatedAt: now, windows: [], read: { status: 'failed', at: now, reason: 'no plan numbers' },
      };
    } catch (error) {
      if (error instanceof SignedOut) usage = { updatedAt: now, windows: [], read: { status: 'signed_out', at: now } };
      else {
        console.error(`[agent-usage] quota-axi ${provider} read failed`, error instanceof Error ? error.message : error);
        usage = { updatedAt: now, windows: [], read: { status: 'failed', at: now, reason: "usage reader didn't run" } };
      }
    } finally {
      if (home) await rm(home, { recursive: true, force: true });
    }
    // Without a verified account the read stays with this machine's login, so
    // two different accounts are never merged.
    const key = slot.accountKey ?? `local:${digest(hostname(), login)}`;
    slot.publicationSourceInvalid=slot.publicationSourceValid?.()===false;
    slot.last = { ...usage, account: { provider, key } };
    return slot.last;
  }

  private async deliver(slot: ReadSlot, reading: Promise<AgentUsage>, login: string): Promise<UsageRefreshOutcome> {
    const usage = await reading;
    if((this.options.slots??ACCOUNT_READ_SLOTS).get(login)!==slot||slot.publicationSourceInvalid||slot.publicationScope!==undefined&&slot.publicationScope!==(this.options.accountPublisher?.scopeKey()??'legacy'))
      return {status:'failed',reason:'usage ownership changed during read'};
    const agentId = this.options.agentId;
    const boundary=this.options.accountPublisher?.publicationKey?.()??this.options.accountPublisher?.scopeKey()??'legacy';
    let posted = slot.posts.get(agentId);
    if (!posted || posted.boundary!==boundary) {
      const result = (async()=>{
        if(await this.options.accountPublisher?.deliver(usage))return;
        await this.options.post(usage);
      })();
      posted={boundary,result};
      // Keep only this agent's latest actor; connection churn cannot grow the
      // shared provider read's post bookkeeping.
      slot.posts.set(agentId, posted);
    }
    try {
      await posted.result;
    } catch (error) {
      if (slot.posts.get(agentId) === posted) slot.posts.delete(agentId);
      console.error('[agent-usage] quota post failed', error instanceof Error ? error.message : error);
      return { status: 'failed', reason: "couldn't save the read" };
    }
    return outcomeOf(usage);
  }
}
