import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import type { PromptResult } from './acp.js';
import { dependencyRequest } from './dependency-generation.js';
import { EMPTY_INSTITUTIONAL_CONTEXT } from './institutional-context.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { monolithCornerTurnLoopPrompt } from './monolith-corner-turn-prompt.js';
import { CORNER_DELIVERY_NUDGE } from './prompt-assembly.js';
import { identityFromKey } from './runtime.js';

const exec = promisify(execFile);

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// The request can come from the first prompt or from a later attempt in the
// same turn: the retry after a provider fallback, or the delivery follow-up.
// The continuation itself may request a second mount; it settles the same way.
it.each([
  { requestedBy: 'the first prompt', fallback: false, deliver: false },
  { requestedBy: 'the provider fallback retry', fallback: true, deliver: false },
  { requestedBy: 'the delivery follow-up', fallback: false, deliver: true },
].flatMap(variant => [1, 2].map(mounts => ({ ...variant, mounts }))))(
  'Reproduction DEPS-1: mounts dependencies requested by $requestedBy ($mounts mounts) and continues the same turn with them',
  async ({ fallback, deliver, mounts }) => {
  const checkout = await mkdtemp(resolve(tmpdir(), 'corner-deps-'));
  roots.push(checkout);
  // Uncommitted work in the checkout is what earns the delivery follow-up.
  if (deliver) {
    await exec('git', ['init', '--quiet', checkout]);
    await writeFile(resolve(checkout, 'screen.tsx'), 'export {};\n');
  }
  const mounted = resolve(checkout, 'apps/mobile/node_modules/proof');
  const item = { id: 'request', authorId: 'human', type: 'message' as const, body: 'Fix the phone screen', attachments: [], createdAt: 0 };
  const execute = vi.fn(async (name: string, _input: Record<string, unknown>) => {
    if (name === 'getInstitutionalContext') return EMPTY_INSTITUTIONAL_CONTEXT;
    if (name === 'getRoomConversation') return { items: [] };
    if (name === 'listRoomCorners') return { corners: [] };
    if (name === 'listCornerBriefRevisions') return { revisions: [] };
    return {};
  });
  const loop = new MonolithCornerTurnLoop({
    runtime: { supervisorRoot: checkout, agent: { ...identityFromKey('11'.repeat(32), 'Bee'), secretKeyHex: '11'.repeat(32) } },
    config: { agentKind: 'codex', agentCommand: 'codex-acp', agentEnv: {}, bwrapPath: '/usr/bin/bwrap' },
    api: { execute }, worktreePath: checkout, cornerId: 'corner', parentRoomId: 'room',
    repository: { githubToken: 'fixture', featureBranch: 'feature', targetBranch: 'main', gitCommonDir: resolve(checkout, '.git') },
    scheduler: { snapshot: () => ({}), run: async (_id: string, _lifecycle: unknown, task: () => Promise<void>) => task() },
  } as never);
  try {
    vi.spyOn(loop, 'lifecycle').mockReturnValue({} as never);
    vi.spyOn(loop, 'roster').mockResolvedValue({ members: [] } as never);
    vi.spyOn(loop, 'repositoryState').mockResolvedValue({} as never);
    vi.spyOn(loop, 'captureTurnMetrics').mockResolvedValue({});
    vi.spyOn(loop, 'writeBackClaudeLogin').mockResolvedValue();
    vi.spyOn(loop, 'repinNextProvider').mockResolvedValue(fallback ? 'fixture-provider' : undefined);
    vi.spyOn(loop, 'servingProviders').mockReturnValue([]);
    if (deliver) vi.spyOn(loop, 'explainEmpty').mockResolvedValue(undefined);
    if (fallback) vi.spyOn(loop, 'explainEmpty')
      .mockResolvedValueOnce({ reason: 'synthetic empty completion' } as never).mockResolvedValue(undefined);
    vi.spyOn(loop, 'withCheckout').mockImplementation(async task => task());
    vi.spyOn(loop, 'syncBranch').mockResolvedValue();
    vi.spyOn(loop, 'restoredState').mockResolvedValue({ objective: 'Help',
      brief: { repositoryWork: deliver, spec: 'Fix the phone screen', revision: 1, attachments: [] } } as never);
    vi.spyOn(loop, 'activeReviewerInstruction').mockResolvedValue(undefined);
    vi.spyOn(loop.commandContext, 'notePromptSections').mockImplementation(() => {});
    // Cold activation is the step that prepares and mounts the requested
    // generation (corner-mobile-dependencies.test.ts covers it). Here it
    // stands in for that step at the same boundary.
    const activate = vi.spyOn(loop, 'activate').mockImplementation(async () => {
      if (existsSync(resolve(checkout, dependencyRequest))) {
        await mkdir(mounted, { recursive: true });
        await rm(resolve(checkout, dependencyRequest));
      }
      return 'session';
    });
    vi.spyOn(loop, 'sessionIsCurrent').mockResolvedValue(true);
    loop.sessionId = 'session';
    loop.repositoryWork = deliver;
    loop.commandContext.current = {
      id: 'command', roomId: 'corner', turnRequestId: item.id, reason: 'human_message', source: item,
      agentId: loop.agent.publicKey, sourceMessageId: item.id, action: 'input',
      rootCommandId: 'command', rootSourceMessageId: item.id, agentDepth: 0,
    } satisfies AgentCommand;
    const reply = (agentText: string): PromptResult => ({ stopReason: 'end_turn', agentText, toolCalls: [], updates: [] });
    const prompts: string[] = [];
    const requestAt = fallback || deliver ? 2 : 1;
    const sessionPrompt = vi.fn(async (...args: unknown[]) => {
      prompts.push(JSON.stringify(args));
      if (prompts.length < requestAt) return reply(deliver ? 'Edited the phone screen.' : '');
      if (prompts.length >= requestAt && prompts.length < requestAt + mounts) {
        // The agent runs `npm run corner:prepare -- --mobile` inside the sandbox.
        await writeFile(resolve(checkout, dependencyRequest), 'mobile');
        return reply('Requested the mobile dependencies.');
      }
      expect(existsSync(mounted)).toBe(true);
      return reply('Fixed the phone screen with the mobile dependencies.');
    });
    loop.client = { sessionPrompt, preparePromptDelivery: vi.fn(), promptDelivery: () => undefined, canPromptWithImages: () => false } as never;
    const activationsBefore = activate.mock.calls.length;

    await monolithCornerTurnLoopPrompt(loop, item.id, item.body);

    expect(sessionPrompt).toHaveBeenCalledTimes(requestAt + mounts);
    expect(activate.mock.calls.length - activationsBefore).toBeGreaterThanOrEqual(mounts);
    for (let continued = requestAt; continued < requestAt + mounts; continued += 1)
      expect(prompts[continued]).toContain('this is the same turn continuing');
    if (deliver) expect(prompts[1]).toContain(JSON.stringify(CORNER_DELIVERY_NUDGE).slice(1, 40));
    expect(existsSync(resolve(checkout, dependencyRequest))).toBe(false);
    const published = JSON.stringify(execute.mock.calls);
    expect(published).toContain('Fixed the phone screen with the mobile dependencies.');
    expect(execute).not.toHaveBeenCalledWith('postAgentTurnReceipt', expect.objectContaining({ status: 'failed' }));
  } finally { loop.squireRelay.close(); }
  },
);
