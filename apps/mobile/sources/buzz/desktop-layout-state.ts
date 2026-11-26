import { useSyncExternalStore } from 'react';

/** Minimum total window width that keeps all three desktop panes visible together. */
export const DESKTOP_THREE_PANE_WIDTH = 1280;

// Presentation only; durable Room state remains server-owned.
let snapshot = { availableWidth: 0, windowWidth: 0, paneOpen: false, showRoomList: true };
const listeners = new Set<() => void>();

function shouldShowRoomList(paneOpen: boolean, windowWidth: number): boolean {
  return !paneOpen || windowWidth >= DESKTOP_THREE_PANE_WIDTH;
}

function update(next: Partial<typeof snapshot>) {
  if (
    Object.entries(next).every(([key, value]) => snapshot[key as keyof typeof snapshot] === value)
  )
    return;
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}
export function setDesktopAvailableWidth(availableWidth: number, windowWidth = availableWidth) {
  update({
    availableWidth,
    windowWidth,
    showRoomList: shouldShowRoomList(snapshot.paneOpen, windowWidth),
  });
}
export function setDesktopPaneOpen(paneOpen: boolean) {
  update({
    paneOpen,
    showRoomList: shouldShowRoomList(paneOpen, snapshot.windowWidth),
  });
}
export function useDesktopLayout() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => snapshot,
    () => snapshot,
  );
}
