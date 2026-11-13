import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

const writes = new Map<string, Promise<void>>();
const decodePins = (raw: string | null): string[] => {
  const value: unknown = raw ? JSON.parse(raw) : [];
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
};
const listeners = new Map<string, Set<(ids: readonly string[]) => void>>();

/** Device-local navigation preferences, scoped to the signed-in viewer and Workspace. */
export function useRoomPins(
  viewer: string | null | undefined,
  workspace: string | null | undefined,
) {
  const key = viewer && workspace ? `@beeline/room-pins/${viewer}/${workspace}` : null;
  const [state, setState] = useState<{
    key: string | null;
    ids: readonly string[];
    loaded: boolean;
  }>({
    key: null,
    ids: [],
    loaded: false,
  });
  const currentKey = useRef(key);
  currentKey.current = key;
  const [error, setError] = useState<string | null>(null);
  const ids = state.key === key ? state.ids : [];
  useEffect(() => {
    setError(null);
    if (!key) return;
    let changed = false;
    const receive = (next: readonly string[]) => {
      changed = true;
      setState({ key, ids: next, loaded: true });
    };
    const bucket = listeners.get(key) ?? new Set();
    bucket.add(receive);
    listeners.set(key, bucket);
    void AsyncStorage.getItem(key)
      .then((raw) => {
        if (changed) return;
        setState({ key, ids: decodePins(raw), loaded: true });
      })
      .catch(() => {
        if (!changed) {
          setState({ key, ids: [], loaded: true });
          setError('Could not load pinned conversations.');
        }
      });
    return () => {
      changed = true;
      bucket.delete(receive);
      if (!bucket.size) listeners.delete(key);
    };
  }, [key]);
  const toggle = useCallback(
    async (id: string) => {
      if (!key) return;
      // Serialize read/modify/write across both mounted navigation surfaces.
      // Read storage first so a quick tap during hydration cannot erase older pins.
      const write = (writes.get(key) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const saved = decodePins(await AsyncStorage.getItem(key));
          const next = saved.includes(id) ? saved.filter((value) => value !== id) : [...saved, id];
          await AsyncStorage.setItem(key, JSON.stringify(next));
          listeners.get(key)?.forEach((receive) => receive(next));
        });
      writes.set(key, write);
      try {
        await write;
        if (currentKey.current === key) setError(null);
      } catch {
        if (currentKey.current === key) setError('Could not save pinned conversations. Try again.');
      } finally {
        if (writes.get(key) === write) writes.delete(key);
      }
    },
    [key],
  );
  return {
    pinned: ids,
    pinsLoaded: state.key === key && state.loaded,
    togglePin: toggle,
    pinError: error,
  };
}

type ChatFilter = 'unread' | 'pinned';

/** Search chips are a per-device preference, not a transient search draft. */
export function useChatFilters(
  viewer: string | null | undefined,
  workspace: string | null | undefined,
) {
  const key = viewer && workspace ? `@beeline/chat-filters/${viewer}/${workspace}` : null;
  const [state, setState] = useState<{ key: string | null; chips: ChatFilter[] }>({ key: null, chips: [] });
  const changed = useRef(false);
  useEffect(() => {
    let cancelled = false;
    changed.current = false;
    if (key) void (writes.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => AsyncStorage.getItem(key))
      .then(raw => {
        if (cancelled || changed.current) return;
        const values: unknown = raw ? JSON.parse(raw) : [];
        const chips = Array.isArray(values)
          ? values.filter((value): value is ChatFilter => value === 'unread' || value === 'pinned')
          : [];
        setState({ key, chips });
      }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [key]);
  const setFilters = useCallback((chips: ChatFilter[]) => {
    changed.current = true;
    setState({ key, chips });
    if (!key) return;
    const write = (writes.get(key) ?? Promise.resolve()).catch(() => undefined)
      .then(() => AsyncStorage.setItem(key, JSON.stringify(chips)));
    writes.set(key, write);
    void write.catch(() => undefined).finally(() => {
      if (writes.get(key) === write) writes.delete(key);
    });
  }, [key]);
  return [state.key === key ? state.chips : [], setFilters] as const;
}
