import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { DaemonApiError } from './daemon-api-client.js';
import { RoomSupervisor } from './room-supervisor.js';

afterEach(() => vi.restoreAllMocks());

it('reconnects after a lock-timeout intake failure and reads again only after live open', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let liveOpen: (() => void) | undefined;
  const off = vi.fn(() => { liveOpen = undefined; });
  const api = {
    onLiveOpen: vi.fn((listener: () => void) => { liveOpen = listener; return off; }),
    reconnectLive: vi.fn(),
  };
  const run = vi.fn()
    .mockRejectedValueOnce(new DaemonApiError('canceling statement due to lock timeout', 503, true))
    .mockResolvedValueOnce(undefined);
  const controller = new AbortController();
  const running = new RoomSupervisor(api).supervise('Room bb91a1c7', controller.signal, run);
  try {
    await setImmediate();
    expect(api.reconnectLive).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    liveOpen!();
    await running;
    expect(run).toHaveBeenCalledTimes(2);
    expect(off).toHaveBeenCalledOnce();
  } finally {
    controller.abort();
    await running;
  }
});

it('returns after a successful intake without reconnecting', async () => {
  const api = { onLiveOpen: vi.fn(), reconnectLive: vi.fn() };
  const run = vi.fn().mockResolvedValue(undefined);
  await new RoomSupervisor(api).supervise('Room', undefined, run);
  expect(run).toHaveBeenCalledOnce();
  expect(api.reconnectLive).not.toHaveBeenCalled();
  expect(api.onLiveOpen).not.toHaveBeenCalled();
});

it('exits an aborted intake failure without reconnecting or waiting for live open', async () => {
  const controller = new AbortController();
  const api = { onLiveOpen: vi.fn(), reconnectLive: vi.fn() };
  const run = vi.fn(async () => { controller.abort(); throw new Error('aborted'); });
  await new RoomSupervisor(api).supervise('Room', controller.signal, run);
  expect(run).toHaveBeenCalledOnce();
  expect(api.reconnectLive).not.toHaveBeenCalled();
  expect(api.onLiveOpen).not.toHaveBeenCalled();
});

it('exits immediately when aborted while awaiting live open', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const controller = new AbortController();
  const off = vi.fn();
  const api = { onLiveOpen: vi.fn(() => off), reconnectLive: vi.fn() };
  const run = vi.fn().mockRejectedValue(new DaemonApiError('canceling statement due to lock timeout', 503, true));
  const running = new RoomSupervisor(api).supervise('Room', controller.signal, run);
  await setImmediate();
  controller.abort();
  await running;
  expect(run).toHaveBeenCalledOnce();
  expect(api.reconnectLive).toHaveBeenCalledOnce();
  expect(off).toHaveBeenCalledOnce();
});
