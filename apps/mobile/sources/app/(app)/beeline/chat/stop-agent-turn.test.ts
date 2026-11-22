import { beforeEach, expect, it, vi } from 'vitest';

const { alert, operation, MonolithRequestTimeoutError } = vi.hoisted(() => ({
  alert: vi.fn(), operation: vi.fn(), MonolithRequestTimeoutError: class extends Error {},
}));
vi.mock('@/modal', () => ({ Modal: { alert: (...args: unknown[]) => alert(...args) } }));
vi.mock('@/auth/monolith-session', () => ({ MonolithRequestTimeoutError }));
vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: (...args: unknown[]) => operation(...args),
  phoneOperationFailureReason: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { requestAgentTurnStop } from './stop-agent-turn';

const stop = { agentPubkey: 'agent', requestId: 'request' };

beforeEach(() => {
  alert.mockReset();
  operation.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

it('shows a dialog and rereads the Room when the server refuses Stop', async () => {
  operation.mockRejectedValue(new Error('running turn not found'));
  const readRoom = vi.fn();
  expect(await requestAgentTurnStop('room', stop, readRoom)).toBe(false);
  expect(operation).toHaveBeenCalledWith('cancelAgentTurn', { roomId: 'room', requestId: 'request', agentId: 'agent' });
  expect(alert).toHaveBeenCalledWith('Stop failed', 'running turn not found');
  expect(readRoom).toHaveBeenCalledTimes(1);
});

it('names an unknown result when Stop times out', async () => {
  operation.mockRejectedValue(new MonolithRequestTimeoutError('timed out'));
  expect(await requestAgentTurnStop('room', stop, vi.fn())).toBe(false);
  expect(alert).toHaveBeenCalledWith('Stop result unknown', 'timed out');
});

it('shows nothing when Stop succeeds', async () => {
  operation.mockResolvedValue({});
  const readRoom = vi.fn();
  expect(await requestAgentTurnStop('room', stop, readRoom)).toBe(true);
  expect(alert).not.toHaveBeenCalled();
  expect(readRoom).not.toHaveBeenCalled();
});
