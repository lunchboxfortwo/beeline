import { useSyncExternalStore } from 'react';
import { deviceTimeZone, namedTimeZone } from '@beeline/api-contract/report-time';
import { subscribeClientReset } from '@/sync/client-reset';

let zone = deviceTimeZone();
const listeners = new Set<() => void>();
export function receiveReaderZone(value: unknown) {
  const next = namedTimeZone(value) ?? deviceTimeZone();
  if (next === zone) return;
  zone = next;
  for (const listener of listeners) listener();
}
subscribeClientReset(() => receiveReaderZone(undefined));
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useReaderZone() {
  return useSyncExternalStore(subscribe, () => zone, () => 'UTC');
}
