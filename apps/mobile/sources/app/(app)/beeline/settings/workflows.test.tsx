import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import { RoomViewHttpError } from '@beeline/buzz-client';

const controls = vi.hoisted(() => ({ room: vi.fn(), operation: vi.fn(), confirm: vi.fn() }));
vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { View: host('View'), Text: host('Text'), ScrollView: host('ScrollView'), TouchableOpacity: host('TouchableOpacity') };
});
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('@/sync/storage', () => ({ useLocalSetting: () => 'medium' }));
vi.mock('expo-router', () => ({
  router: { replace: vi.fn(), back: vi.fn() },
  useLocalSearchParams: () => ({ roomId: 'room-1' }),
  useFocusEffect: (effect: () => void) => React.useEffect(effect, [effect]),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@/utils/use-fine-pointer', () => ({ useFinePointer: () => false }));
vi.mock('@/buzz/latency-route-hook', () => ({ useLatencyRouteFrame: () => undefined }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: async () => ({ publicKey: 'viewer' }), getEffectiveRelayUrl: async () => 'https://relay.test' }));
vi.mock('@/sync/transport/room-view-client', () => ({ RoomViewClient: class { room = controls.room; } }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: controls.operation }));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => ({ SurfaceGlyphLoader: () => null }));
vi.mock('@/modal/ModalManager', () => ({ Modal: { confirm: controls.confirm } }));

import RoomWorkflows from './workflows';

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  controls.room.mockReset().mockResolvedValue({ viewer: { permissions: { manage: true } }, repositoryResolution: 'repository', room: { name: 'beeline' } });
  controls.operation.mockReset().mockResolvedValue({ workflows: [], defaultBranch: 'main' });
  controls.confirm.mockReset().mockResolvedValue(true);
});

const textsOf = (tree: any) =>
  tree.root.findAll((node: any) => node.type === 'Text').map((node: any) => node.props.children);

it.each([
  ['network', new RoomViewHttpError(504, 'surface_request_timed_out'), ''],
  ['server refusal', Object.assign(new Error('Workspace admins only'), { status: 403 }), 'Workspace admins only'],
  ['unknown', new Error('opaque_diagnostic'), ''],
])('R2: %s failed reads never add a local Retry; server refusals keep their reason', async (_kind, reason, title) => {
  controls.room.mockRejectedValueOnce(reason);
  let tree: any;
  try {
    await act(async () => { tree = create(<RoomWorkflows />); });
    const banners = tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === 'workflows-error');
    if (title) {
      expect(banners).toHaveLength(1);
      expect(textsOf(tree)).toContain(title);
      expect(tree.root.findAll((node: any) => node.props.testID === 'workflows-error-retry')).toHaveLength(0);
    } else {
      expect(banners).toHaveLength(0);
    }
    expect(controls.room).toHaveBeenCalledTimes(1);
  } finally { if (tree) await act(async () => tree.unmount()); }
});

it('renders PlaceHeader, carded Section rows with house-radius Run buttons, and actionable inline Retry on dispatch failure', async () => {
  controls.operation.mockResolvedValueOnce({
    defaultBranch: 'main',
    workflows: [
      { name: 'Checks', lastRunAt: 1795730000, conclusion: 'success' },
      { name: 'Nightly release', lastRunAt: 1795720000, conclusion: 'failure' },
    ],
  });
  let tree: any;
  try {
    await act(async () => { tree = create(<RoomWorkflows />); });
    // PlaceHeader renders #beeline eyebrow and 24px Workflows title.
    const head = tree.root.find((node: any) => node.type === 'XStack' && node.props.testID === 'workflows-room');
    const headTexts = head.findAll((node: any) => node.type === 'Text');
    expect(headTexts[0].props.children).toBe('#beeline');
    expect(headTexts[1].props.children).toBe('Workflows');
    expect(headTexts[1].props.fontSize).toBe(24);
    // Carded Section wraps rows with 3px house-radius Run controls.
    expect(tree.root.findByProps({ testID: 'workflows-section' })).toBeTruthy();
    const runBtn = tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === 'room-workflow-Nightly release');
    expect(runBtn.props.borderRadius).toBe('house');

    // Failed dispatch surfaces an inline ErrorBanner with Retry that retries the dispatch.
    controls.operation.mockRejectedValueOnce(Object.assign(new Error('Workflow lock active'), { status: 409 }));
    await act(async () => { runBtn.props.onPress(); });
    expect(tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === 'workflows-error')).toBeTruthy();
    expect(textsOf(tree)).toContain('Workflow lock active');
    const retryBtn = tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === 'workflows-error-retry');
    controls.operation.mockResolvedValueOnce({});
    controls.operation.mockResolvedValueOnce({ defaultBranch: 'main', workflows: [] });
    await act(async () => { retryBtn.props.onPress(); });
    expect(controls.operation.mock.calls.filter(([op]) => op === 'dispatchRoomWorkflow')).toHaveLength(2);
  } finally { if (tree) await act(async () => tree.unmount()); }
});
