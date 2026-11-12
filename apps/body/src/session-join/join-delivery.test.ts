import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { deliver, renderWake, acceptMemberDelivery, flush } from './bridge.js';
import { antigravityOnce } from './pull-apps.js';
import { queueInbox, readState, takeInbox, updateState, type JoinedSession } from './store.js';
import * as BeelineApi from './beeline-api.js';
import * as SessionAgents from './agents.js';
import { findOwnSession, runSessionCommand } from './command.js';

const root = join(process.cwd(), '.beeline-proof');
const folders: string[] = [];
const scratch = () => {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'join-delivery-'));
  folders.push(dir);
  return dir;
};
const runner = { node: '/synthetic/node', bundle: '/synthetic/beeline.mjs' };
const joined = (cwd: string, agent: 'codex' | 'antigravity' = 'codex'): JoinedSession => ({
  key: `${agent}:${cwd}`,
  agent,
  cwd,
  name: 'Jane agent',
  server: 'https://synthetic.invalid',
  clientId: 'same-consented-client',
  refreshToken: 'fixture-refresh',
  cursor: '0',
  deliveredWakes: [],
  joinedAt: '',
  sessionId: 'host-conversation',
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('JOIN-DELIVERY local hosts', () => {
  it.each(['--help', '-h'])('join %s prints usage before host discovery, network or state writes', async flag => {
    const dir = scratch();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const detect = vi.spyOn(SessionAgents, 'detectAgent').mockImplementation(() => { throw new Error('Help must not discover a host'); });
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await runSessionCommand(['join', flag], { HOME: dir, XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir });
    expect(log).toHaveBeenCalledWith('Usage: usebeeline join [--name <name>] [--server <url>] [--host <host>] [--conversation <id>]\nJoin from the running coding session; approve the printed sign-in link on any device.\nHeadless Grok: usebeeline join --host grok --name my-grok\nOptions: --help, -h  Show this help without signing in.');
    expect(detect).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });
  it('uses a host-reported Codex thread when discovery has no matching process', () => {
    const found = findOwnSession(
      { BEELINE_SESSION_AGENT: 'codex', CODEX_THREAD_ID: 'host-reported-thread' },
      scratch(),
    );
    expect(found.sessionId).toBe('host-reported-thread');
  });
  it('names every supported host and the headless Grok alternative when no session is detected', () => {
    vi.spyOn(SessionAgents, 'detectAgent').mockReturnValue(undefined);
    let message = '';
    try { findOwnSession({}, scratch()); } catch (error) { message = (error as Error).message; }
    for (const host of SessionAgents.AGENTS) expect(message).toContain(SessionAgents.agentLabel(host));
    expect(message).toContain('join --host grok --name my-grok');
  });
  it('recognizes headless Grok for the link-based join without a native OAuth TUI', () => {
    expect(
      findOwnSession({ BEELINE_SESSION_AGENT: 'grok', GROK_SESSION_ID: 'grok-thread' }, scratch()),
    ).toMatchObject({ agent: 'grok', sessionId: 'grok-thread' });
  });
  it('uses the Antigravity current conversation on the initial join before hooks have ever run', () => {
    const found = findOwnSession(
      { BEELINE_SESSION_AGENT: 'antigravity', ANTIGRAVITY_SESSION_ID: 'app-conversation' },
      scratch(),
    );
    expect(found.sessionId).toBe('app-conversation');
  });
  it('delivers the server-created receipt through the Codex queue once, without fabricating a host receipt', async () => {
    const dir = scratch(),
      session = joined(dir);
    await updateState(dir, (state) => state.sessions.push(session));
    const receipt = {
      generation: 'server-generation',
      nonce: 'server-nonce',
      conversation: session.sessionId!,
    };
    const wake = {
      id: receipt.generation,
      address: receipt.conversation,
      reason: 'join_probe',
      kind: 'join_probe',
      createdAt: '2026-11-07T00:00:00Z',
      receipt,
    };
    expect(renderWake(wake, session, runner)).toContain('tool confirm_delivery');
    const frame = {
      v: 1,
      type: 'delivery',
      deliveryId: `wake:${wake.id}`,
      mentions: [],
      wakes: [wake],
      mentionCursor: '0',
    };
    expect(await acceptMemberDelivery(dir, session.key, runner, frame)).toBe(1);
    const queued = vi.fn(async () => {}),
      post = vi.fn(async () => {});
    expect(
      await deliver(
        dir,
        session,
        { agent: 'codex', sessionId: session.sessionId! },
        { queueCodex: queued, postClaude: post, codexBusy: () => false },
      ),
    ).toContain('idle Codex');
    expect(queued).toHaveBeenCalledWith(
      'codex',
      session.sessionId,
      expect.stringContaining(JSON.stringify(receipt)),
    );
    expect(post).not.toHaveBeenCalled();
    expect(await acceptMemberDelivery(dir, session.key, runner, frame)).toBe(0);
    expect(takeInbox(dir, session.key)).toBe('');
    expect(readState(dir).sessions[0]).not.toHaveProperty('receipt_at');
  });
  it.each([undefined, 'local'] as const)('backfills a live unchanged legacy session with mechanism %s once', async mechanism => {
    const dir = scratch(), session = joined(dir);
    session.deliveryMechanism = mechanism;
    session.pid = 123;
    await updateState(dir, state => state.sessions.push(session));
    vi.spyOn(BeelineApi, 'accessToken').mockResolvedValue('fixture-token');
    const setup = vi.spyOn(BeelineApi, 'callTool').mockResolvedValue({ delivery: { generation: 'bound-generation' } });
    const sources = { claude: () => [], codex: () => [], hooks: () => [{ agent: 'codex' as const,
      sessionId: session.sessionId!, pid: session.pid, cwd: dir, seenAt: Date.now() }] };
    await flush(dir, sources);
    expect(setup).toHaveBeenCalledWith(expect.anything(), 'fixture-token', 'setup_delivery', {
      mechanism: 'local', host: 'codex', surface: 'local_session', conversation: session.sessionId, installed: true,
    });
    expect(readState(dir).sessions[0]).toMatchObject({ deliveryGeneration: 'bound-generation', deliveryMechanism: 'local' });
    await flush(dir, sources);
    expect(setup).toHaveBeenCalledOnce();
  });
  it('reproduces a joined Codex host that rejects its queue: work stays owed and no watcher resend occurs', async () => {
    const dir = scratch(),
      session = joined(dir);
    queueInbox(dir, session.key, 'one delivery check');
    const queued = vi.fn(async () => {
      throw new Error('the isolated host endpoint has no such thread');
    });
    const deps = { queueCodex: queued, postClaude: vi.fn(async () => {}), codexBusy: () => false };
    const target = { agent: 'codex' as const, sessionId: session.sessionId! };
    expect(await deliver(dir, session, target, deps)).toContain(
      'left waiting: the isolated host endpoint',
    );
    expect(await deliver(dir, session, target, deps)).toContain('waiting for host recovery');
    expect(queued).toHaveBeenCalledOnce();
    expect(takeInbox(dir, session.key)).toBe('one delivery check');
  });
  it('Antigravity sidecar hands a new arrival to the exact idle App conversation', async () => {
    const dir = scratch(),
      session = joined(dir, 'antigravity');
    await updateState(dir, (state) => state.sessions.push(session));
    queueInbox(dir, session.key, 'join probe for idle App');
    const send = vi.fn(async () => {});
    const hooks = [
      {
        agent: 'antigravity' as const,
        sessionId: session.sessionId!,
        cwd: dir,
        state: 'idle' as const,
        seenAt: Date.now(),
      },
    ];
    expect(await antigravityOnce(dir, hooks, send)).toBe(1);
    expect(send).toHaveBeenCalledWith(session.sessionId, 'join probe for idle App');
    expect(await antigravityOnce(dir, hooks, send)).toBe(0);
    queueInbox(dir, session.key, 'keep this for the bound conversation');
    expect(
      await antigravityOnce(dir, [{ ...hooks[0]!, sessionId: 'another-conversation' }], send),
    ).toBe(0);
    expect(takeInbox(dir, session.key)).toBe('keep this for the bound conversation');
  });
});
