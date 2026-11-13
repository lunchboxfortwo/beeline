import { RECLAIMED_REPLY_REFUSAL } from '@beeline/api-contract/helper-turn-ownership';
import { expect, it, vi } from 'vitest';
import { AgentTurnStream } from './turn-stream.js';
import { DaemonApiError, type DaemonApiClient } from './daemon-api-client.js';
import { AgentTurnDeadline, AGENT_TURN_DEADLINE_MS } from './agent-turn-deadline.js';

it.each([false,true])('reclaimed reply returns a visible failure and retries exactly once (retry fails: %s)', async fails => {
  const execute = vi.fn(async (name: string) => {
    if (name === 'postRoomMessage' && (fails || execute.mock.calls.filter(([n])=>n===name).length === 1))
      throw new DaemonApiError(RECLAIMED_REPLY_REFUSAL.message,RECLAIMED_REPLY_REFUSAL.status,false);
    return {};
  });
  const failure = vi.spyOn(console,'error').mockImplementation(()=>{});
  try {
    const stream = new AgentTurnStream({api:{execute} as unknown as DaemonApiClient,agentId:'agent',roomId:'room',requestId:'request',label:'test'});
    if (fails) await expect(stream.settle('Answer')).rejects.toThrow('workflow generation ended');
    else await stream.settle('Answer');
    expect(execute.mock.calls.filter(([n])=>n==='postRoomMessage')).toHaveLength(2);
    expect(failure).toHaveBeenCalledWith(expect.stringContaining('not delivered; retrying once:'),expect.stringContaining('workflow generation ended'));
  } finally {failure.mockRestore();}
});

it('a model that never returns hits the deadline and stops its harness', async () => {
  vi.useFakeTimers();
  try {
    const stop = vi.fn();
    const running = new AgentTurnDeadline().run(() => new Promise<never>(()=>{}),stop);
    const failure = expect(running).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(AGENT_TURN_DEADLINE_MS);
    await failure;
    expect(stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {vi.useRealTimers();}
});
