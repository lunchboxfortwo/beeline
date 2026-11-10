import { expect, it, vi } from 'vitest';
const os = vi.hoisted(() => ({ listener: undefined as ((token: { type: 'android'; data: string }) => void) | undefined, remove: vi.fn() }));
vi.mock('expo-notifications', () => ({ addPushTokenListener: (listener: typeof os.listener) => {
  os.listener = listener; return { remove: os.remove };
} }));
import * as native from './push-token-events';
import * as web from './push-token-events.web';

it('observes the native token event and releases it; web keeps its service-worker owner', () => {
  const webContract: typeof native = web;
  const changed = vi.fn();
  const stop = native.subscribePushTokenChanges(changed);
  const token = { type: 'android' as const, data: 'rotated-token' };
  os.listener!(token);
  expect(changed).toHaveBeenCalledExactlyOnceWith(token);
  stop();
  expect(os.remove).toHaveBeenCalledOnce();
  webContract.subscribePushTokenChanges(changed)();
  expect(changed).toHaveBeenCalledOnce();
});
