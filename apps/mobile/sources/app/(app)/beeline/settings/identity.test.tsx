vi.mock('@/components/buzz/Button', async () => {
  const React = await import('react');
  return { Button: (props: any) => React.createElement('Button', props, React.createElement('Text', null, props.label)) };
});
vi.mock('@expo/vector-icons/Ionicons', async () => { const R = await import('react'); return { default: (props: any) => R.createElement('Ionicons', props) }; });
vi.mock('react-native-keyboard-controller', async () => { const R = await import('react'); return { KeyboardAvoidingView: (props: any) => R.createElement('View', props, props.children) }; });
import * as React from 'react';
import type { ManagedIdentityResult } from '@beeline/api-contract/phone';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Personal photos are built (firstmate decision lifting the old photo-override
// darkflight): Settings → You uploads through the Workspace picture's picker
// and saves it on the person's profile; Remove returns to the first initial.

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const client = vi.hoisted(() => ({
  listCommunities: vi.fn(async () => []),
  getGlobalPersonProfile: vi.fn(async () => ({
    name: 'Captain',
    avatar: 'https://example.test/captain.png',
  })),
}));
const pushModule = vi.hoisted(() => ({
  getBuzzPushEnabled: vi.fn(async () => true),
  getBuzzPushRegistrationState: vi.fn(async () => null),
  registerBuzzPushNotifications: vi.fn(),
  setBuzzPushEnabled: vi.fn(),
}));
const permissionInfo = vi.hoisted(() => ({
  getPushPermissionInfo: vi.fn(async () => ({
    status: 'granted',
    granted: true,
    canAskAgain: true,
  })),
}));
const phoneOperation = vi.hoisted(() => vi.fn());
const identityApi = vi.hoisted(() => ({
  lookupRecovery: vi.fn(async () => []),
  lookupManagedIdentity: vi.fn(async () => null),
}));

vi.mock('expo-router', () => ({
  router: navigation,
  useLocalSearchParams: () => ({}),
  useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-linking', () => ({
  createURL: (path: string) => `beeline://${path}`,
  addEventListener: vi.fn(() => ({ remove: vi.fn() })),
}));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock('expo-updates', () => ({
  isEnabled: false,
  channel: null,
  updateId: null,
  checkForUpdateAsync: vi.fn(),
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
}));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(async () => undefined),
  NotificationFeedbackType: { Success: 'SUCCESS', Warning: 'WARNING', Error: 'ERROR' },
}));
vi.mock('expo-local-authentication', () => ({
  hasHardwareAsync: vi.fn(async () => false),
  isEnrolledAsync: vi.fn(async () => false),
  supportedAuthenticationTypesAsync: vi.fn(async () => []),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('qrcode', () => ({ create: vi.fn(() => ({ modules: { size: 0, get: () => 0 } })) }));
vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: React.Attributes) => ReactModule.createElement(name, props);
  return {
    Dimensions: { get: () => ({ width: 390, height: 844 }) },
    default: host('Svg'),
    Svg: host('Svg'),
    Path: host('Path'),
    Rect: host('Rect'),
    Circle: host('Circle'),
    Polygon: host('Polygon'),
    Polyline: host('Polyline'),
    G: host('G'),
  };
});
vi.mock('@beeline/buzz-client', () => ({
  adoptGitHubHandle: vi.fn(),
  buildOidcBindEvent: vi.fn(),
  finishOidcBind: vi.fn(),
  fallbackPersonName: (pubkey: string) => `Person ${pubkey.slice(0, 4)}`,
  isWorkspaceListView: () => true,
  isWorkspaceView: (value: any) => Array.isArray(value?.members),
  lookupRecovery: identityApi.lookupRecovery,
  lookupManagedIdentity: identityApi.lookupManagedIdentity,
  normalizeNip05Identifier: (value: string) => value.trim().toLowerCase(),
  normalizePersonHandle: (value: string) => value.trim().toLowerCase() || null,
  normalizePersonName: (value: string) => value.trim() || null,
  personHandle: (name: string) => name.toLowerCase(),
  RoomViewClient: class {
    workspaces = vi.fn(async () => ({ workspaces: [] }));
  },
  startGitHubBind: vi.fn(),
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({
    publicKey: 'a'.repeat(64),
    secretKey: new Uint8Array(32).fill(1),
  })),
  loadBuzzIdentityNsecForExport: vi.fn(async () => 'nsec1test'),
}));
vi.mock('@/buzz/community-storage', () => ({
  loadActiveCommunityId: vi.fn(async () => null),
  watchActiveCommunityId: vi.fn((_pubkey: string, listener: (id: string | null) => void) => {
    void Promise.resolve(null).then(listener);
    return () => undefined;
  }),
}));
vi.mock('@/buzz/avatar-upload', () => ({ pickAndUploadAvatar: vi.fn() }));
vi.mock('@/buzz/person-name', () => ({
  ensurePersonNameForWorkspace: vi.fn(async () => ({ name: 'Captain' })),
  loadPreferredPersonName: vi.fn(async () => 'Captain'),
  savePreferredPersonName: vi.fn(async () => undefined),
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({
    relayUrl: 'https://relay.test',
    pushGatewayUrl: 'https://push.test',
  }),
}));
vi.mock('@/sync/appConfig', () => ({
  loadAppConfig: () => ({ releaseVersion: 'v0.0.1', releaseSha: null }),
}));
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: React.Attributes) => ReactModule.createElement(name, props);
  return {
    HullSurface: host('HullSurface'),
    PixelLoader: host('PixelLoader'),
  };
});
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return {
    IdentityMark: (props: React.Attributes) => ReactModule.createElement('IdentityMark', props),
    isPersonPictureUrl: (url?: string) => Boolean(url?.includes('/v1/person-avatars/')),
  };
});
vi.mock('@/components/buzz/BeelineMark', async () => {
  const ReactModule = await import('react');
  return { BeelineMark: (props: React.Attributes) => ReactModule.createElement('BeelineMark', props) };
});
vi.mock('@/utils/open-external-url', () => ({
  openExternalUrl: vi.fn(async () => undefined),
}));
// Real @/display boots native system chrome and MMKV-backed local settings,
// neither of which this screen's own tests exercise or mock elsewhere.
vi.mock('@/display', () => ({ applyAppearanceChoice: vi.fn(), useAppMode: () => 'dark' }));
vi.mock('@/sync/storage', () => ({
  useLocalSettingMutable: (name: string) => [name === 'appearance' ? 'dark' : name === 'palette' ? 'brass' : name === 'roomOpenTraceOverlay' ? false : 'medium', vi.fn()],
}));
vi.mock('tamagui', async () => {
  const hosts = (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts() as Record<string, any>;
  hosts.Switch.Thumb = (props: any) => React.createElement('Switch.Thumb', props);
  return hosts;
});
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('@/buzz/needs-you-store', () => ({ useNeedsYouCount: () => 0 }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/components/buzz/ServiceMark', () => ({ ServiceMark: (props: any) => React.createElement('ServiceMark', props) }));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => client);
  },
}));
vi.mock('@/push/buzz-push-registration', () => pushModule);
vi.mock('@/push/push-level-storage', () => ({
  saveStoredPushLevel: vi.fn(async () => undefined),
  watchStoredPushLevel: () => () => undefined,
}));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: phoneOperation }));
vi.mock('@/buzz/identity-live', () => ({ subscribeOwnIdentityChange: () => () => undefined }));
vi.mock('@/sync/pushRegistration', () => permissionInfo);
vi.mock('@/buzz/surface-storage', () => {
  type Address = { endpoint: string; params?: Record<string, unknown> };
  const values = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();
  const key = (address: Address) => `${address.endpoint}:${JSON.stringify(address.params ?? {})}`;
  const announce = (address: Address) => listeners.get(key(address))?.forEach((listener) => listener());
  return {
    surfaceAddress: (_relay: string, _viewer: string, endpoint: string,
      params?: Record<string, unknown>) => ({ endpoint, params }),
    clearMobileSurfaceStorage: () => {
      values.clear(); listeners.forEach((set) => set.forEach((listener) => listener()));
    },
    mobileSurfaceCache: {
      clear: () => { values.clear(); listeners.forEach((set) => set.forEach((listener) => listener())); },
      peek: (address: Address) => values.get(key(address)) ?? null,
      read: async (address: Address) => values.get(key(address)) ?? null,
      write: async (address: Address, value: unknown) => {
        values.set(key(address), value); announce(address);
      },
      publish: (address: Address, value: unknown) => {
        values.set(key(address), value); announce(address); return value;
      },
      remove: async (address: Address) => { values.delete(key(address)); announce(address); },
      fetch: async (address: Address, _guard: unknown, request: () => Promise<unknown>) => {
        const value = await request(); values.set(key(address), value); announce(address); return value;
      },
      subscribe: (address: Address, listener: () => void) => {
        const set = listeners.get(key(address)) ?? new Set<() => void>();
        set.add(listener); listeners.set(key(address), set);
        return () => { set.delete(listener); };
      },
    },
  };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: React.Attributes) =>
    ReactModule.createElement(name, props as never);
  return {
    Platform: { OS: 'web', select: (choices: Record<string, unknown>) => choices.default },
    AppState: {
      addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    },
    ScrollView: host('ScrollView'),
    Share: { share: vi.fn() },
    Switch: host('Switch'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    StyleSheet: {
      create: (styles: unknown) =>
        typeof styles === 'function'
          ? (styles as (theme: unknown) => unknown)({ buzz: beelineThemes.obsidian })
          : styles,
      flatten: (s: unknown) => s,
    },
  };
});

