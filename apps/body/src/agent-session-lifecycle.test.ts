import { afterEach, expect, it, vi } from 'vitest';
import * as lifecycle from './agent-session-lifecycle.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';

afterEach(() => vi.restoreAllMocks());

it.each([['Room', MonolithRoomTurnLoop], ['corner', MonolithCornerTurnLoop]] as const)(
  '%s applies shared activation cleanup without replacing the startup error', async (_surface, Loop) => {
    const shared = vi.spyOn(lifecycle, 'activateAgentSession');
    const failure = new Error('session creation failed');
    const cleanupFailure = new Error('process stop failed');
    const stopped = vi.fn(async () => { throw cleanupFailure; });
    const forgotten = vi.fn();
    // Exercise the actual surface methods without creating a runtime or reading logins.
    const loop = Object.assign(Object.create(Loop.prototype), {
      options: { config: {} }, commandContext: { path: 'current-command' },
      warmTranscript: { forgetSession: forgotten },
      refreshTurnCheckout: vi.fn(async () => undefined),
      stopClaudeLoginWatch: vi.fn(),
      activateCold: vi.fn(async () => {
        loop.client = { isAlive: true, stopProcess: stopped };
        loop.sessionId = 'partially-created';
        loop.sessionContextPath = 'current-command';
        throw failure;
      }),
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(loop.activate()).rejects.toBe(failure);
    expect(shared).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledOnce();
    expect(loop.client).toBeUndefined();
    expect(loop.sessionId).toBeUndefined();
    expect(loop.sessionContextPath).toBeUndefined();
    expect(forgotten).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      '[body] failed to stop harness after activation failure:', cleanupFailure,
    );
  },
);
