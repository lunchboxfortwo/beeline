import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ active: true, width: 1280, stored: undefined as number | undefined, save: vi.fn(), pan: null as any }));
vi.mock('tamagui', async () => { const R = await import('react'); return { YStack: (p: any) => R.createElement('YStack', p, p.children) }; });
vi.mock('react-native', () => ({ PanResponder: { create: (handlers: any) => { fixture.pan = handlers; return { panHandlers: handlers }; } } }));
vi.mock('@/buzz/desktop-layout-state', () => ({ useDesktopLayout: () => ({ availableWidth: fixture.width }) }));
vi.mock('@/buzz/use-surface-focus', () => ({ useSurfaceFocus: () => fixture.active }));
vi.mock('@/buzz/desktop-workbench-state', async original => ({ ...await original<object>(), loadDesktopViewerWidth: async () => fixture.stored, saveDesktopViewerWidth: async (n: number) => { fixture.stored = n; fixture.save(n); } }));
vi.mock('@/components/buzz/DesktopArtifactPane', async () => { const R = await import('react'); return { DesktopArtifactPane: (p: any) => R.createElement('ArtifactViewer', p) }; });
vi.mock('@/components/buzz/ComputerSession', async () => { const R = await import('react'); return { ComputerSessionViewer: (p: any) => R.createElement('BrowserViewer', p) }; });
import { DesktopRoomInspector } from './DesktopRoomInspector';
import { ChatSurfaceWorkPane } from '@/app/(app)/beeline/chat/ChatSurfaceWorkPane';
import type { DesktopWorkPaneContent } from '@/buzz/desktop-workbench-state';
const room = { room: { id: 'room' } } as any;
const artifact = { kind: 'artifact', artifact: { attachment: { id: 'file', name: 'report.html', mimeType: 'text/html', size: 1, url: '/file' } } } as DesktopWorkPaneContent;
const computer = { kind: 'computer', session: { id: 'browser', agentHandle: 'agent' } } as DesktopWorkPaneContent;
let tree: ReactTestRenderer;
async function render(content = artifact) { await act(async () => { tree = create(<DesktopRoomInspector room={room} content={content} onClose={vi.fn()} />); }); }
const pane = () => tree.root.findByProps({ testID: 'desktop-inspector' });
beforeEach(() => { fixture.width = 1280; fixture.stored = undefined; fixture.active = true; fixture.save.mockClear(); });
afterEach(async () => { if (tree) await act(async () => tree.unmount()); });
describe('artifact/browser-only desktop pane', () => {
  it('has no pane at all without an opened viewer', async () => {
    await act(async () => { tree = create(<ChatSurfaceWorkPane desktopWorkPaneMounted={room} displayedDesktopWorkPaneContent={null} closeDesktopWorkPane={vi.fn()} />); });
    expect(tree.toJSON()).toBeNull();
  });
  it('renders an artifact with the original metadata and close action', async () => {
    const close = vi.fn();
    await act(async () => { tree = create(<DesktopRoomInspector room={room} content={artifact} onClose={close} />); });
    const viewer = tree.root.findByType('ArtifactViewer');
    expect(viewer.props.attachment.id).toBe('file');
    expect(viewer.props.roomId).toBe('room');
    viewer.props.onClose(); expect(close).toHaveBeenCalledOnce();
    expect(tree.root.findAllByProps({ testID: 'desktop-work-corner-transcript' })).toHaveLength(0);
  });
  it('keeps live browser focus and session access intact', async () => {
    await render(computer);
    expect(tree.root.findByType('BrowserViewer').props.active).toBe(true);
    fixture.active = false;
    await act(async () => tree.update(<DesktopRoomInspector room={room} content={computer} onClose={vi.fn()} />));
    expect(tree.root.findByType('BrowserViewer').props.active).toBe(false);
  });
  it('drags the visible LEFT divider, saves widths above 480, and restores on remount', async () => {
    await render();
    expect(pane().props.width).toBeCloseTo(614.4);
    const handle = tree.root.findByProps({ testID: 'desktop-inspector-resizer' });
    expect(handle.props.left).toBe(-3); expect(handle.props.cursor).toBe('col-resize');
    expect(handle.props.backgroundColor).toBe('strongStroke');
    const pan = fixture.pan;
    act(() => pan.onPanResponderGrant());
    act(() => pan.onPanResponderMove(null, { dx: -100 }));
    expect(pane().props.width).toBeCloseTo(714.4);
    await act(async () => pan.onPanResponderRelease(null, { dx: -100 }));
    expect(fixture.save).toHaveBeenCalledWith(714.4);
    expect(fixture.pan).toBe(pan);
    await act(async () => tree.unmount()); await render();
    expect(pane().props.width).toBe(714.4);
  });
  it('clamps both drag directions and refits to the window without losing the saved preference', async () => {
    fixture.stored = 900;
    await render(computer);
    expect(pane().props.width).toBe(840);
    const pan = fixture.pan;
    act(() => pan.onPanResponderGrant());
    act(() => pan.onPanResponderMove(null, { dx: 2000 }));
    expect(pane().props.width).toBe(320);
    act(() => pan.onPanResponderMove(null, { dx: -2000 }));
    expect(pane().props.width).toBe(840);
    fixture.width = 980;
    await act(async () => tree.update(<DesktopRoomInspector room={room} content={computer} onClose={vi.fn()} />));
    expect(pane().props.width).toBe(540);
    expect(fixture.save).not.toHaveBeenCalled();
  });
});
// Compile-time regression: a corner can never be supplied as pane content.
// @ts-expect-error threads are not viewer content
const forbiddenThread: DesktopWorkPaneContent = { kind: 'corner', cornerId: 'thread' };
void forbiddenThread;