// The theme has to be live before the screen evaluates, because the mocked
// StyleSheet.create calls the screen's theme-taking factory as it imports.
import { beelineThemes } from '@/buzz/groknight';
import IdentitySettingsScreen from './identity';
import { mobileSurfaceCache } from '@/buzz/surface-storage';
import { openExternalUrl } from '@/utils/open-external-url';
import { useYouSettings } from '@/ui/screens/settings/useYouSettings';
import { SettingsScreen } from '@/ui/screens/settings/SettingsScreen';

const originalConsoleError = console.error;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (
      typeof message === 'string' &&
      (message.startsWith('react-test-renderer is deprecated') || message.includes('act('))
    ) {
      return;
    }
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

function identitySettings(handle: string | null, providers: Array<{ provider: 'github' | 'google'; login?: string }> = []) {
  return {
    identity: { personId: 'a'.repeat(64), face: null, pushLevel: 'attention', handle, name: 'Captain', providers },
    workspaces: { workspaces: [] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mobileSurfaceCache.clear();
  phoneOperation.mockImplementation(async (name: string) => {
    if (name === 'readIdentitySettings') return identitySettings(null);
    throw new Error(`unexpected operation ${name}`);
  });
  identityApi.lookupManagedIdentity.mockResolvedValue(null);
  client.getGlobalPersonProfile.mockResolvedValue({
    name: 'Captain',
    avatar: 'https://example.test/captain.png',
  });
});

async function renderScreen(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(IdentitySettingsScreen));
    // Profile hydration crosses the identity, relay, and managed-identity
    // boundaries before it renders its fields.
    for (let pass = 0; pass < 8; pass += 1) await Promise.resolve();
  });
  return renderer;
}

