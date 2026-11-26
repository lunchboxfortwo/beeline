import { describe, expect, it, vi } from 'vitest';
import { readAgentUsage, usageSummary } from '@beeline/api-contract/daemon';
import { delimiter } from 'node:path';
import { parseAcpUsage } from './acp.js';
import { HarnessQuotaReader, invalidateQuotaReads, quotaAxiArgs, quotaAxiLaunch, quotaAxiProvider, quotaAxiUsage } from './harness-quota.js';
import { QUOTA_AXI_AGY_REPORT, QUOTA_AXI_CLAUDE_REPORT, QUOTA_AXI_CODEX_CURSOR_REPORT } from '../../../packages/test-helpers/helpers/helper.js';

// Claude, Codex and Grok read the machine proxy's current login.
vi.mock('./cliproxy.js', async (original) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'quota-proxy-'));
  return {
    ...(await original<typeof import('./cliproxy.js')>()),
    cliProxyDir: () => dir,
    machineCliProxy: async () => ({ readLogin: async () => ({ access_token: 'proxy-access', expired: '2026-11-18T00:00:00Z' }) }),
  };
});

const now = Date.parse('2026-10-20T02:22:23.939Z') / 1000;

describe('quota-axi plan usage (Reproduction R2)', () => {
  it('reads the Codex usage update codex-acp 2.2.2 sent on squire as context only', () => {
    // Recorded from a real codex-acp session: no plan windows in any update or _meta.
    expect(parseAcpUsage({ sessionUpdate: 'usage_update', used: 12967, size: 475000 })).toMatchObject({
      windows: [],
      context: { used: 12967, size: 475000 },
    });
  });

  it('turns the recorded Codex report into a weekly window, plan and credits', () => {
    expect(quotaAxiUsage(QUOTA_AXI_CODEX_CURSOR_REPORT, 'codex', now)).toEqual({
      updatedAt: now,
      windows: [
        {
          rateLimitType: 'weekly',
          status: 'allowed',
          utilization: 0.47,
          resetsAt: Date.parse('2026-10-24T20:43:11.000Z') / 1000,
          updatedAt: now,
          label: 'week',
        },
      ],
      plan: 'pro',
      credits: { remaining: 62174.920478 },
      read: { status: 'fresh', at: now },
    });
  });

  it('turns the recorded Cursor report into its monthly and weekly windows', () => {
    const usage = quotaAxiUsage(QUOTA_AXI_CODEX_CURSOR_REPORT, 'cursor', now)!;
    expect(usage.plan).toBe('Ultra');
    expect(usage.windows.map((w) => [w.rateLimitType, w.utilization, w.label])).toEqual([
      ['included_usage', 0, 'included usage'],
      ['auto_usage', 0, 'auto usage'],
      ['api_usage', 0, 'API usage'],
      ['grok_bot', 0, 'Grok Bot'],
    ]);
    expect(usage.credits).toBeUndefined();
  });

  it('ignores unknown fields, unusable windows and unavailable providers', () => {
    expect(quotaAxiUsage({ providers: [{ provider: 'grok', state: { status: 'unavailable' }, windows: [] }] }, 'grok', now)).toEqual({
      updatedAt: now, windows: [], read: { status: 'failed', at: now, reason: 'unavailable' },
    });
    expect(quotaAxiUsage({ providers: [{ provider: 'grok', state: { status: 'fresh' }, windows: [] }] }, 'grok', now)).toBeUndefined();
    expect(quotaAxiUsage({ providers: 'x' }, 'codex', now)).toBeUndefined();
    const usage = quotaAxiUsage({
      providers: [{
        provider: 'codex',
        future: true,
        windows: [
          { id: 'model:gpt-6', percentRemaining: 0, resetsAt: 'soon' },
          { id: 'five_hour', percentRemaining: 'half' },
          { percentRemaining: 50 },
        ],
        credits: { remaining: 5, unit: 'usd' },
      }],
    }, 'codex', now)!;
    expect(usage.windows).toEqual([
      { rateLimitType: 'model_gpt', status: 'rejected', utilization: 1, updatedAt: now },
    ]);
    expect(usage.credits).toBeUndefined();
  });

  it('turns the recorded Claude report into session, weekly and Fable windows', () => {
    const usage = quotaAxiUsage(QUOTA_AXI_CLAUDE_REPORT, 'claude', now)!;
    expect(usage.plan).toBe('max');
    expect(usage.windows.map((w) => [w.rateLimitType, w.utilization, w.label])).toEqual([
      ['five_hour', 0.09, 'session'],
      ['seven_day', 0.28, 'week'],
      ['model_fable', 0, 'Fable week'],
    ]);
  });

  it('never opts quota-axi into a credential refresh, keychain prompt or Claude inference', () => {
    expect(quotaAxiArgs('claude')).toEqual(['--provider', 'claude', '--json', '--full', '--no-credential-refresh']);
  });

  it('asks quota-axi for every harness it covers and not for OpenRouter keys', () => {
    expect(quotaAxiProvider('codex', false)).toBe('codex');
    expect(quotaAxiProvider('cursor', false)).toBe('cursor');
    expect(quotaAxiProvider('grok', false)).toBe('grok');
    expect(quotaAxiProvider('opencode', false)).toBe('opencode-go');
    expect(quotaAxiProvider('opencode', true)).toBeUndefined();
    expect(quotaAxiProvider('antigravity', false)).toBe('agy');
    expect(quotaAxiProvider('antigravity', true)).toBeUndefined();
    expect(quotaAxiProvider('claude', false)).toBe('claude');
    expect(quotaAxiProvider('claude', true)).toBeUndefined();
    expect(quotaAxiProvider('pi', false)).toBeUndefined();
  });

  it('runs the bundled copy beside the Beeline CLI inside a release', () => {
    expect(quotaAxiLaunch('beeline:bundle', '/opt/lib/beeline/beeline-cli.mjs').args).toEqual([
      '/opt/lib/beeline/quota-axi.mjs',
    ]);
    expect(quotaAxiLaunch().args[0]).toMatch(/quota-axi[/\\]dist[/\\]bin[/\\]quota-axi\.js$/);
  });

  it('reads in the agent environment at most once per interval and never throws', async () => {
    let clock = 0;
    const post = vi.fn(async () => undefined);
    const run = vi.fn(async () => JSON.stringify(QUOTA_AXI_CODEX_CURSOR_REPORT));
    const reader = new HarnessQuotaReader({ agentId: 'a', slots: new Map(), post, run, now: () => clock, launch: () => ({ command: 'node', args: ['q.mjs'] }) });
    const env = { CODEX_HOME: '/agent/codex' };
    await reader.publish('codex', env);
    await reader.publish('codex', env);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      { command: 'node', args: ['q.mjs', '--provider', 'codex', '--json', '--full', '--no-credential-refresh'] },
      expect.objectContaining({ CODEX_HOME: expect.stringMatching(/quota-.*codex$/) }),
    );
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ plan: 'pro' }));
    clock += 5 * 60_000;
    run.mockRejectedValueOnce(new Error('timeout'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(reader.publish('codex', env)).resolves.toEqual({ status: 'failed', reason: "usage reader didn't run" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ windows: [], read: expect.objectContaining({ status: 'failed' }) }));
    error.mockRestore();
    await reader.publish(undefined, env);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('shares one read per interval across the chat and thread loops of one agent', async () => {
    let clock = 0;
    const slots = new Map();
    const run = vi.fn(async () => JSON.stringify(QUOTA_AXI_CODEX_CURSOR_REPORT));
    const launch = () => ({ command: 'node', args: ['q.mjs'] });
    const reader = (agentId: string) =>
      new HarnessQuotaReader({ agentId, slots, run, launch, now: () => clock, post: async () => undefined });
    const room = reader('agent-a');
    const corner = reader('agent-a');
    const env = { CODEX_HOME: '/agent/codex' };
    // Two loops start reads at the same instant; one reaches the vendor.
    await Promise.all([room.publish('codex', env), corner.publish('codex', env)]);
    expect(run).toHaveBeenCalledTimes(1);
    clock += 60_000;
    await corner.publish('codex', env);
    expect(run).toHaveBeenCalledTimes(1);
    // Every agent on this machine reads the proxy's one Codex login.
    await reader('agent-b').publish('codex', env);
    expect(run).toHaveBeenCalledTimes(1);
    await reader('agent-c').publish('codex', { CODEX_HOME: '/other/codex' });
    expect(run).toHaveBeenCalledTimes(1);
    clock += 5 * 60_000;
    await corner.publish('codex', env);
    expect(run).toHaveBeenCalledTimes(2);
  });
});


