import { describe, expect, it, vi } from 'vitest';
const push = vi.hoisted(() => vi.fn());
vi.mock('expo-router', () => ({ router: { push } }));
import { openPlace, routeFor, type PanelPlace } from './panel';
describe('main-panel destinations', () => {
  const destinations: PanelPlace[] = [
    { kind: 'chat-info', roomId: 'room/1' }, { kind: 'members', roomId: 'room/1' },
    { kind: 'brief', roomId: 'thread/1' },
    { kind: 'agent', agentId: 'agent/1', workspaceId: 'workspace/1' },
    { kind: 'person', memberId: 'person/1', workspaceId: 'workspace/1' },
  ];
  it.each(destinations)('pushes $kind to the main stack at every screen width', place => {
    for (const desktop of [true, false]) {
      push.mockClear(); openPlace(place, desktop);
      expect(push).toHaveBeenCalledExactlyOnceWith(routeFor(place));
    }
  });
});
