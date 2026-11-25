import React from 'react';
import { Linking } from 'react-native';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentSignInCard } from './AgentSignInCard';

vi.mock('react-native', () => ({ Linking: { openURL: vi.fn() }, Platform: { OS: 'web' } }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('./AppMark', () => ({ AppMark: () => null }));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  { harness: 'claude', kind: 'paste-code', authorizeUrl: 'https://claude.ai/oauth/authorize?client_id=example', label: 'Open claude.ai' },
  { harness: 'codex', kind: 'device-code', authorizeUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', label: 'Open sign-in page' },
] as const)('opens the $kind card URL', ({ label, ...flow }) => {
  let tree: ReturnType<typeof create>;
  act(() => {
    tree = create(<AgentSignInCard agentName="Emberus" isOwner onSubmit={vi.fn()}
      card={{ agentId: 'agent', ownerId: 'owner', status: 'pending', ...flow }} />);
  });
  const open = tree.root.findByProps({ testID: 'agent-sign-in-open', accessibilityRole: 'button' });
  expect(open.props.accessibilityLabel).toBe(label);
  expect(open.props.alignSelf).toBe('stretch');
  expect(open.findByProps({ testID: 'button-destination-external' })).toBeDefined();
  act(() => open.props.onPress());
  expect(Linking.openURL).toHaveBeenCalledExactlyOnceWith(flow.authorizeUrl);
  act(() => tree.unmount());
});
