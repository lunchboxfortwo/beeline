import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { createConsumedNotificationResponseStore, initialNotificationPath } from '@/push/notification-response';
import { restoreLastPage } from '@/navigation/last-page';

const consumedResponses = createConsumedNotificationResponseStore(AsyncStorage);

/** @public Expo Router uses this hook to choose the first native screen before mounting it. */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | Promise<string> {
  return initial ? initialNotificationPath(path, {
    getLastResponse: Notifications.getLastNotificationResponseAsync,
    defaultActionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
    consumedResponses,
  }).then(restoreLastPage) : path;
}
