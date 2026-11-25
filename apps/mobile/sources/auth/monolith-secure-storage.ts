import { isDesktopShell } from '@/utils/isDesktopShell';
import { webStringStorage } from '@/sync/browser-string-storage';
import { webRuntimeStorage } from '@/utils/web-storage';

export interface MonolithSecureStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

async function desktopInvoke<T>(
  command: 'desktop_secure_get' | 'desktop_secure_set' | 'desktop_secure_remove',
  args: { key: string; value?: string },
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

type DesktopInvoke = typeof desktopInvoke;

/** The origin's storage, or memory for this page where the browser denies it. */
export function browserMonolithStorage(storage: Storage | undefined): MonolithSecureStorage {
  const web = webStringStorage(storage);
  return {
    getItemAsync: async (key) => web.getString(key) ?? null,
    setItemAsync: async (key, value) => web.set(key, value),
    deleteItemAsync: async (key) => web.delete(key),
  };
}

function desktopSecureStorage(invoke: DesktopInvoke): MonolithSecureStorage {
  return {
    getItemAsync: (key) => invoke<string | null>('desktop_secure_get', { key }),
    setItemAsync: (key, value) => invoke<void>('desktop_secure_set', { key, value }),
    deleteItemAsync: (key) => invoke<void>('desktop_secure_remove', { key }),
  };
}

export async function monolithSecureStorage(
  desktop = isDesktopShell(),
  invoke: DesktopInvoke = desktopInvoke,
): Promise<MonolithSecureStorage> {
  if (desktop) return desktopSecureStorage(invoke);
  // Expo SecureStore's web shim calls a native host method that does not
  // exist in an ordinary branch-preview browser. localStorage, like the legacy
  // identity path, keeps one sign-in for the origin across reloads and tabs;
  // sign-out removes it for every tab.
  const web = webRuntimeStorage();
  if (web) return browserMonolithStorage(web.storage);
  const secureStore = await import('expo-secure-store');
  if (process.env.EXPO_OS !== 'ios') return secureStore;
  // Expo only sets accessibility when it creates an entry. Use a new service
  // so a write can replace the legacy entry without first deleting the saved value.
  const options = {
    keychainService: 'beeline.session',
    keychainAccessible: secureStore.AFTER_FIRST_UNLOCK,
  };
  return {
    getItemAsync: async (key) =>
      (await secureStore.getItemAsync(key, options)) ?? secureStore.getItemAsync(key),
    setItemAsync: async (key, value) => {
      await secureStore.setItemAsync(key, value, options);
      await secureStore.deleteItemAsync(key);
    },
    deleteItemAsync: async (key) => {
      await secureStore.deleteItemAsync(key);
      await secureStore.deleteItemAsync(key, options);
    },
  };
}
