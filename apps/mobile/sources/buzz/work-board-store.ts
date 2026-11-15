import { useEffect, useSyncExternalStore } from 'react';
import type { WorkBoardView } from '@beeline/api-contract/phone';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';

type Slot = {
  value: WorkBoardView | null;
  reading?: Promise<void>;
  dirty: boolean;
  unavailable: boolean;
  listeners: Set<() => void>;
};
const slots = new Map<string, Slot>();
function slot(id: string): Slot {
  let held = slots.get(id);
  if (!held) {
    held = { value: null, dirty: true, unavailable: false, listeners: new Set() };
    slots.set(id, held);
  }
  return held;
}
function notify(held: Slot) {
  for (const listener of held.listeners) listener();
}
subscribeClientReset(() => {
  for (const held of slots.values()) {
    held.value = null;
    held.dirty = true;
    held.reading = undefined;
    held.unavailable = false;
    notify(held);
  }
});

/** Store whole validated server responses; no client reconstruction of work state. */
export function loadWorkBoard(workspaceId: string, invalidate = false): Promise<void> {
  const held = slot(workspaceId);
  if (held.reading) {
    if (invalidate) held.dirty = true;
    return held.reading;
  }
  const generation = clientResetGeneration();
  held.dirty = false;
  const reading = monolithPhoneOperation('readWorkBoard', { workspaceId })
    .then((value) => {
      if (generation === clientResetGeneration()) {
        held.value = value;
        held.unavailable = false;
        notify(held);
      }
    })
    .catch((cause) => {
      if (
        generation === clientResetGeneration() &&
        ((cause as { code?: string; status?: number })?.code === 'workspace membership required' ||
          (cause as { status?: number })?.status === 403)
      ) {
        held.value = null;
        held.unavailable = true;
        notify(held);
      }
      throw cause;
    })
    .finally(() => {
      if (held.reading !== reading) return;
      held.reading = undefined;
      if (held.dirty && held.listeners.size && generation === clientResetGeneration())
        void loadWorkBoard(workspaceId).catch(() => undefined);
    });
  held.reading = reading;
  return reading;
}

export function useWorkBoard(workspaceId: string) {
  const generation = useSyncExternalStore(
    subscribeClientReset,
    clientResetGeneration,
    clientResetGeneration,
  );
  const held = slot(workspaceId);
  const value = useSyncExternalStore(
    (listener) => {
      held.listeners.add(listener);
      return () => {
        held.listeners.delete(listener);
      };
    },
    () => held.value,
    () => null,
  );
  useEffect(() => {
    if (!workspaceId) return;
    let stopped = false;
    let release: (() => void) | undefined;
    const connection = sharedLiveConnection();
    const refresh = () => {
      void loadWorkBoard(workspaceId).catch(() => undefined);
    };
    // Register before the opening read so an arriving commit cannot be missed.
    void connection
      .register([], (event) => {
        const frame = (event as MonolithSurfaceEvent).monolithLive;
        if (
          (frame?.type === 'invalidate' &&
            (frame.reason === 'work-board-gap' || frame.reason === 'reconnect')) ||
          frame?.type === 'needs-you-delta'
        )
          void loadWorkBoard(workspaceId, true).catch(() => undefined);
      })
      .then((stop) => {
        if (stopped) stop();
        else release = stop;
      });
    const connected = connection.subscribeConnected(refresh);
    refresh();
    return () => {
      stopped = true;
      release?.();
      connected();
    };
  }, [workspaceId, generation]);
  return value;
}

export function useWorkBoardUnavailable(workspaceId: string): boolean {
  const held = slot(workspaceId);
  return useSyncExternalStore(
    (listener) => {
      held.listeners.add(listener);
      return () => {
        held.listeners.delete(listener);
      };
    },
    () => held.unavailable,
    () => false,
  );
}

/** Passive source metadata from the server's held board DTO; it starts no read or connection. */
export function useRecordedWorkItem(
  workspaceId: string | undefined,
  messageId: string | undefined,
) {
  const held = slot(workspaceId ?? '');
  return useSyncExternalStore(
    (listener) => {
      held.listeners.add(listener);
      return () => {
        held.listeners.delete(listener);
      };
    },
    () =>
      messageId ? (held.value?.items.find((item) => item.messageId === messageId) ?? null) : null,
    () => null,
  );
}