function renderedText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType('Text')
    .map((node: any) => (typeof node.props.children === 'string' ? node.props.children : ''))
    .join(' ');
}


const PHOTO = 'https://beeline.test/v1/person-avatars/11111111-1111-4111-8111-111111111111';
const byId = (renderer: ReactTestRenderer, id: string): any => renderer.root.findAll((node: any) => node.props.testID === id)[0];
function managed(avatar?: string): ManagedIdentityResult {
  return { personId: 'a'.repeat(64), name: 'Dan', handle: 'lunchboxfortwo', pushLevel: 'attention', providers: [], ...(avatar ? { avatar } : {}) };
}
function operations(state: { avatar?: string }) {
  phoneOperation.mockImplementation(async (name: string, input?: { avatar?: string }) => {
    if (name === 'readIdentitySettings') return { identity: managed(state.avatar), workspaces: { workspaces: [] } };
    if (name === 'getManagedIdentity') return managed(state.avatar);
    if (name === 'updatePersonProfile') {
      state.avatar = input?.avatar ? PHOTO : undefined;
      return { personId: 'a'.repeat(64), name: 'Dan', ...(state.avatar ? { avatar: state.avatar } : {}) };
    }
    throw new Error(`unexpected operation ${name}`);
  });
}

it('renders a saved Workspace role during refresh and applies the fresh role when it arrives', async () => {
  const { surfaceAddress } = await import('@/buzz/surface-storage');
  const { isWorkspaceListView } = await import('@beeline/buzz-client');
  const entry = { id: 'workspace-1', name: 'Workspace', role: 'owner' as const, visibility: 'invite-only' as const,
    updatedAt: 1, roomCount: 0, attention: false };
  await mobileSurfaceCache.write(surfaceAddress('https://relay.test', 'a'.repeat(64), '/workspaces'),
    { viewer: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Dan' }, workspaces: [entry], truncated: false, watchFilters: [] }, isWorkspaceListView);
  let complete!: (value: unknown) => void;
  phoneOperation.mockImplementation((name: string) => name === 'readIdentitySettings'
    ? new Promise(resolve => { complete = resolve; })
    : Promise.resolve({ apps: [], helpers: [], connectors: [], connections: [] }));
  let settings!: ReturnType<typeof useYouSettings>;
  function Probe() {
    settings = useYouSettings({ linkedWorkspaceId: entry.id, showWorkbench: false });
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Probe />); });
  await vi.waitFor(() => expect(settings.canManageWorkspace).toBe(true));
  expect(phoneOperation.mock.calls.filter(([name]) => name === 'readIdentitySettings')).toHaveLength(1);
  expect(phoneOperation).not.toHaveBeenCalledWith('readWorkbench', expect.anything());
  await act(async () => { complete({ identity: managed(), workspaces: { workspaces: [{ ...entry, role: 'member' }] } }); });
  expect(settings.canManageWorkspace).toBe(false);
  await act(async () => renderer.unmount());
});

