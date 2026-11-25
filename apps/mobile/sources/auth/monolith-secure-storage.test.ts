import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deleteItemAsync, getItemAsync, setItemAsync, AFTER_FIRST_UNLOCK } from 'expo-secure-store';
import { monolithSecureStorage } from './monolith-secure-storage';

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 1,
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

const key = 'buzzy.monolith.refresh.v1';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('EXPO_OS', 'ios');
});
afterEach(() => vi.unstubAllEnvs());

it('keeps the legacy session readable and migrates it on the next write', async () => {
  const entries = new Map([['app', 'legacy']]);
  let locked = false;
  vi.mocked(getItemAsync).mockImplementation(async (_, options) => {
    if (locked && !options?.keychainService) throw new Error('User interaction is not allowed');
    return entries.get(options?.keychainService ?? 'app') ?? null;
  });
  vi.mocked(setItemAsync).mockImplementation(async (_, value, options) => {
    expect(options?.keychainAccessible).toBe(AFTER_FIRST_UNLOCK);
    expect(options?.keychainService).toBeTruthy();
    entries.set(options!.keychainService!, value);
  });
  vi.mocked(deleteItemAsync).mockImplementation(async (_, options) => {
    entries.delete(options?.keychainService ?? 'app');
  });

  const storage = await monolithSecureStorage(false);
  expect(await storage.getItemAsync(key)).toBe('legacy');
  expect(setItemAsync).not.toHaveBeenCalled();
  await storage.setItemAsync(key, 'renewed');
  expect(entries.has('app')).toBe(false);
  expect(setItemAsync).toHaveBeenCalledBefore(deleteItemAsync);
  locked = true;
  expect(await storage.getItemAsync(key)).toBe('renewed');
  await storage.deleteItemAsync(key);
  expect(entries.size).toBe(0);
});

it('retains the legacy session if the new keychain write fails', async () => {
  vi.mocked(setItemAsync).mockRejectedValueOnce(new Error('keychain unavailable'));
  const storage = await monolithSecureStorage(false);

  await expect(storage.setItemAsync(key, 'renewed')).rejects.toThrow('keychain unavailable');
  expect(deleteItemAsync).not.toHaveBeenCalled();
});