it('an explicit refresh bypasses the automatic interval and posts a new snapshot', async () => {
  let clock = 0;
  const run = vi.fn(async () => JSON.stringify(QUOTA_AXI_CODEX_CURSOR_REPORT));
  const post = vi.fn(async () => undefined);
  const reader = new HarnessQuotaReader({ agentId: 'manual', slots: new Map(), run, post, now: () => clock, launch: () => ({ command: 'node', args: [] }) });
  const env = { CODEX_HOME: '/agent/codex' };
  await reader.publish('codex', env);
  await reader.publish('codex', env);
  // A refresh straight after a read shares it rather than asking the vendor again.
  await expect(reader.publish('codex', env, true)).resolves.toEqual({ status: 'fresh' });
  expect(run).toHaveBeenCalledTimes(1);
  clock += 30_000;
  await reader.publish('codex', env, true);
  expect(run).toHaveBeenCalledTimes(2);
  expect(post).toHaveBeenCalledTimes(2);
});

import { describe as m18_describe, expect as m18_expect, it as m18_it, vi as m18_vi } from 'vitest';

import type { AgentUsage as m18_AgentUsage } from '@beeline/api-contract/daemon';

import { HarnessQuotaReader as m18_HarnessQuotaReader, QUOTA_READ_INTERVAL_MS as m18_QUOTA_READ_INTERVAL_MS, quotaAxiUsage as m18_quotaAxiUsage } from "./harness-quota.js";

