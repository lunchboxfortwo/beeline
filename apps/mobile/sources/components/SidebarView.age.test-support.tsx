import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { SidebarView } from './SidebarView';
import { ConversationRow } from './buzz/ConversationRow';

// Register against the existing sidebar fixture and its mount lifecycle.
export function sidebarAgeTests(fixture: {
  tree: ReactTestRenderer;
  settle: () => Promise<void>;
  control: (id: string) => any;
  surfaceRows: Map<string, unknown>;
  surfaceListeners: Map<string, Set<() => void>>;
  route: { pathname: string };
  pathnameListeners: Set<() => void>;
}) {
  const { settle, control, surfaceRows, surfaceListeners, route, pathnameListeners } = fixture;
  it('R1: mounting the sidebar schedules no age refresh timer', async () => {
    await act(async () => fixture.tree.unmount());
    vi.useFakeTimers();
    try {
      await act(async () => { fixture.tree = create(<SidebarView />); });
      await settle();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await act(async () => fixture.tree.unmount());
      vi.useRealTimers();
    }
  });

  it('refreshes rendered ages on list activity while keeping quiet lists and route hops stable', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.UTC(2026, 10, 7, 12);
      vi.setSystemTime(now);
      const key = '/workspace/:id/chats:workspace-a';
      const previous = surfaceRows.get(key) as any;
      const publish = async (updatedAt: number) => {
        await act(async () => {
          surfaceRows.set(key, {
            ...previous,
            chats: previous.chats.map((item: any) => item.room.id === 'room-a'
              ? { ...item, room: { ...item.room, updatedAt } } : item),
          });
          for (const listener of surfaceListeners.get(key) ?? []) listener();
        });
        await settle();
      };
      const age = () => control('desktop-room-room-a').findAllByType('Text')
        .map((node: any) => node.props.children).filter((text: unknown) => typeof text === 'string');
      await publish(now / 1000 - 60);
      expect(age()).toContain('1m');
      const capturedNow = fixture.tree.root.findAllByType(ConversationRow)[0].props.now;
      await act(async () => { vi.advanceTimersByTime(120_000); });
      expect(age()).toContain('1m');
      act(() => {
        route.pathname = '/beeline/chat/dm-a';
        for (const listener of pathnameListeners) listener();
      });
      expect(fixture.tree.root.findAllByType(ConversationRow)[0].props.now).toBe(capturedNow);
      // The new activity is two minutes old at the new wall-clock time.
      await publish(now / 1000);
      expect(age()).toContain('2m');
      expect(fixture.tree.root.findAllByType(ConversationRow)[0].props.now).toBe(now + 120_000);
    } finally {
      await act(async () => fixture.tree.unmount());
      vi.useRealTimers();
    }
  });

}
