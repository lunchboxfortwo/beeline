import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = `inv_${'b'.repeat(64)}`;
const WORKSPACE = '11111111-2222-4333-8444-555555555555';
const controls = vi.hoisted(() => ({
  operation: vi.fn(),
  enter: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  workspaces: vi.fn(),
  params: {} as Record<string, string>,
}));

vi.mock('tamagui', async () => (await import('@/ui/screens/onboarding/onboarding.test-support')).tamaguiMock());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/onboarding/onboarding.test-support')).lucideMock());
vi.mock('@/ui/screens/onboarding/Rise', async () => (await import('@/ui/screens/onboarding/onboarding.test-support')).riseMock());
vi.mock('@/ui/screens/onboarding/YouStep', async () => {
  const ReactModule = await import('react');
  return { YouStep: (props: any) => ReactModule.createElement('YouStep', props) };
});
vi.mock('expo-crypto', () => ({ randomUUID: () => '11111111-2222-4333-8444-555555555555' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: controls.operation }));
vi.mock('@/buzz/community-storage', () => ({ saveActiveCommunityId: vi.fn(async () => undefined) }));
vi.mock('@/buzz/enter-workspace', () => ({ enterWorkspaceRoom: controls.enter }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ relayUrl: 'https://server.example' }) }));
vi.mock('expo-router', () => ({
  router: { push: controls.push, replace: controls.replace, back: controls.back, canGoBack: () => true },
  useLocalSearchParams: () => controls.params,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('@beeline/buzz-client', () => ({ isWorkspaceListView: () => true }));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    workspaces = controls.workspaces;
  },
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://server.example'),
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'person-1' })),
}));
vi.mock('@/buzz/surface-storage', () => ({
  mobileSurfaceCache: { read: vi.fn(async () => null), write: vi.fn(async () => undefined) },
  surfaceAddress: () => 'address',
}));
vi.mock('@/components/buzz/SurfaceGlyphLoader', async () => {
  const ReactModule = await import('react');
  return { SurfaceGlyphLoader: (props: any) => ReactModule.createElement('SurfaceGlyphLoader', props) };
});
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});

import WorkspaceChoice from './community';
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

const mounted: ReactTestRenderer[] = [];
afterEach(async () => { await act(async () => { for (const tree of mounted.splice(0)) tree.unmount(); }); });

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(WorkspaceChoice));
  });
  await act(async () => undefined);
  mounted.push(renderer);
  return renderer;
}
const find = (renderer: ReactTestRenderer, testID: string) =>
  renderer.root.findAll(
    (node: any) => node.props?.testID === testID && typeof node.type === 'string',
  );
async function press(renderer: ReactTestRenderer, testID: string) {
  await act(async () => { await find(renderer, testID)[0]!.props.onPress(); });
}

