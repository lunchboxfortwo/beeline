import { expect, it, vi } from 'vitest';
import { SurfaceResponseCache, isRoomView, type RoomView } from '@beeline/buzz-client';
import { SurfaceRegistry } from './surface-registry';

it('publishes a completed Room read before native interactions release disk persistence', async () => {
  const writes: Array<() => Promise<void>> = [];
  const saved = new Map<string, string>();
  const cache = new SurfaceRegistry(new SurfaceResponseCache({ get: async key => saved.get(key) ?? null,
    set: async (key, value) => { saved.set(key, value); }, remove: async key => { saved.delete(key); } }),
    value => value, (_address, value) => value,
    (_key, work) => new Promise(resolve => { writes.push(async () => { await work(); resolve(); }); }));
  const address = { relayOrigin: 'https://relay.test', viewerPubkey: 'viewer', endpoint: '/room/11111111-1111-4111-8111-111111111111' };
  const view = { room: { id: '11111111-1111-4111-8111-111111111111', name: 'Beeline', archived: false, createdAt: 1, updatedAt: 1 },
    repositoryResolution: 'none', messages: [], members: [], latestAgentTurns: [], viewer: { identity: { pubkey: 'viewer', kind: 'human', name: 'Captain' },
      role: 'owner', permissions: { send: true, manage: true } }, watchFilters: [] } as RoomView;
  const paint = vi.fn();
  cache.subscribe(address, paint);
  const persisted = cache.write(address, view, isRoomView);
  expect(cache.peek(address, isRoomView)).toBe(view);
  expect(paint).toHaveBeenCalledOnce();
  expect(saved.size).toBe(0);
  await writes.shift()!();
  await persisted;
  expect(saved.size).toBe(1);
});
