import { beforeEach, describe, expect, it } from 'vitest';
import {
  DESKTOP_THREE_PANE_WIDTH,
  setDesktopAvailableWidth,
  setDesktopPaneOpen,
  useDesktopLayout,
} from './desktop-layout-state';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function readLayout() {
  let current!: ReturnType<typeof useDesktopLayout>;
  function Probe() {
    current = useDesktopLayout();
    return null;
  }
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(React.createElement(Probe));
  });
  return {
    get: () => current,
    unmount: () => act(() => tree.unmount()),
  };
}

describe('desktop layout state', () => {
  beforeEach(() => {
    setDesktopPaneOpen(false);
    setDesktopAvailableWidth(0, 0);
  });

  it('keeps the left sidebar open when opening the RHS pane on wide desktop screens (>= 1280px)', () => {
    const probe = readLayout();
    try {
      act(() => setDesktopAvailableWidth(1140, 1440));
      act(() => setDesktopPaneOpen(true));
      expect(probe.get()).toEqual({
        availableWidth: 1140,
        windowWidth: 1440,
        paneOpen: true,
        showRoomList: true,
      });

      act(() => setDesktopAvailableWidth(980, DESKTOP_THREE_PANE_WIDTH));
      expect(probe.get().showRoomList).toBe(true);
    } finally {
      probe.unmount();
    }
  });

  it('auto-hides the left sidebar below 1280px while the RHS pane is open and restores it on close', () => {
    const probe = readLayout();
    try {
      act(() => setDesktopAvailableWidth(780, 1080));
      expect(probe.get().showRoomList).toBe(true);

      act(() => setDesktopPaneOpen(true));
      expect(probe.get().showRoomList).toBe(false);

      // Sidebar collapses so availableWidth expands to full 1080; total windowWidth stays 1080,
      // so showRoomList must stay false without oscillating back on.
      act(() => setDesktopAvailableWidth(1080, 1080));
      expect(probe.get()).toEqual({
        availableWidth: 1080,
        windowWidth: 1080,
        paneOpen: true,
        showRoomList: false,
      });

      act(() => setDesktopPaneOpen(false));
      expect(probe.get().showRoomList).toBe(true);
    } finally {
      probe.unmount();
    }
  });

  it('transitions cleanly without oscillating when resizing across 1280px with the pane open', () => {
    const probe = readLayout();
    try {
      act(() => setDesktopAvailableWidth(1140, 1440));
      act(() => setDesktopPaneOpen(true));
      expect(probe.get().showRoomList).toBe(true);

      // Shrink to 1279px (just below threshold): sidebar hides.
      act(() => setDesktopAvailableWidth(979, DESKTOP_THREE_PANE_WIDTH - 1));
      expect(probe.get().showRoomList).toBe(false);
      act(() => setDesktopAvailableWidth(1279, DESKTOP_THREE_PANE_WIDTH - 1));
      expect(probe.get().showRoomList).toBe(false);

      // Shrink further to 1080px: stays hidden.
      act(() => setDesktopAvailableWidth(1080, 1080));
      expect(probe.get().showRoomList).toBe(false);

      // Widen back to 1280px: sidebar returns and stays open after availableWidth adjusts.
      act(() => setDesktopAvailableWidth(1280, DESKTOP_THREE_PANE_WIDTH));
      expect(probe.get().showRoomList).toBe(true);
      act(() => setDesktopAvailableWidth(980, DESKTOP_THREE_PANE_WIDTH));
      expect(probe.get().showRoomList).toBe(true);
    } finally {
      probe.unmount();
    }
  });
});
