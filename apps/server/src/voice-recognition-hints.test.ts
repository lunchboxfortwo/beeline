import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import { conversationService, state } from './test-support-voice-room-runtime.test-support.js';
import { fluxFactory } from './voice-providers.js';
import { VoiceRoomRuntime } from './voice-room-runtime.js';
import type { VoiceService } from './voice-service.js';

it('passes current DM member names through the live input path as canonical Flux keyterms', async () => {
  const { service } = conversationService();
  service.agents.mockResolvedValue([{ id: 'grok', name: 'Grok Bot', handle: 'grok_bot', soul: '', voice: 'luna' }]);
  const memberNames = vi.fn(async () => [
    { name: 'Grok Bot', handle: 'grok_bot' },
    { name: 'Jellybean', handle: 'jellybean' },
    { name: 'Ruby', handle: 'ruby_dev' },
  ]);
  Object.assign(service, { memberNames });
  class Socket extends EventEmitter {
    readyState = WebSocket.OPEN;
    bufferedAmount = 0;
    send = vi.fn();
    close = vi.fn();
  }
  const connect = vi.fn((_url: string, _options: WebSocket.ClientOptions) => {
    const socket = new Socket();
    queueMicrotask(() => socket.emit('open'));
    return socket as unknown as WebSocket;
  });
  service.config.stt = fluxFactory('test-token', 'test-account', connect) as typeof service.config.stt;
  state.streams = [new ReadableStream()];
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(runtime.inputs.has('human')).toBe(true));
    expect(connect).toHaveBeenCalledOnce();
    const url = new URL(connect.mock.calls[0]![0]);
    expect(url.pathname).toBe('/client/v4/accounts/test-account/ai/run/@cf/deepgram/flux');
    expect(url.searchParams.getAll('keyterm')).toEqual(['Grok Bot', 'Jellybean', 'Ruby', 'ruby dev']);
    expect(url.searchParams.get('eot_timeout_ms')).toBe('1000');
    expect(memberNames).toHaveBeenCalledWith('room');
  } finally {
    await runtime.close();
  }
});