import { QUOTA_AXI_CLAUDE_REPORT as m18_QUOTA_AXI_CLAUDE_REPORT } from "../../../packages/test-helpers/helpers/helper.js";
import { describe as mergedDescribe18 } from 'vitest';
mergedDescribe18("harness-quota.usage-truth.test.ts", () => {


const now = Date.parse('2026-10-28T14:00:00.000Z') / 1000;

const threeHoursAgo = new Date((now - 3 * 3600) * 1000).toISOString();

const claude = m18_QUOTA_AXI_CLAUDE_REPORT.providers[0]!;

const launch = () => ({ command: 'node', args: ['q.mjs'] });

/** A Claude report as `--full --json` prints it, with a verified account. */
const verified = (accountId: string, state: Record<string, unknown> = { status: 'fresh', stale: false }) => ({
  ...m18_QUOTA_AXI_CLAUDE_REPORT,
  providers: [{ ...claude, account: { accountId, organization: 'org-1', identityStatus: 'verified' }, state }],
});


m18_describe('R-USAGE-3: a stale quota-axi report keeps its read time and status', () => {
  m18_it('stamps the windows with refreshedAt, not now, and carries the stale reason', () => {
    const usage = m18_quotaAxiUsage({
      providers: [{ ...claude, state: { status: 'stale', stale: true, refreshedAt: threeHoursAgo, error: 'fetch failed' } }],
    }, 'claude', now)!;
    m18_expect(usage.updatedAt).toBe(now - 3 * 3600);
    m18_expect(usage.windows.every((w) => w.updatedAt === now - 3 * 3600)).toBe(true);
    m18_expect(usage.read).toEqual({ status: 'stale', at: now, reason: 'fetch failed' });
  });

  m18_it('stamps a stale credit-only Codex read with refreshedAt and keeps its balance', () => {
    const usage = m18_quotaAxiUsage({
      providers: [{
        provider: 'codex', windows: [], credits: { unit: 'credits', remaining: 123 },
        state: { status: 'stale', stale: true, refreshedAt: threeHoursAgo, error: 'network failed' },
      }],
    }, 'codex', now)!;
    m18_expect(usage).toMatchObject({ updatedAt: now - 3 * 3600, windows: [], credits: { remaining: 123 } });
    m18_expect(usage.read).toEqual({ status: 'stale', at: now, reason: 'network failed' });
  });

  m18_it('names an expired sign-in and a rate limit with its retry time', () => {
    const expired = m18_quotaAxiUsage({
      providers: [{ ...claude, state: { status: 'stale', stale: true, refreshedAt: threeHoursAgo, reason: 'credentials_expired' } }],
    }, 'claude', now)!;
    m18_expect(expired.read?.status).toBe('signed_out');
    const limited = m18_quotaAxiUsage({
      providers: [{ ...claude, windows: [], state: { status: 'rate_limited', stale: false, retryAfter: '2026-10-28T14:20:00.000Z' } }],
    }, 'claude', now)!;
    m18_expect(limited.read).toEqual({ status: 'rate_limited', at: now, retryAfter: now + 20 * 60 });
    m18_expect(limited.windows).toEqual([]);
  });
});


m18_describe('one read per plan account on this machine', () => {
  m18_it('lets a second agent on the same login join the read in flight and get its own copy', async () => {
    let finish!: (stdout: string) => void;
    const run = m18_vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const posts: Array<[string, m18_AgentUsage]> = [];
    const slots = new Map();
    const reader = (agentId: string) => new m18_HarnessQuotaReader({
      agentId, slots, run, launch, now: () => now * 1000,
      post: async (usage) => { posts.push([agentId, usage]); },
    });
    const first = reader('ruby').publish('claude', { CLAUDE_CONFIG_DIR: '/agents/ruby/claude' }, true);
    const second = reader('nerd').publish('claude', { CLAUDE_CONFIG_DIR: '/agents/nerd/claude' }, true);
    await m18_vi.waitFor(() => m18_expect(finish).toBeDefined());
    finish(JSON.stringify(verified('acct-1')));
    await m18_expect(first).resolves.toEqual({ status: 'fresh' });
    await m18_expect(second).resolves.toEqual({ status: 'fresh' });
    m18_expect(run).toHaveBeenCalledTimes(1);
    m18_expect(posts.map(([agent]) => agent).sort()).toEqual(['nerd', 'ruby']);
    m18_expect(posts[0]![1]).toEqual(posts[1]![1]);
    m18_expect(posts[0]![1].account).toEqual({ provider: 'claude', key: m18_expect.stringMatching(/^id:[0-9a-f]{32}$/) });
  });

  m18_it("gives an agent throttled behind a sibling that sibling's read, once, without a vendor call", async () => {
    let clock = now * 1000;
    const run = m18_vi.fn(async () => JSON.stringify(verified('acct-1')));
    const posts: string[] = [];
    const slots = new Map();
    const reader = (agentId: string) => new m18_HarnessQuotaReader({
      agentId, slots, run, launch, now: () => clock,
      post: async () => { posts.push(agentId); },
    });
    await reader('ruby').publish('claude', {});
    clock += 60_000;
    await m18_expect(reader('nerd').publish('claude', {})).resolves.toEqual({ status: 'fresh' });
    await reader('nerd').publish('claude', {});
    m18_expect(run).toHaveBeenCalledTimes(1);
    m18_expect(posts).toEqual(['ruby', 'nerd']);
  });

  m18_it('keys the account by the verified id, never the email, and keeps it for a later stale read', async () => {
    const slots = new Map();
    const posts: m18_AgentUsage[] = [];
    const run = m18_vi.fn(async () => JSON.stringify(verified('acct-1')));
    const reader = new m18_HarnessQuotaReader({
      agentId: 'ruby', slots, run, launch, now: () => now * 1000,
      post: async (usage) => { posts.push(usage); },
    });
    await reader.publish('claude', {}, true);
    run.mockResolvedValueOnce(JSON.stringify({
      providers: [{ ...claude, state: { status: 'stale', stale: true, refreshedAt: threeHoursAgo, reason: 'credentials_expired' } }],
    }));
    const later = new m18_HarnessQuotaReader({
      agentId: 'ruby', slots, run, launch, now: () => (now + 3600) * 1000,
      post: async (usage) => { posts.push(usage); },
    });
    await m18_expect(later.publish('claude', {}, true)).resolves.toEqual({ status: 'signed_out' });
    m18_expect(posts[1]!.account).toEqual(posts[0]!.account);
    m18_expect(JSON.stringify(posts)).not.toContain('acct-1');
  });

  m18_it('gives every agent on the machine one read per provider', async () => {
    const run = m18_vi.fn(async () => JSON.stringify(verified('acct-1')));
    const slots = new Map();
    const reader = (agentId: string) => new m18_HarnessQuotaReader({ agentId, slots, run, launch, now: () => now * 1000, post: async () => {} });
    await reader('ruby').publish('claude', {});
    await reader('nerd').publish('claude', {});
    m18_expect(run).toHaveBeenCalledTimes(1);
  });

  m18_it('reads a proxied provider without a proxy login as signed out, without running the reader', async () => {
    const run = m18_vi.fn(async () => JSON.stringify(verified('acct-1')));
    const posts: m18_AgentUsage[] = [];
    const reader = new m18_HarnessQuotaReader({
      agentId: 'ruby', slots: new Map(), run, launch, now: () => now * 1000,
      post: async (usage) => { posts.push(usage); },
      proxy: async () => ({ readLogin: async () => undefined }),
    });
    await m18_expect(reader.publish('claude', {}, true)).resolves.toEqual({ status: 'signed_out' });
    m18_expect(run).not.toHaveBeenCalled();
    m18_expect(posts[0]).toMatchObject({ windows: [], read: { status: 'signed_out' } });
  });

  m18_it('hands quota-axi an access-token-only copy of the proxy login', async () => {
    const { proxiedQuotaHome } = await import('./harness-quota.js');
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = await mkdtemp(join(tmpdir(), 'quota-home-'));
    const login = { access_token: 'access', refresh_token: 'refresh', id_token: 'id', account_id: 'acct',
      expired: '2026-11-18T00:00:00.000Z', email: 'owner@example.com' };
    const expected = {
      claude: { claudeAiOauth: { accessToken: 'access', expiresAt: 1794960000000, scopes: ['user:inference', 'user:profile'] } },
      codex: { auth_mode: 'chatgpt', tokens: { id_token: 'id', access_token: 'access', account_id: 'acct' } },
      xai: { 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
        key: 'access', auth_mode: 'oidc', email: 'owner@example.com', expires_at: '2026-11-18T00:00:00.000Z',
        oidc_issuer: 'https://auth.x.ai', oidc_client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
      } },
    };
    try {
      for (const provider of ['claude', 'codex', 'xai'] as const) {
        const env = await proxiedQuotaHome(provider, login, join(home, provider));
        const homeEnv = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', xai: 'GROK_HOME' }[provider];
        const text = await readFile(join(env[homeEnv]!, provider === 'claude' ? '.credentials.json' : 'auth.json'), 'utf8');
        m18_expect(JSON.parse(text)).toEqual(expected[provider]);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  m18_it('answers a failed read with a reason instead of dropping it', async () => {
    const error = m18_vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const posts: m18_AgentUsage[] = [];
    const reader = new m18_HarnessQuotaReader({
      agentId: 'ruby', slots: new Map(), launch, now: () => now * 1000,
      run: async () => { throw new Error('spawn failed'); },
      post: async (usage) => { posts.push(usage); },
    });
    await m18_expect(reader.publish('claude', {}, true)).resolves.toEqual({ status: 'failed', reason: "usage reader didn't run" });
    m18_expect(posts[0]).toMatchObject({ windows: [], read: { status: 'failed' }, account: { provider: 'claude' } });
    m18_expect(posts[0]!.account!.key).toMatch(/^local:[0-9a-f]{32}$/);
    error.mockRestore();
  });
});
});

it('drops cached account bindings when a provider signs in again', async () => {
  const slots = new Map();
  const post = vi.fn(async (_usage: import('@beeline/api-contract/daemon').AgentUsage) => {});
  const report = (accountId: string, percentRemaining: number) => JSON.stringify({ providers: [{
    provider: 'cursor', account: { identityStatus: 'verified', accountId }, state: { status: 'fresh' },
    windows: [{ id: 'monthly', percentRemaining }],
  }] });
  const run = vi.fn().mockResolvedValueOnce(report('old-account', 10)).mockResolvedValueOnce(report('new-account', 90));
  const reader = new HarnessQuotaReader({ agentId: 'cache-test', slots, post, run, now: () => 0, launch: () => ({ command: 'quota', args: [] }) });
  await reader.publish('cursor', {});
  const old = post.mock.calls[0]![0];
  invalidateQuotaReads(slots);
  await reader.publish('cursor', {}, true);
  expect(run).toHaveBeenCalledTimes(2);
  expect(post.mock.calls[1]![0]).toMatchObject({ windows: [{ utilization: 0.1 }] });
  expect(post.mock.calls[1]![0].account!.key).not.toBe(old.account!.key);
});

it('discards an older in-flight quota read after provider invalidation', async () => {
  const slots = new Map();
  let finish!: (report: string) => void;
  const old = new Promise<string>(resolve => { finish = resolve; });
  const post = vi.fn(async (_usage: import('@beeline/api-contract/daemon').AgentUsage) => {});
  const report = (remaining: number) => JSON.stringify({ providers: [{ provider: 'cursor', state: { status: 'fresh' },
    windows: [{ id: 'monthly', percentRemaining: remaining }] }] });
  const run = vi.fn().mockReturnValueOnce(old).mockResolvedValueOnce(report(90));
  const reader = new HarnessQuotaReader({ agentId: 'race-test', slots, post, run, now: () => 0, launch: () => ({ command: 'quota', args: [] }) });
  const pending = reader.publish('cursor', {});
  invalidateQuotaReads(slots);
  await reader.publish('cursor', {}, true);
  finish(report(10));
  await expect(pending).resolves.toMatchObject({ status: 'failed' });
  expect(post).toHaveBeenCalledOnce();
  expect(post.mock.calls[0]![0]).toMatchObject({ windows: [{ utilization: 0.1 }] });
  await reader.publish('cursor', {});
  expect(run).toHaveBeenCalledTimes(2);
});

describe('Antigravity quota-axi reporting (Reproduction R-AGY-USAGE)', () => {
  const agyNow = Date.parse(QUOTA_AXI_AGY_REPORT.generatedAt) / 1000;
  const agyEntry = QUOTA_AXI_AGY_REPORT.providers[0]!;

  it('treats a live agy report whose only past resets are the 1970 epoch sentinel as fresh', () => {
    const usage = quotaAxiUsage(QUOTA_AXI_AGY_REPORT, 'agy', agyNow)!;
    expect(usage.read).toEqual({ status: 'fresh', at: agyNow });
    expect(usage.windows).toEqual([
      {
        rateLimitType: 'gemini_h',
        status: 'allowed',
        utilization: 0.88,
        resetsAt: Date.parse('2026-11-26T18:48:36.000Z') / 1000,
        updatedAt: agyNow,
        label: 'Gemini 5-hour',
      },
      {
        rateLimitType: 'gemini_weekly',
        status: 'allowed',
        utilization: 0.23,
        resetsAt: Date.parse('2026-12-03T13:48:36.000Z') / 1000,
        updatedAt: agyNow,
        label: 'Gemini weekly',
      },
      {
        rateLimitType: 'claude_gpt_h',
        status: 'allowed',
        utilization: 0,
        updatedAt: agyNow,
        label: 'Claude/GPT 5-hour',
      },
      {
        rateLimitType: 'claude_gpt_weekly',
        status: 'allowed',
        utilization: 0,
        updatedAt: agyNow,
        label: 'Claude/GPT weekly',
      },
    ]);
    const validated = readAgentUsage({
      ...usage,
      account: { provider: 'agy', key: `local:${'a'.repeat(32)}` },
    });
    expect(validated).toBeDefined();
    const summary = usageSummary(validated, agyNow);
    expect(summary).toContain('gemini 5-hour 88% (resets ');
    expect(summary).toContain('gemini weekly 23% (resets ');
    expect(summary).toContain('claude/gpt 5-hour 0%, claude/gpt weekly 0%');
    expect(summary).not.toContain("couldn't read");
    expect(summary).not.toContain('1970');
  });

  it('keeps genuinely stale agy reports stale (cache, real expired reset, error, or failed attempts)', () => {
    const earlier = new Date((agyNow - 3600) * 1000).toISOString();

    const cached = quotaAxiUsage({
      ...QUOTA_AXI_AGY_REPORT,
      providers: [{
        ...agyEntry,
        source: 'cache',
        attempts: [{ source: 'cli', status: 'failed', error: 'timed out' }],
        state: { status: 'stale', stale: true, refreshedAt: earlier, error: 'timed out', sourcesTried: ['cli', 'cache'] },
      }],
    }, 'agy', agyNow)!;
    expect(cached.read).toEqual({ status: 'stale', at: agyNow, reason: 'timed out' });
    expect(cached.updatedAt).toBe(agyNow - 3600);

    const realExpired = quotaAxiUsage({
      ...QUOTA_AXI_AGY_REPORT,
      providers: [{
        ...agyEntry,
        windows: [
          { ...agyEntry.windows[0]!, resetsAt: earlier },
          ...agyEntry.windows.slice(1),
        ],
      }],
    }, 'agy', agyNow)!;
    expect(realExpired.read).toEqual({ status: 'stale', at: agyNow });

    const withError = quotaAxiUsage({
      ...QUOTA_AXI_AGY_REPORT,
      providers: [{
        ...agyEntry,
        state: { ...agyEntry.state, error: 'upstream degraded' },
      }],
    }, 'agy', agyNow)!;
    expect(withError.read).toEqual({ status: 'stale', at: agyNow, reason: 'upstream degraded' });

    const noSuccessAttempt = quotaAxiUsage({
      ...QUOTA_AXI_AGY_REPORT,
      providers: [{
        ...agyEntry,
        attempts: [{ source: 'cli', status: 'failed', error: 'exit 1' }],
      }],
    }, 'agy', agyNow)!;
    expect(noSuccessAttempt.read).toEqual({ status: 'stale', at: agyNow });

    const noEpochSentinel = quotaAxiUsage({
      ...QUOTA_AXI_AGY_REPORT,
      providers: [{
        ...agyEntry,
        windows: agyEntry.windows.slice(0, 2),
      }],
    }, 'agy', agyNow)!;
    expect(noEpochSentinel.read).toEqual({ status: 'stale', at: agyNow });

    // A real Gemini window expiring after generatedAt but before consumption stays stale.
    const consumedAfterReset = Date.parse('2026-11-26T18:49:00.000Z') / 1000;
    const expiredBeforeConsumption = quotaAxiUsage(QUOTA_AXI_AGY_REPORT, 'agy', consumedAfterReset)!;
    expect(expiredBeforeConsumption.read).toEqual({ status: 'stale', at: consumedAfterReset });
  });

  it('augments PATH for agy reads so quota-axi finds agy in non-interactive helper environments', async () => {
    const posts: Array<import('@beeline/api-contract/daemon').AgentUsage> = [];
    const run = vi.fn(async () => JSON.stringify(QUOTA_AXI_AGY_REPORT));
    const reader = new HarnessQuotaReader({
      agentId: 'crayon',
      slots: new Map(),
      run,
      post: async (usage) => { posts.push(usage); },
      now: () => agyNow * 1000,
      launch: () => ({ command: 'node', args: ['q.mjs'] }),
    });
    const outcome = await reader.publish('agy', { HOME: '/home/operator', PATH: '/usr/bin:/bin' }, true);
    expect(outcome).toEqual({ status: 'fresh' });
    expect(run).toHaveBeenCalledWith(
      { command: 'node', args: ['q.mjs', '--provider', 'agy', '--json', '--full', '--no-credential-refresh'] },
      expect.objectContaining({ HOME: '/home/operator' }),
    );
    const passedPath = run.mock.calls[0]![1].PATH!.split(delimiter);
    expect(passedPath.slice(0, 2)).toEqual(['/usr/bin', '/bin']);
    expect(passedPath).toContain('/home/operator/.local/bin');
    expect(posts[0]).toMatchObject({
      read: { status: 'fresh', at: agyNow },
      account: { provider: 'agy', key: expect.stringMatching(/^local:[0-9a-f]{32}$/) },
    });
  });
});
