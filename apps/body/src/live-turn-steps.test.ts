import { expect, it, vi } from 'vitest';
import { toolCallEntries, asyncTaskCall } from './acp.js';
import { LiveTurnSteps } from './live-turn-steps.js';
import type { DaemonApiClient } from './daemon-api-client.js';

it('publishes each completed step before the prompt returns and omits it from the final history', async () => {
  const execute = vi.fn().mockResolvedValue({});
  const stream = new LiveTurnSteps({ execute } as unknown as DaemonApiClient, {
    agentId: 'agent',
    roomId: 'room',
    requestId: 'turn',
    invocationId: 'run',
  });
  const first = { id: 'one', title: 'Read source', status: 'in_progress' };
  stream.onToolCalls([first]);
  await Promise.resolve();
  expect(execute).not.toHaveBeenCalled();
  const done = { ...first, status: 'completed', content: 'source text' };
  stream.onToolCalls([done]);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  expect(execute).toHaveBeenCalledWith(
    'postAgentActivity',
    expect.objectContaining({
      cornerActivityKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      activity: [expect.objectContaining({ title: 'Read source', status: 'completed' })],
    }),
  );
  stream.onToolCalls([done, { id: 'two', title: 'Run checks', status: 'failed' }]);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  stream.onToolCalls([done]);
  expect(
    await stream.remaining([
      { kind: 'tool', call: done },
      { kind: 'note', text: 'Summary' },
    ]),
  ).toEqual([{ kind: 'note', text: 'Summary' }]);
  expect(execute).toHaveBeenCalledTimes(2);
});

it('retains a failed live write in the final history', async () => {
  const execute = vi.fn().mockRejectedValue(new Error('disconnected'));
  const stream = new LiveTurnSteps({ execute } as unknown as DaemonApiClient, {
    agentId: 'agent',
    roomId: 'room',
    requestId: 'turn',
    invocationId: 'run',
  });
  const call = { id: 'one', title: 'Read', status: 'completed' };
  stream.onToolCalls([call]);
  expect(await stream.remaining([{ kind: 'tool', call }])).toEqual([{ kind: 'tool', call }]);
});


it('keeps a background completion and a later tool visible when their snapshot positions overlap', async () => {
  const ledger = new Map<string, unknown>();
  const execute = vi.fn(async (_name, input) => {
    if (ledger.has(input.cornerActivityKey)) throw new Error('activity key already exists');
    ledger.set(input.cornerActivityKey, input.activity);
    return {};
  });
  const stream = new LiveTurnSteps({ execute } as unknown as DaemonApiClient, {
    agentId: 'agent', roomId: 'room', requestId: 'turn', invocationId: 'run',
  });
  const first = { id: 'first', title: 'Start build', status: 'completed' };
  const background = asyncTaskCall({ sessionUpdate: 'async_task_state_update',
    asyncTaskId: 'build', name: 'Build finished', state: 'completed' })!;
  stream.onToolCalls([first, background]);
  await stream.remaining([]);
  const later = { id: 'later', title: 'Read build output', status: 'completed' };
  // ACP lists ordinary calls before background tasks, so the task moves right.
  stream.onToolCalls([first, later, background]);
  await stream.remaining([]);
  expect([...ledger.values()]).toEqual([
    [expect.objectContaining({ title: 'Start build', status: 'completed' })],
    [expect.objectContaining({ title: 'Build finished', status: 'completed' })],
    [expect.objectContaining({ title: 'Read build output', status: 'completed' })],
  ]);
  expect(await stream.remaining([{ kind: 'tool', call: later }])).toEqual([]);
  expect(execute).toHaveBeenCalledTimes(3);
});

it('publishes a result without terminal status as completed and deduplicates its later completed update', async () => {
  const execute = vi.fn().mockResolvedValue({});
  const stream = new LiveTurnSteps({ execute } as unknown as DaemonApiClient, {
    agentId: 'agent', roomId: 'room', requestId: 'turn', invocationId: 'run',
  });
  const updates = [
    { sessionId: 'session', update: { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read', status: 'in_progress' } },
    { sessionId: 'session', update: { sessionUpdate: 'tool_result', toolCallId: 'read', content: 'File contents' } },
  ];
  stream.onToolCalls(toolCallEntries(updates));
  await stream.remaining([]);
  expect(execute).toHaveBeenCalledWith('postAgentActivity', expect.objectContaining({
    activity: [expect.objectContaining({ status: 'completed', output: 'File contents' })],
  }));
  const done = toolCallEntries([...updates, { sessionId: 'session', update: {
    sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed',
  } }]);
  stream.onToolCalls(done);
  expect(await stream.remaining(done.map(call => ({ kind: 'tool', call })))).toEqual([]);
  expect(execute).toHaveBeenCalledTimes(1);
});