describe('the setup flow after sign-in', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.params = {};
    controls.workspaces.mockResolvedValue({ workspaces: [], viewer: { name: 'Ada' } });
    controls.operation.mockImplementation(async (name: string) => {
      if (name === 'createWorkspace') return { id: WORKSPACE, roomId: 'general' };
      if (name === 'createInvite') return { token: TOKEN, expiresAt: 1 };
      if (name === 'createAgentPairingCode') return { code: 'K7Q-4MZ', expiresAt: 1 };
      return undefined;
    });
  });

  it('walks a first entry from You to #general, where the free agents are waiting', async () => {
    const renderer = await render();
    // A person with no Workspace starts on You and has nowhere to go back to.
    const you = renderer.root.findAllByType('YouStep');
    expect(you).toHaveLength(1);
    expect(you[0]!.props.back).toBeUndefined();
    await act(async () => you[0]!.props.onDone());

    expect(find(renderer, 'onboarding-workspace')).toHaveLength(1);
    expect(texts(renderer.root)).toEqual(expect.arrayContaining(['Where will you work?', 'Create a workspace', 'Join with an invite link']));
    // Brass marks only the recommended path.
    expect(find(renderer, 'choice-create')[0]!.props.borderColor).toBe('needsYou');
    expect(find(renderer, 'choice-join')[0]!.props.borderColor).toBe('strongStroke');

    await press(renderer, 'choice-create');
    expect(find(renderer, 'create-workspace-name')[0]!.props.value).toBe("Ada's team");
    expect(controls.operation).not.toHaveBeenCalled();
    await press(renderer, 'create-continue');
    expect(controls.operation).toHaveBeenCalledWith('createWorkspace', { workspaceId: WORKSPACE, name: "Ada's team", creationSource: 'onboarding' });
    expect(texts(renderer.root)).toContain("Beebee and Luna, two free agents, already live in Ada's team.");

    await press(renderer, 'invite-teammates');
    expect(controls.operation).toHaveBeenCalledWith('createInvite', { workspaceId: WORKSPACE });
    expect(renderer.root.findAll((node: any) => node.props?.['aria-label'] === 'Copy invite link' && node.type === 'ListItem')).toHaveLength(1);
    expect(texts(renderer.root)).toContain(`https://server.example/join/${TOKEN}`);
    expect(find(renderer, 'teammate-send')[0]!.props.disabled).toBe(true);
    await act(async () => find(renderer, 'teammate-email')[0]!.props.onChangeText('mara@example.com'));
    await press(renderer, 'teammate-send');
    expect(controls.operation).toHaveBeenCalledWith('inviteByEmail', { workspaceId: WORKSPACE, email: 'mara@example.com' });
    expect(find(renderer, 'teammate-invited')).toHaveLength(1);
    expect(find(renderer, 'teammate-email')[0]!.props.value).toBe('');
    await press(renderer, 'teammates-done');
    expect(texts(renderer.root)).toContain('1 invite sent');

    await press(renderer, 'invite-agents');
    await press(renderer, 'agent-connect');
    expect(controls.operation).toHaveBeenCalledWith('createAgentPairingCode', { workspaceId: WORKSPACE });
    expect(texts(renderer.root)).toContain('npx usebeeline connect K7Q-4MZ');
    await press(renderer, 'connect-continue');

    expect(find(renderer, 'onboarding-invite')).toHaveLength(1);
    await press(renderer, 'go-general');
    expect(controls.enter).toHaveBeenCalledWith(WORKSPACE, 'general');
  });

  it('previews a pasted invite link, and refuses something that is not one', async () => {
    controls.workspaces.mockResolvedValue({ workspaces: [{ id: 'w1', name: 'Crew' }], viewer: {} });
    const renderer = await render();
    expect(find(renderer, 'choice-join-form')).toHaveLength(0);
    await press(renderer, 'choice-join');
    await act(async () => find(renderer, 'choice-join-input')[0]!.props.onChangeText('hello'));
    await press(renderer, 'choice-join-preview');
    expect(find(renderer, 'choice-error')).toHaveLength(1);
    expect(controls.push).not.toHaveBeenCalled();

    await act(async () =>
      find(renderer, 'choice-join-input')[0]!.props.onChangeText(`https://usebeeline.app/join/${TOKEN}`),
    );
    await press(renderer, 'choice-join-preview');
    expect(controls.push).toHaveBeenCalledWith({ pathname: '/join/[token]', params: { token: TOKEN } });
  });

  it('opens a person who already has Workspaces on the choice, with a way back', async () => {
    controls.workspaces.mockResolvedValue({ workspaces: [{ id: 'w1', name: 'Crew' }], viewer: {} });
    const renderer = await render();
    expect(renderer.root.findAllByType('YouStep')).toHaveLength(0);
    expect(find(renderer, 'onboarding-workspace')).toHaveLength(1);
    await press(renderer, 'onboarding-back');
    expect(controls.back).toHaveBeenCalled();
  });

  it('opens straight on the invite field from the deck’s Join action', async () => {
    controls.params = { mode: 'join' };
    controls.workspaces.mockResolvedValue({ workspaces: [{ id: 'w1', name: 'Crew' }], viewer: {} });
    const renderer = await render();
    expect(find(renderer, 'choice-join-form')).toHaveLength(1);
  });

  it('opens on Create when the join path hands a first entry over', async () => {
    controls.params = { step: 'create' };
    const renderer = await render();
    expect(renderer.root.findAllByType('YouStep')).toHaveLength(0);
    expect(find(renderer, 'onboarding-create')).toHaveLength(1);
  });
});