it('does not mount the unselected You form while resolving Workspace scope, and retains the empty-workspace fallback', async () => {
  let complete!: (value: unknown) => void;
  phoneOperation.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<SettingsScreen initialScope="workspace" />); });
  try {
    expect(byId(renderer, 'workspace-settings-loader')).toBeDefined();
    expect(byId(renderer, 'profile-picture-mark')).toBeUndefined();
    await act(async () => { complete(identitySettings(null)); });
    expect(byId(renderer, 'profile-picture-mark')).toBeDefined();
  } finally { act(() => renderer.unmount()); }
});

describe('Settings → You → Profile picture', () => {
  it('shows the generated mark with Upload photo and no Remove when there is no photo', async () => {
    operations({});
    const renderer = await renderScreen();
    await vi.waitFor(() => expect(byId(renderer, 'profile-picture-mark').props.handle).toBe('lunchboxfortwo'));
    expect(byId(renderer, 'profile-picture-mark').props.avatarUrl).toBeUndefined();
    expect(renderedText(renderer)).toContain('Your generated mark');
    expect(byId(renderer, 'profile-picture-upload')).toBeDefined();
    expect(byId(renderer, 'profile-picture-remove')).toBeUndefined();
  });

  it('SETTINGS-PICTURE-1: refreshes an older settings identity when the shared viewer already has a photo', async () => {
    operations({ avatar: PHOTO });
    const { surfaceAddress } = await import('@/buzz/surface-storage');
    const { isManagedIdentity } = await import('@/buzz/managed-identity-surface');
    const { isWorkspaceListView } = await import('@beeline/buzz-client');
    await mobileSurfaceCache.write(surfaceAddress('https://relay.test', 'a'.repeat(64), '/identity/managed'), managed(), isManagedIdentity);
    await mobileSurfaceCache.write(surfaceAddress('https://relay.test', 'a'.repeat(64), '/workspaces'), {
      viewer: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Dan', avatar: PHOTO }, workspaces: [], truncated: false, watchFilters: [],
    }, isWorkspaceListView);
    const renderer = await renderScreen();
    await vi.waitFor(() => expect(byId(renderer, 'profile-picture-mark').props.avatarUrl).toBe(PHOTO));
    expect(renderedText(renderer)).toContain('Your photo');
    expect(byId(renderer, 'profile-picture-remove')).toBeDefined();
    expect(phoneOperation.mock.calls.filter(([name]) => name === 'readIdentitySettings')).toHaveLength(1);
    expect(phoneOperation).not.toHaveBeenCalledWith('getManagedIdentity', {});
  });

  it('uploads a photo with the Workspace picture picker and saves it on the profile', async () => {
    const state: { avatar?: string } = {};
    operations(state);
    const { pickAndUploadAvatar } = await import('@/buzz/avatar-upload');
    vi.mocked(pickAndUploadAvatar).mockResolvedValue('https://beeline.test/v1/media/22222222-2222-4222-8222-222222222222');
    const renderer = await renderScreen();
    await vi.waitFor(() => expect(byId(renderer, 'profile-picture-upload').props.disabled).toBe(false));
    await act(async () => { byId(renderer, 'profile-picture-upload').props.onPress(); for (let pass = 0; pass < 6; pass += 1) await Promise.resolve(); });
    expect(pickAndUploadAvatar).toHaveBeenCalledWith(client);
    expect(phoneOperation).toHaveBeenCalledWith('updatePersonProfile', { avatar: 'https://beeline.test/v1/media/22222222-2222-4222-8222-222222222222' });
    await vi.waitFor(() => expect(byId(renderer, 'profile-picture-mark').props.avatarUrl).toBe(PHOTO));
    expect(renderedText(renderer)).toContain('Your photo');
    expect(byId(renderer, 'profile-picture-remove')).toBeDefined();
  });

  it('removes the photo back to the first initial', async () => {
    const state: { avatar?: string } = { avatar: PHOTO };
    operations(state);
    const renderer = await renderScreen();
    await vi.waitFor(() => expect(byId(renderer, 'profile-picture-remove')).toBeDefined());
    await act(async () => { byId(renderer, 'profile-picture-remove').props.onPress(); for (let pass = 0; pass < 6; pass += 1) await Promise.resolve(); });
    expect(phoneOperation).toHaveBeenCalledWith('updatePersonProfile', { avatar: '' });
    await vi.waitFor(() => expect(byId(renderer, 'profile-picture-mark').props.avatarUrl).toBeUndefined());
    expect(byId(renderer, 'profile-picture-remove')).toBeUndefined();
  });
});

