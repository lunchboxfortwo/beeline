import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import { RoomEvent } from 'livekit-client';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({
  listeners: new Map<string, (...args: any[]) => void>(),
  request: vi.fn(), closeAudio: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
  connect: vi.fn(async () => {}), microphone: vi.fn(async () => {}),
  publish: vi.fn(async (_bytes: Uint8Array, _options?: unknown) => {}),
  resync: undefined as undefined | (() => void), connected: undefined as undefined | (() => void),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: {} }));
vi.mock('./voice-transport', () => ({
  subscribeVoiceMicrophone: () => () => {}, subscribeVoiceResume: () => () => {},
  loadVoiceClient: () => import('livekit-client'),
  createVoiceRoom: async () => ({
    configureStop: async () => {}, closeAudio: fixture.closeAudio,
    room: { on: (event: string, listener: (...args: any[]) => void) => fixture.listeners.set(event, listener),
      canPlaybackAudio: true, connect: fixture.connect, startAudio: async () => {}, disconnect: fixture.disconnect,
      localParticipant: { setMicrophoneEnabled: fixture.microphone, publishData: fixture.publish } },
  }),
}));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: fixture.request }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({
  register: async (_filters: unknown, listener: () => void) => { fixture.resync = listener; return () => { fixture.resync = undefined; }; },
  subscribeConnected: (listener: () => void) => { fixture.connected = listener; return () => { fixture.connected = undefined; }; },
}) }));
vi.mock('./client-error-report', () => ({ reportClientError: async () => {} }));
import { useVoiceCall } from './use-voice-call';
beforeEach(() => {
  vi.clearAllMocks(); fixture.request.mockReset(); fixture.listeners.clear();
  fixture.resync = fixture.connected = undefined;
});

it('MOBILE-11 leaves a dropped join ready for an explicit next attempt', async () => {
  fixture.request.mockRejectedValueOnce(Object.assign(new Error('The connection closed before the server answered.'), { socketRequest: true }));
  let state!: ReturnType<typeof useVoiceCall>;
  function Screen() { state = useVoiceCall('room', true); return null; }
  let tree: any;
  await act(async () => { tree = create(<Screen />); });
  try {
    await act(async () => { await state.join(); });
    expect(state.connecting).toBe(false);
    expect(state.call).toBeNull();
    expect(state.error).toBe('Conversation mode could not start');
    expect(fixture.request).toHaveBeenCalledTimes(1);
  } finally { await act(async () => tree.unmount()); fixture.request.mockReset(); fixture.disconnect.mockClear(); fixture.closeAudio.mockClear(); }
});

it('W4 releases a failed microphone join, explains it, and accepts the next explicit join', async () => {
  fixture.request.mockImplementation(async name => name === 'voiceJoin' ? {
    call: { id: 'call', participants: [] }, sessionId: 'session', stopToken: 'stop',
    agents: [], url: 'wss://voice.invalid', token: 'fixture',
  } : { left: true });
  fixture.microphone.mockRejectedValueOnce(Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' }));
  let state!: ReturnType<typeof useVoiceCall>;
  function Screen() { state = useVoiceCall('room', true); return null; }
  let tree: any;
  await act(async () => { tree = create(<Screen />); });
  try {
    await act(async () => { await state.join(); });
    expect(state.call).toBeNull();
    expect(state.connecting).toBe(false);
    expect(state.agents).toEqual([]);
    expect(state.target).toBeNull();
    expect(state.error).toBe('No microphone was found.');
    expect(fixture.disconnect).toHaveBeenCalledOnce();
    expect(fixture.closeAudio).toHaveBeenCalledOnce();
    expect(fixture.request).toHaveBeenLastCalledWith('voiceLeave', { callId: 'call', sessionId: 'session' });
    await act(async () => { await state.join(); });
    expect(state.call?.id).toBe('call');
    expect(state.error).toBeNull();
  } finally { await act(async () => tree.unmount()); }
});

it('reconnects RTC once to the same durable call without sending Leave and preserves mute', async () => {
  fixture.request.mockImplementation(async name => name === 'voiceJoin' ? {
    call: { id: 'call', participants: [] }, sessionId: 'session', stopToken: 'stop',
    agents: [], url: 'wss://voice.invalid', token: 'fixture',
  } : { left: true });
  let state!: ReturnType<typeof useVoiceCall>;
  function Screen() { state = useVoiceCall('room', true); return null; }
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<Screen />); });
  try {
    await act(async () => { await state.join(); });
    expect(state.call?.id).toBe('call');
    await act(async () => { await state.toggleMute(); });
    await act(async () => { fixture.listeners.get(RoomEvent.Disconnected)!(); });
    expect(state.call?.id).toBe('call');
    expect(state.muted).toBe(true);
    expect(fixture.request.mock.calls).toEqual([
      ['voiceJoin', { roomId: 'room' }], ['voiceJoin', { roomId: 'room', expectedCallId: 'call' }],
    ]);
    expect(fixture.microphone).toHaveBeenLastCalledWith(false, expect.any(Object));
    expect(fixture.connect).toHaveBeenCalledTimes(2);
    expect(fixture.disconnect).not.toHaveBeenCalled();
    expect(fixture.closeAudio).not.toHaveBeenCalled();
  } finally { await act(async () => tree.unmount()); }
});

