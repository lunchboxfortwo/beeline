import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  operation: vi.fn(),
  read: vi.fn(),
  publish: vi.fn(async () => undefined),
  pick: vi.fn(),
  clearPending: vi.fn(async () => undefined),
  savePreferred: vi.fn(async () => 'Ada'),
}));

vi.mock('tamagui', async () => (await import('./onboarding.test-support')).tamaguiMock());
vi.mock('lucide-react-native', async () => (await import('./onboarding.test-support')).lucideMock());
vi.mock('./Rise', async () => (await import('./onboarding.test-support')).riseMock());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@beeline/buzz-client', () => ({
  normalizeManagedHandle: (value: string) => (/^[a-z0-9-]{3,30}$/.test(value.trim()) ? value.trim() : null),
}));
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('@/buzz/avatar-upload', () => ({ pickAndUploadAvatar: controls.pick }));
vi.mock('@/buzz/managed-identity-surface', () => ({
  readManagedIdentity: controls.read,
  publishManagedIdentity: controls.publish,
}));
vi.mock('@/buzz/person-name', () => ({
  clearPersonNameOnboardingPending: controls.clearPending,
  savePreferredPersonName: controls.savePreferred,
}));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'person-1' })) }));
vi.mock('@/sync/transport', () => ({ BuzzRigTransport: class { ensureClient = vi.fn(async () => ({})); } }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: controls.operation }));

import { YouStep } from './YouStep';
import { texts } from './onboarding.test-support';

const IDENTITY = {
  personId: 'person-1', name: 'Ada Lovelace', handle: 'ada', pushLevel: 'all',
  providers: [{ provider: 'github', login: 'ada', reconnect: false }],
};

const originalConsoleError = console.error;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

async function render(onDone = vi.fn()): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(YouStep, { onDone })); });
  await act(async () => undefined);
  return renderer;
}
const find = (renderer: ReactTestRenderer, testID: string) =>
  renderer.root.findAll((node: any) => node.props?.testID === testID && typeof node.type === 'string');
async function press(renderer: ReactTestRenderer, testID: string) {
  await act(async () => { await find(renderer, testID)[0]!.props.onPress(); });
}
async function type(renderer: ReactTestRenderer, testID: string, text: string) {
  await act(async () => find(renderer, testID)[0]!.props.onChangeText(text));
}

describe('You: name, handle and picture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.read.mockResolvedValue(IDENTITY);
    controls.operation.mockImplementation(async (name: string, input: any) => {
      if (name === 'claimManagedHandle') return { ...IDENTITY, handle: input.handle };
      if (name === 'getManagedIdentity') return IDENTITY;
      return { personId: 'person-1', name: 'Ada Lovelace' };
    });
  });

  it('prefills from the signed-in account, is stage 2 of the rail, and continues without rewriting what did not change', async () => {
    const onDone = vi.fn();
    const renderer = await render(onDone);
    expect(find(renderer, 'you-handle')[0]!.props.value).toBe('ada');
    expect(find(renderer, 'you-name')[0]!.props.value).toBe('Ada Lovelace');
    expect(texts(renderer.root)).toContain('From your GitHub account. Tap to change it; it becomes your verified Beeline identity.');
    expect(find(renderer, 'rail-done')).toHaveLength(2);
    // No photo: the generated first-initial mark, with a way to upload one.
    expect(renderer.root.findByType('IdentityMark' as any).props.avatarUrl).toBeUndefined();
    expect(find(renderer, 'you-upload')).toHaveLength(1);
    const button = find(renderer, 'you-continue')[0]!;
    expect(button.props.minHeight).toBe(52);

    await press(renderer, 'you-continue');
    expect(controls.operation).not.toHaveBeenCalled();
    expect(controls.clearPending).toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('claims a changed handle through the managed claim and refuses a taken one', async () => {
    const onDone = vi.fn();
    controls.operation.mockRejectedValueOnce(new Error('managed handle is already claimed'));
    const renderer = await render(onDone);
    await type(renderer, 'you-handle', 'Ada-Labs');
    expect(find(renderer, 'you-handle')[0]!.props.value).toBe('ada-labs');
    await press(renderer, 'you-continue');
    expect(controls.operation).toHaveBeenCalledWith('claimManagedHandle', { handle: 'ada-labs' });
    expect(texts(renderer.root)).toEqual(expect.arrayContaining(['HANDLE ALREADY CLAIMED', '@ada-labs belongs to someone else. Choose another handle.']));
    expect(onDone).not.toHaveBeenCalled();

    await press(renderer, 'you-continue');
    expect(controls.publish).toHaveBeenCalledWith({ ...IDENTITY, handle: 'ada-labs' });
    expect(controls.operation).not.toHaveBeenCalledWith('updatePersonProfile', expect.anything());
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('holds an invalid handle with the handle rule', async () => {
    const renderer = await render();
    await type(renderer, 'you-handle', 'a!');
    expect(texts(renderer.root)).toContain('Use 3–30 lowercase letters, numbers, or dashes.');
    expect(find(renderer, 'you-continue')[0]!.props.disabled).toBe(true);
    expect(find(renderer, 'you-handle')[0]!.props.borderColor).toBe('removed');
  });

  it('writes a new name and an uploaded photo, and the generated mark clears a photo', async () => {
    controls.pick.mockResolvedValue('https://media.example/ada.png');
    const renderer = await render();
    await type(renderer, 'you-name', 'Ada L.');
    await press(renderer, 'you-picture');
    expect(renderer.root.findByType('IdentityMark' as any).props.avatarUrl).toBe('https://media.example/ada.png');
    await press(renderer, 'you-continue');
    expect(controls.operation).toHaveBeenCalledWith('updatePersonProfile', { name: 'Ada L.', avatar: 'https://media.example/ada.png' });
    expect(controls.savePreferred).toHaveBeenCalledWith('person-1', 'Ada L.');

    controls.operation.mockClear();
    controls.read.mockResolvedValue({ ...IDENTITY, avatar: 'https://github.example/ada.png' });
    const withPhoto = await render();
    expect(withPhoto.root.findByType('IdentityMark' as any).props.avatarUrl).toBe('https://github.example/ada.png');
    await press(withPhoto, 'you-generated-mark');
    expect(withPhoto.root.findByType('IdentityMark' as any).props.avatarUrl).toBeUndefined();
    await press(withPhoto, 'you-continue');
    expect(controls.operation).toHaveBeenCalledWith('updatePersonProfile', { avatar: '' });
  });
});
