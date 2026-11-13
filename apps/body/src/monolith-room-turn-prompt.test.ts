import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { type PromptResult, type ToolCallEntry } from './acp.js';
import { EMPTY_INSTITUTIONAL_CONTEXT } from './institutional-context.js';
import { MonolithRoomTurnLoop, type ActiveTurn } from './monolith-room-turn.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { monolithRoomTurnLoopPrompt } from './monolith-room-turn-prompt.js';
import { monolithCornerTurnLoopPrompt } from './monolith-corner-turn-prompt.js';
import { identityFromKey } from './runtime.js';

afterEach(() => vi.restoreAllMocks());

function fixture(surface: 'room' | 'corner', calls: ToolCallEntry[], freeAgent = false) {
  const item = { id: 'request', authorId: 'human', type: 'message' as const, body: 'ok go', attachments: [], createdAt: 0 };
  const execute = vi.fn(async (name: string, _input: Record<string, unknown>) => {
    if (name === 'getInstitutionalContext') return EMPTY_INSTITUTIONAL_CONTEXT;
    if (name === 'getRoomConversation') return { items: [] };
    if (name === 'listRoomCorners') return { corners: [] };
    if (name === 'listCornerBriefRevisions') return { revisions: [] };
    return {};
  });
  const options = {
    runtime: { agent: { ...identityFromKey('11'.repeat(32), 'Monarch'), secretKeyHex: '11'.repeat(32) } },
    config: { agentKind: 'codex', agentCommand: 'codex-acp', agentEnv: freeAgent ? { BEELINE_FREE_AGENT_ID: 'monarch' } : {} },
    api: { execute }, roomId: 'room', cornerId: 'room', parentRoomId: 'parent',
    scheduler: { snapshot: () => ({}), run: async (_id: string, _lifecycle: unknown, task: () => Promise<void>) => task() },
  };
  const loop = surface === 'room'
    ? new MonolithRoomTurnLoop(options as never)
    : new MonolithCornerTurnLoop(options as never);
  vi.spyOn(loop, 'lifecycle').mockReturnValue({} as never);
  vi.spyOn(loop, 'roster').mockResolvedValue({ members: [] } as never);
  vi.spyOn(loop, 'repositoryState').mockResolvedValue({} as never);
  vi.spyOn(loop, 'captureTurnMetrics').mockResolvedValue({});
  vi.spyOn(loop, 'writeBackClaudeLogin').mockResolvedValue();
  const repin = vi.spyOn(loop, 'repinNextProvider').mockResolvedValue(undefined);
  vi.spyOn(loop.commandContext, 'notePromptSections').mockImplementation(() => {});
  loop.sessionId = 'session';
  loop.commandContext.current = {
    id: 'command', roomId: 'room', turnRequestId: item.id, reason: 'human_message', source: item,
    agentId: loop.agent.publicKey, sourceMessageId: item.id, action: 'input',
    rootCommandId: 'command', rootSourceMessageId: item.id, agentDepth: 0,
  } satisfies AgentCommand;
  const result: PromptResult = {
    stopReason: 'end_turn', agentText: '', toolCalls: calls,
    updates: calls.flatMap((call) => [
      { sessionId: 'session', update: { sessionUpdate: 'tool_call', toolCallId: call.id, title: call.title } },
      { sessionId: 'session', update: { sessionUpdate: 'tool_call_update', toolCallId: call.id, status: call.status } },
    ]),
  };
  const sessionPrompt = vi.fn(async () => {
    for (const call of calls) {
      if (call.status === 'completed' && !(call.rawOutput as { isError?: boolean })?.isError) {
        if (call.title === 'mcp__beeline-agent__post')
          await execute('postCornerMessage', { cornerId: 'room', requestId: item.id, text: 'The callas are in the cart. What sender details should I use?' });
        if (call.title === 'mcp__beeline-agent__report')
          await execute('reportToCommander', { text: 'done: delivered' });
      }
    }
    return result;
  });
  loop.client = { sessionPrompt, preparePromptDelivery: vi.fn(), promptDelivery: () => undefined, canPromptWithImages: () => false } as never;
  if (loop instanceof MonolithRoomTurnLoop) {
    vi.spyOn(loop, 'deliver').mockResolvedValue([]);
  } else {
    vi.spyOn(loop, 'withCheckout').mockImplementation(async task => task());
    vi.spyOn(loop, 'syncBranch').mockResolvedValue();
    vi.spyOn(loop, 'restoredState').mockResolvedValue({ objective: 'Help', brief: { repositoryWork: true, spec: 'Help with the request', revision: 1, attachments: [] } } as never);
    vi.spyOn(loop, 'activeReviewerInstruction').mockResolvedValue(undefined);
  }
  const run = () => loop instanceof MonolithRoomTurnLoop
    ? monolithRoomTurnLoopPrompt(loop, { item, steers: [], steerTail: Promise.resolve(), cancelled: false } as unknown as ActiveTurn)
    : monolithCornerTurnLoopPrompt(loop, item.id, item.body);
  return { loop, run, execute, sessionPrompt, repin, result };
}