it('one socket reconnect makes one covering state read and keeps the retained RTC call', async () => {
  let answer!: (state: { state: string }) => void;
  fixture.request.mockImplementation(async name => name === 'voiceJoin' ? {
    call: { id: 'call', participants: [] }, sessionId: 'session', stopToken: 'stop',
    agents: [], url: 'wss://voice.invalid', token: 'fixture',
  } : new Promise(resolve => { answer = resolve; }));
  let state!: ReturnType<typeof useVoiceCall>;
  function Screen() { state = useVoiceCall('room', true); return null; }
  let tree: any;
  await act(async () => { tree = create(<Screen />); });
  try {
    await act(async () => { await state.join(); });
    await act(async () => { fixture.resync!(); fixture.connected!(); });
    expect(fixture.request.mock.calls.filter(([op]) => op === 'voiceState')).toEqual([
      ['voiceState', { callId: 'call', sessionId: 'session' }],
    ]);
    await act(async () => { answer({ state: 'ready' }); });
    expect(state.call?.id).toBe('call');
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.disconnect).not.toHaveBeenCalled();
    // A subsequent committed end remains authoritative.
    await act(async () => { fixture.resync!(); });
    await act(async () => { answer({ state: 'ended' }); });
    expect(state.call).toBeNull();
  } finally { await act(async () => tree.unmount()); }
});

it('a failed RTC reconnect keeps participation and does not start a retry loop', async () => {
  fixture.request.mockResolvedValueOnce({
    call: { id: 'call', participants: [] }, sessionId: 'session', stopToken: 'stop',
    agents: [], url: 'wss://voice.invalid', token: 'fixture',
  }).mockRejectedValue(new Error('transport unavailable'));
  let state!: ReturnType<typeof useVoiceCall>;
  function Screen() { state = useVoiceCall('room', true); return null; }
  let tree: any;
  await act(async () => { tree = create(<Screen />); });
  try {
    await act(async () => { await state.join(); });
    await act(async () => { fixture.listeners.get(RoomEvent.Disconnected)!(); fixture.listeners.get(RoomEvent.Disconnected)!(); });
    expect(state.call?.id).toBe('call');
    expect(state.connecting).toBe(false);
    expect(state.error).toBeTruthy();
    expect(fixture.request.mock.calls.map(([op]) => op)).toEqual(['voiceJoin', 'voiceJoin', 'voiceState']);
    expect(fixture.disconnect).not.toHaveBeenCalled();
  } finally { await act(async () => tree.unmount()); }
});

it('a reconnect refused for an ended call clears locally without creating another call', async () => {
  fixture.request.mockImplementation(async name => {
    if (name === 'voiceJoin' && fixture.request.mock.calls.length === 1) return {
      call: { id: 'call', participants: [] }, sessionId: 'session', stopToken: 'stop',
      agents: [], url: 'wss://voice.invalid', token: 'fixture',
    };
    if (name === 'voiceJoin') throw new Error('voice session ended');
    return name === 'voiceState' ? { state: 'ended' } : { left: true };
  });
  let state!: ReturnType<typeof useVoiceCall>;
  function Screen() { state = useVoiceCall('room', true); return null; }
  let tree: any;
  await act(async () => { tree = create(<Screen />); });
  try {
    await act(async () => { await state.join(); });
    await act(async () => { fixture.listeners.get(RoomEvent.Disconnected)!(); });
    expect(state.call).toBeNull();
    expect(fixture.request.mock.calls.filter(([op]) => op === 'voiceJoin')).toEqual([
      ['voiceJoin', { roomId: 'room' }], ['voiceJoin', { roomId: 'room', expectedCallId: 'call' }],
    ]);
  } finally { await act(async () => tree.unmount()); }
});

