import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('@/auth/monolith-session', () => ({ monolithSession: { fetch: request } }));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: async () => new Uint8Array([1, 2]) }));
vi.mock('./runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'http://fixture.invalid' }) }));
vi.mock('./wav-adpcm', () => ({
  compressDictationWav: (bytes: Uint8Array) => bytes,
  concatDictationWavs: () => null, dictationWavSeconds: () => 3,
  splitDictationWav: (bytes: Uint8Array) => [bytes],
}));
import { DICTATION_TRANSCRIPTION_TIMEOUT_MS, startDictationUpload } from './speech-transcription';

beforeEach(() => {
  request.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('uses the server transcript when every piece finishes before the stop deadline', async () => {
  request.mockResolvedValue(new Response(JSON.stringify({ text: 'Anthropic and OpenAI model tiers.' })));
  const take = startDictationUpload(['Anthropic', 'OpenAI'], 'en-US');
  take.add('blob:fixture');
  expect(await take.finish()).toBe('Anthropic and OpenAI model tiers.');
  expect(request).toHaveBeenCalledExactlyOnceWith(
    'http://fixture.invalid/v1/phone/transcriptions',
    expect.objectContaining({ method: 'POST', body: new Uint8Array([1, 2]) }),
    { timeoutMs: 15_000 },
  );
});

it('settles a failed piece without resending its audio when capture stops', async () => {
  request.mockRejectedValue(new Error('Upload disconnected'));
  const take = startDictationUpload([], 'en-US');
  take.add('blob:fixture');
  expect(await take.finish()).toBeNull();
  expect(request).toHaveBeenCalledOnce();
  expect(console.warn).toHaveBeenCalledWith('[dictation] a recording or upload failed');
});

it('falls back at the unchanged 1800 ms deadline even if an upload later succeeds', async () => {
  vi.useFakeTimers();
  expect(DICTATION_TRANSCRIPTION_TIMEOUT_MS).toBe(1800);
  let respond!: (response: Response) => void;
  request.mockReturnValue(new Promise<Response>((resolve) => { respond = resolve; }));
  const take = startDictationUpload([], 'en-US');
  take.add('blob:fixture');
  let settled = false;
  const finished = take.finish().then((text) => { settled = true; return text; });
  await vi.advanceTimersByTimeAsync(1799);
  expect(request).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await finished).toBeNull();
  expect(console.warn).toHaveBeenCalledWith('[dictation] server transcription missed the stop deadline');
  respond(new Response(JSON.stringify({ text: 'A late transcript.' })));
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledOnce();
  expect(await finished).toBeNull();
});
