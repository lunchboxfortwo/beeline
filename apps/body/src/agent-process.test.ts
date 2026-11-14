import { describe, expect, it } from 'vitest';
import { HostPlaces, resolveSessionIdleMs } from './agent-process.js';

describe('live places and storage sweeps', () => {
  it('skips a place while a session serves it and sweeps it once the session ends', async () => {
    let swept = 0;
    HostPlaces.enter('place-live');
    expect(await HostPlaces.withIdleHostRoom('place-live', async () => { swept++; })).toBe(false);
    HostPlaces.leave('place-live');
    expect(await HostPlaces.withIdleHostRoom('place-live', async () => { swept++; })).toBe(true);
    expect(swept).toBe(1);
  });

  it('runs one whole-host sweep at a time without waiting for sessions', async () => {
    HostPlaces.enter('place-busy');
    let release!: () => void;
    const held = new Promise<void>(done => { release = done; });
    const first = HostPlaces.withIdleHostStorage(() => held);
    expect(HostPlaces.hostStoragePaused).toBe(true);
    expect(await HostPlaces.withIdleHostStorage(async () => {})).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(HostPlaces.hostStoragePaused).toBe(false);
    HostPlaces.leave('place-busy');
  });

  it('reads only the stay-warm setting', () => {
    expect(resolveSessionIdleMs({ BEELINE_BODY_SESSION_IDLE_MS: '1234' })).toBe(1234);
    expect(resolveSessionIdleMs({ BEELINE_BODY_SESSION_IDLE_MS: '0' })).toBe(30 * 60_000);
  });
});