describe('Settings tab', () => {
  it('carries the shared tab header instead of a Settings title, and captions @handle (the shared layout draws the tab bar)', async () => {
    operations({});
    const renderer = await renderScreen();
    expect(renderer.root.findAll((node: any) => node.type === 'Text' && node.props.children === 'Settings')).toHaveLength(0);
    await vi.waitFor(() => expect(byId(renderer, 'settings-caption')?.props.children).toBe('@lunchboxfortwo'));
    expect(renderer.root.findAll((node: any) => node.type === 'TabBar')).toHaveLength(0);
    expect(byId(renderer, 'room-search-open')).toBeUndefined();
    expect(byId(renderer, 'new-chat')).toBeUndefined();
    expect(byId(renderer, 'community-drawer-overlay')).toBeUndefined();
    await act(async () => byId(renderer, 'workspace-switcher').props.onPress());
    expect(byId(renderer, 'community-drawer-overlay')).toBeDefined();
  });

  it('lists Device, Account and the version check, without Getting started', async () => {
    operations({});
    const renderer = await renderScreen();
    const text = renderedText(renderer);
    for (const label of ['Profile picture', 'Connectors', 'Your connections', 'Device', 'Appearance', 'Color set', 'Speaking speed', 'Account', 'Privacy Policy', 'Terms of Service', 'Send feedback', 'Sign out', 'Delete account'])
      expect(text).toContain(label);
    expect(text).not.toContain('Getting started');
    expect(byId(renderer, 'ota-update-check')).toBeDefined();
  });

  it('asks before deleting the account', async () => {
    operations({});
    const renderer = await renderScreen();
    act(() => byId(renderer, 'delete-account-setting').props.onPress());
    expect(renderedText(renderer)).toContain('deleting your account will delete all your data. this action is irrevocable. confirm?');
    act(() => byId(renderer, 'delete-account-cancel').props.onPress());
    expect(byId(renderer, 'confirm-delete-account')).toBeUndefined();
  });

  it('opens Connectors with the workspace and viewer', async () => {
    operations({});
    const renderer = await renderScreen();
    await vi.waitFor(() => expect(byId(renderer, 'profile-picture-upload').props.disabled).toBe(false));
    act(() => byId(renderer, 'settings-workbench-row').props.onPress());
    expect(navigation.push).toHaveBeenCalledWith({ pathname: '/beeline/settings/workbench', params: { workspaceId: '', viewerId: 'a'.repeat(64) } });
  });
});
