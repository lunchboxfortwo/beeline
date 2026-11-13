import { expect, it, vi } from 'vitest';
import type { ChatLinkView } from '@beeline/api-contract/phone';
import { createChatLinkStore } from './chat-link-store';

const thread: ChatLinkView = { key: '↳fix', kind: 'thread', roomId: 'c1', parentRoomId: 'r1', name: 'fix' };

it('asks once per chat for every new token in a frame, and remembers misses as plain text', async () => {
  let flush: (() => void) | undefined;
  const resolve = vi.fn(async (_roomId: string, _tokens: readonly string[]) => ({ links: [thread] }));
  const store = createChatLinkStore(resolve, (next) => { flush = next; });
  const listener = vi.fn();
  store.subscribe(listener);
  store.request('r1', { text: '↳Fix', key: '↳fix' });
  store.request('r1', { text: '¶ruby-9999', key: '¶ruby-9999' });
  store.request('r1', { text: '↳fix', key: '↳fix' });
  expect(store.read('r1', '↳fix')).toBeUndefined();
  flush!();
  await vi.waitFor(() => expect(listener).toHaveBeenCalled());
  expect(resolve).toHaveBeenCalledExactlyOnceWith('r1', ['↳Fix', '¶ruby-9999']);
  expect(store.read('r1', '↳fix')).toEqual(thread);
  expect(store.read('r1', '¶ruby-9999')).toBeNull();
  // The same token in another chat is its own question.
  expect(store.read('r2', '↳fix')).toBeUndefined();
  store.request('r1', { text: '↳fix', key: '↳fix' });
  expect(resolve).toHaveBeenCalledOnce();
});

it('keeps a failed read unknown and asks again on reconnect', async () => {
  let online = false;
  const resolve = vi.fn(async (_roomId: string, _tokens: readonly string[]) => {
    if (!online) throw new Error('offline');
    return { links: [thread] };
  });
  const store = createChatLinkStore(resolve, (next) => next());
  const listener = vi.fn();
  store.subscribe(listener);
  store.request('r1', { text: '↳fix', key: '↳fix' });
  await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
  await Promise.resolve();
  // Offline is not a no-match: the token stays unknown, so plain text.
  expect(store.read('r1', '↳fix')).toBeUndefined();
  online = true;
  store.retryFailed();
  await vi.waitFor(() => expect(store.read('r1', '↳fix')).toEqual(thread));
  expect(resolve).toHaveBeenCalledTimes(2);
  // Settled answers are not asked again.
  store.retryFailed();
  store.request('r1', { text: '↳fix', key: '↳fix' });
  expect(resolve).toHaveBeenCalledTimes(2);
});

it('forgets answers on account change and drops a late answer from the old account', async () => {
  const pending: Array<(view: { links: ChatLinkView[] }) => void> = [];
  const resolve = vi.fn((_roomId: string, _tokens: readonly string[]) =>
    new Promise<{ links: ChatLinkView[] }>((done) => { pending.push(done); }));
  const store = createChatLinkStore(resolve, (next) => next());
  store.request('r1', { text: '↳fix', key: '↳fix' });
  pending[0]!({ links: [thread] });
  await vi.waitFor(() => expect(store.read('r1', '↳fix')).toEqual(thread));
  // Reader A asks about a second token; the answer is still in flight.
  store.request('r1', { text: '↳ops', key: '↳ops' });
  store.reset();
  expect(store.read('r1', '↳fix')).toBeUndefined();
  pending[1]!({ links: [{ ...thread, key: '↳ops' }] });
  await Promise.resolve();
  await Promise.resolve();
  expect(store.read('r1', '↳ops')).toBeUndefined();
  // Reader B gets a fresh access check, not A's cached answer.
  store.request('r1', { text: '↳fix', key: '↳fix' });
  expect(resolve).toHaveBeenCalledTimes(3);
  pending[2]!({ links: [] });
  await vi.waitFor(() => expect(store.read('r1', '↳fix')).toBeNull());
});
