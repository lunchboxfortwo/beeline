import { expect, it, vi } from 'vitest';
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
      cornerActivityKey: 'run:0',
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