it('explicit End fences a late reconnect receipt and leaves its replacement session', async () => {
  let answer!: (value: any) => void;
  const joined = {
    call: { id: 'call', participants: [] }, sessionId: 'session', stopToken: 'stop',
    agents: [], url: 'wss://voice.invalid', token: 'fixture',
  };
  fixture.request.mockImplementation(async name => {
    if (name !== 'voiceJoin') return { left: true };
    if (fixture.request.mock.calls.length === 1) return joined;
    return new Promise(resolve => { answer = resolve; });
  });
  let state!: ReturnType<typeof useVoiceCall>;
  function Screen() { state = useVoiceCall('room', true); return null; }
  let tree: any;
  await act(async () => { tree = create(<Screen />); });
  try {
    await act(async () => { await state.join(); });
    await act(async () => { fixture.listeners.get(RoomEvent.Disconnected)!(); });
    await act(async () => { await state.end(); });
    await act(async () => { answer({ ...joined, sessionId: 'replacement' }); });
    expect(state.call).toBeNull();
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.request).toHaveBeenLastCalledWith('voiceLeave', { callId: 'call', sessionId: 'replacement' });
  } finally { await act(async () => tree.unmount()); }
});

it('covers a committed end that arrives while the reconnect state read is in flight', async () => {
  const answers: Array<(value: any) => void> = [];
  fixture.request.mockImplementation(async name => {
    if (name === 'voiceJoin') return {
      call: { id: 'call', participants: [] }, sessionId: 'session', stopToken: 'stop',
      agents: [], url: 'wss://voice.invalid', token: 'fixture',
    };
    if (name === 'voiceState') return new Promise(resolve => { answers.push(resolve); });
    return { left: true };
  });
  let state!: ReturnType<typeof useVoiceCall>;
  function Screen() { state = useVoiceCall('room', true); return null; }
  let tree: any;
  await act(async () => { tree = create(<Screen />); });
  try {
    await act(async () => { await state.join(); });
    await act(async () => { fixture.connected!(); fixture.resync!(); fixture.resync!(); });
    expect(answers).toHaveLength(1);
    await act(async () => { answers[0]!({ state: 'ready' }); });
    expect(answers).toHaveLength(2);
    await act(async () => { answers[1]!({ state: 'ended' }); });
    expect(state.call).toBeNull();
    expect(answers).toHaveLength(2);
  } finally { await act(async () => tree.unmount()); }
});

it('restores the pin when the replacement speaker joins, without replaying taps on ordinary state reads', async () => {
  fixture.request.mockImplementation(async name => name === 'voiceJoin' ? {
    call: { id: 'call', participants: [] }, sessionId: 'session', stopToken: 'stop',
    agents: [{ pubkey: 'ruby', kind: 'agent' }], url: 'wss://voice.invalid', token: 'fixture',
  } : { state: 'ready' });
  let state!: ReturnType<typeof useVoiceCall>;
  function Screen() { state = useVoiceCall('room', true); return null; }
  let tree: any;
  await act(async () => { tree = create(<Screen />); });
  try {
    await act(async () => { await state.join(); });
    await act(async () => { state.aim('ruby'); });
    expect(state.target).toBe('ruby');
    fixture.publish.mockClear();
    await act(async () => { fixture.connected!(); });
    expect(fixture.publish).not.toHaveBeenCalled();
    await act(async () => { fixture.listeners.get(RoomEvent.ParticipantConnected)!({ identity: 'another-human' }); });
    expect(fixture.publish).not.toHaveBeenCalled();
    await act(async () => { fixture.listeners.get(RoomEvent.ParticipantConnected)!({ identity: 'beeline-voice-call' }); });
    expect(fixture.publish).toHaveBeenCalledOnce();
    expect(JSON.parse(new TextDecoder().decode(fixture.publish.mock.calls[0]![0]))).toEqual({ type: 'target', agentId: 'ruby', tap: true });
  } finally { await act(async () => tree.unmount()); }
});