describe.each(['room', 'corner'] as const)('%s tool-delivered answers', surface => {
  it.each([
    { tool: 'post', freeAgent: true }, { tool: 'report', freeAgent: true },
    { tool: 'post', freeAgent: false }, { tool: 'report', freeAgent: false },
  ])('completes after $tool then empty end_turn despite an unrelated failed tool (free agent: $freeAgent)', async ({ tool, freeAgent }) => {
    const f = fixture(surface, [
      { id: 'lookup', title: 'browser', status: 'failed' },
      { id: 'answer', title: `mcp__beeline-agent__${tool}`, status: 'completed' },
    ], freeAgent);
    if (tool === 'report') f.loop.commandContext.current = { ...f.loop.commandContext.current!, reason: 'order' };
    try {
      await f.run();
      expect(f.sessionPrompt).toHaveBeenCalledOnce();
      expect(f.repin).not.toHaveBeenCalled();
      expect(f.execute.mock.calls.filter(([name]) => name === 'postAgentTurnReceipt').map(([, input]) => input.status)).toEqual(['complete']);
      expect(f.execute.mock.calls.filter(([name]) => name === 'postRoomMessage')).toEqual([]);
      expect(f.execute.mock.calls.some(([name]) => name === (tool === 'post' ? 'postCornerMessage' : 'reportToCommander'))).toBe(true);
      // Working state belongs to the turn, not an empty durable transcript row.
      expect(f.execute.mock.calls.filter(([name, input]) => name === 'postAgentActivity' &&
        (input.activity as { kind: string }[]).some(activity => activity.kind === 'thinking'))).toEqual([]);
      expect(f.execute).toHaveBeenCalledWith('retractAgentLiveOutput', expect.objectContaining({ kind: 'draft' }));
    } finally {
      f.loop.squireRelay.close();
    }
  });

  it.each(['failed', 'in_progress', 'refused'] as const)('keeps the empty-turn failure path when the post is %s', async status => {
    const f = fixture(surface, [{ id: 'lookup', title: 'browser', status: 'failed' }, { id: 'post', title: 'mcp__beeline-agent__post',
      status: status === 'refused' ? 'completed' : status,
      ...(status === 'refused' ? { rawOutput: { isError: true } } : {}),
    }]);
    try {
      await expect(f.run()).rejects.toThrow('harness ended the turn (end_turn) with no answer text');
      expect(f.repin).toHaveBeenCalledOnce();
      expect(f.execute).toHaveBeenCalledWith('postAgentTurnReceipt', expect.objectContaining({ status: 'failed' }));
    } finally {
      f.loop.squireRelay.close();
    }
  });

  it('still retries an unanswered turn on the next provider', async () => {
    const f = fixture(surface, [{ id: 'lookup', title: 'browser', status: 'failed' }]);
    f.repin.mockResolvedValueOnce('next-provider');
    f.sessionPrompt.mockResolvedValueOnce(f.result).mockResolvedValueOnce({
      stopReason: 'end_turn', agentText: 'Recovered answer', toolCalls: [], updates: [],
    });
    try {
      await f.run();
      expect(f.sessionPrompt).toHaveBeenCalledTimes(2);
      expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({ text: 'Recovered answer' }));
      expect(f.execute.mock.calls.filter(([name]) => name === 'postAgentTurnReceipt').map(([, input]) => input.status)).toEqual(['complete']);
    } finally {
      f.loop.squireRelay.close();
    }
  });
});
