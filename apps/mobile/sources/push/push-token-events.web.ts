import type { DevicePushToken } from 'expo-notifications';

/** Browser token changes belong to the existing web push service worker. */
export function subscribePushTokenChanges(_listener: (token: DevicePushToken) => void): () => void {
  return () => {};
}
