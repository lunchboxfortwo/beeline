import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  operation: vi.fn(),
  enterWorkspaceRoom: vi.fn(),
  saveActiveCommunityId: vi.fn(),
  workspaces: vi.fn(),
}));

vi.mock('tamagui', async () => (await import('@/ui/screens/onboarding/onboarding.test-support')).tamaguiMock());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/onboarding/onboarding.test-support')).lucideMock());
vi.mock('@/ui/screens/onboarding/Rise', async () => (await import('@/ui/screens/onboarding/onboarding.test-support')).riseMock());
vi.mock('@/ui/screens/onboarding/YouStep', () => ({ YouStep: () => null }));
vi.mock('expo-router', () => ({
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: () => true },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => '11111111-2222-4333-8444-555555555555' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('@beeline/buzz-client', () => ({ isWorkspaceListView: () => true }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://server.example'),
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'person-1' })),
}));
vi.mock('@/buzz/surface-storage', () => ({
  mobileSurfaceCache: { read: vi.fn(async () => null), write: vi.fn(async () => undefined) },
  surfaceAddress: () => 'address',
}));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    workspaces = controls.workspaces;
  },
}));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ relayUrl: 'https://server.example' }) }));
vi.mock('@/buzz/community-storage', () => ({
  saveActiveCommunityId: controls.saveActiveCommunityId,
}));
vi.mock('@/buzz/enter-workspace', () => ({ enterWorkspaceRoom: controls.enterWorkspaceRoom }));
vi.mock('@/components/buzz/SurfaceGlyphLoader', async () => {
  const ReactModule = await import('react');
  return { SurfaceGlyphLoader: (props: any) => ReactModule.createElement('SurfaceGlyphLoader', props) };
});
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: controls.operation,
}));

import CreateWorkspace from './create-workspace';
import { texts } from '@/ui/screens/onboarding/onboarding.test-support';

const originalConsoleError = console.error;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

const WORKSPACE = '11111111-2222-4333-8444-555555555555';

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(CreateWorkspace));
  });
  await act(async () => undefined);
  return renderer;
}
const find = (renderer: ReactTestRenderer, testID: string) =>
  renderer.root.findAll(
    (node: any) => node.props?.testID === testID && typeof node.type === 'string',
  );
async function press(renderer: ReactTestRenderer, testID: string) {
  await act(async () => {
    await find(renderer, testID)[0]!.props.onPress();
  });
}
async function type(renderer: ReactTestRenderer, testID: string, text: string) {
  await act(async () => find(renderer, testID)[0]!.props.onChangeText(text));
}

describe('creating a Workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.workspaces.mockResolvedValue({ workspaces: [{ id: 'w0', name: 'Old' }], viewer: { name: 'Ada' } });
    controls.operation.mockImplementation(async (name: string) => {
      if (name === 'createWorkspace') return { id: WORKSPACE, roomId: 'general-1' };
      if (name === 'createInvite') return { token: 'bzi_token', expiresAt: 1 };
      return undefined;
    });
  });

  it('opens on Name your workspace and creates it into the invite step, then lands in #general', async () => {
    const renderer = await render();
    expect(find(renderer, 'onboarding-create')).toHaveLength(1);
    expect(texts(renderer.root)).toEqual(expect.arrayContaining(['Name your workspace', 'Who can join']));
    // The Workspace step is stage 3 of the rail: three segments brass, one to go.
    expect(find(renderer, 'rail-done')).toHaveLength(3);
    expect(find(renderer, 'rail-todo')).toHaveLength(1);
    const button = find(renderer, 'create-continue')[0]!;
    expect(button.type).toBe('Button');
    expect(button.props['aria-label']).toBe('Create workspace');
    expect(button.props.minHeight).toBe(52);

    await type(renderer, 'create-workspace-name', 'Northstar Lab');
    await press(renderer, 'create-continue');
    expect(controls.operation).toHaveBeenCalledWith('createWorkspace', {
      workspaceId: WORKSPACE,
      name: 'Northstar Lab',
    });
    expect(controls.saveActiveCommunityId).toHaveBeenCalledWith('person-1', WORKSPACE);
    // Invite-only is the default: nothing else is written.
    expect(controls.operation).not.toHaveBeenCalledWith('updateWorkspace', expect.anything());
    expect(find(renderer, 'onboarding-invite')).toHaveLength(1);
    expect(find(renderer, 'rail-done')).toHaveLength(4);
    // A second Workspace is not a first entry: no free-agent promise.
    expect(texts(renderer.root).join(' ')).not.toContain('Beebee and Luna');
    // The Workspace exists now: invite has no way back into create.
    expect(find(renderer, 'onboarding-back')).toHaveLength(0);
    expect(controls.enterWorkspaceRoom).not.toHaveBeenCalled();

    await press(renderer, 'go-general');
    expect(controls.enterWorkspaceRoom).toHaveBeenCalledWith(WORKSPACE, 'general-1');
    // The Workspace step never touches the person's name or face.
    expect(controls.operation).not.toHaveBeenCalledWith('updatePersonProfile', expect.anything());
    expect(controls.operation).not.toHaveBeenCalledWith('updateIdentityFace', expect.anything());
  });

  it('writes Anyone with the link as a public Workspace', async () => {
    const renderer = await render();
    await press(renderer, 'create-open');
    await press(renderer, 'create-continue');
    expect(controls.operation).toHaveBeenCalledWith('updateWorkspace', { workspaceId: WORKSPACE, visibility: 'public' });
  });

  it('retries a failed create under the same id, so it can never make two', async () => {
    let calls = 0;
    controls.operation.mockImplementation(async (name: string, input: any) => {
      if (name === 'createWorkspace') {
        calls += 1;
        if (calls === 1) throw new Error('network');
        return { id: input.workspaceId, roomId: 'general-1' };
      }
      return undefined;
    });
    const renderer = await render();
    await type(renderer, 'create-workspace-name', 'Crew');
    await press(renderer, 'create-continue');
    await vi.waitFor(() => expect(find(renderer, 'create-error')).toHaveLength(1));
    await press(renderer, 'create-continue');
    const ids = controls.operation.mock.calls
      .filter(([name]) => name === 'createWorkspace')
      .map(([, input]) => input.workspaceId);
    expect(ids).toEqual([WORKSPACE, WORKSPACE]);
    expect(find(renderer, 'onboarding-invite')).toHaveLength(1);
  });

  it('writes a name corrected after a create whose response never arrived', async () => {
    let calls = 0;
    controls.operation.mockImplementation(async (name: string, input: any) => {
      if (name === 'createWorkspace') {
        calls += 1;
        // The server committed the first insert; only the answer was lost.
        if (calls === 1) throw new Error('timeout');
        return { id: input.workspaceId, roomId: 'general-1' };
      }
      return undefined;
    });
    const renderer = await render();
    await type(renderer, 'create-workspace-name', 'Alpha');
    await press(renderer, 'create-continue');
    await vi.waitFor(() => expect(find(renderer, 'create-error')).toHaveLength(1));
    await type(renderer, 'create-workspace-name', 'Alpha Labs');
    await press(renderer, 'create-continue');
    await vi.waitFor(() =>
      expect(controls.operation).toHaveBeenCalledWith('updateWorkspace', {
        workspaceId: WORKSPACE,
        name: 'Alpha Labs',
      }),
    );
    expect(find(renderer, 'onboarding-invite')).toHaveLength(1);
  });
});
