import { expect, it, vi } from 'vitest';
import { agentTurnSteps, asyncTaskCall, finalAgentMessageText, toolCallEntries } from './acp.js';
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

it('keeps interleaved call openings and notes in order when a result follows the reply', () => {
  const updates = [
    { sessionUpdate: 'agent_message_chunk', content: 'Checking the inputs.' },
    { sessionUpdate: 'tool_call', name: 'fetch_credential' },
    { sessionUpdate: 'tool_result', content: 'synthetic credential output' },
    { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read' },
    { sessionUpdate: 'agent_message_chunk', content: 'Checking the build.' },
    { sessionUpdate: 'tool_call_update', title: 'Build', status: 'in_progress' },
    { sessionUpdate: 'tool_result', content: 'Build passed' },
    { sessionUpdate: 'agent_message_chunk', content: 'The build passed.' },
    { sessionUpdate: 'tool_result', toolCallId: 'read', content: 'Inputs read' },
  ].map(update => ({ sessionId: 'session', update }));

  expect(finalAgentMessageText(updates)).toBe('The build passed.');
  expect(agentTurnSteps(updates)).toEqual([
    { kind: 'note', text: 'Checking the inputs.' },
    { kind: 'tool', call: { id: 'anonymous-0', name: 'fetch_credential', content: '[REDACTED]', resultReceived: true } },
    { kind: 'tool', call: { id: 'read', title: 'Read', content: 'Inputs read', resultReceived: true } },
    { kind: 'note', text: 'Checking the build.' },
    { kind: 'tool', call: { id: 'anonymous-1', title: 'Build', status: 'in_progress', content: 'Build passed', resultReceived: true } },
  ]);

  const readPayload = vi.fn(() => 'Unseen tool output');
  expect(finalAgentMessageText([...updates, { sessionId: 'session', update: {
    sessionUpdate: 'tool_result',
    toolCallId: 'unseen',
    get rawOutput() { return readPayload(); },
  } }])).toBe('');
  expect(readPayload).not.toHaveBeenCalled();
});

it('defaults async_task_progress without state to in_progress and preserves stopped reason', () => {
  expect(
    asyncTaskCall({
      sessionUpdate: 'async_task_progress',
      asyncTaskId: 'bg-1',
      description: 'Run integration suite',
      output: 'Running 4 of 12',
    }),
  ).toEqual({
    id: 'async:bg-1',
    title: 'Run integration suite',
    status: 'in_progress',
    rawOutput: { output: 'Running 4 of 12' },
  });

  expect(
    asyncTaskCall({
      sessionUpdate: 'async_task_state_update',
      asyncTaskId: 'bg-1',
      state: 'stopped',
    }),
  ).toEqual({
    id: 'async:bg-1',
    status: 'failed',
    rawOutput: { error: 'Stopped (background task)' },
  });
});

it('projects ACP plan session updates into agentTurnSteps', () => {
  const steps = agentTurnSteps([
    {
      sessionId: 's1',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Audit wire guards', status: 'completed' },
          { content: 'Update ToolOutputSheet', status: 'in_progress' },
        ],
      },
    },
  ]);
  expect(steps).toEqual([
    {
      kind: 'tool',
      call: {
        id: 'acp-plan',
        name: 'plan',
        title: 'Updated plan',
        kind: 'plan',
        status: 'completed',
        rawInput: {
          items: [
            { step: 'Audit wire guards', status: 'completed' },
            { step: 'Update ToolOutputSheet', status: 'in_progress' },
          ],
        },
      },
    },
  ]);
});
