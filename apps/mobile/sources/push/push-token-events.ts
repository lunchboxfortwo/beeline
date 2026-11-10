import { addPushTokenListener, type DevicePushToken } from 'expo-notifications';

export function subscribePushTokenChanges(listener: (token: DevicePushToken) => void): () => void {
  const subscription = addPushTokenListener(listener);
  return () => subscription.remove();
}
