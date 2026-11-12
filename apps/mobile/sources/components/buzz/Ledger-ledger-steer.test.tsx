import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, Pressable: 'Pressable', Text: 'Text', View: 'View' }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('./IdentityMark', () => ({ IdentityMark: (props: any) => React.createElement('IdentityMark', props) }));
vi.mock('./MonoMarkdown', () => ({ MonoMarkdown: (props: any) => React.createElement('MonoMarkdown', props) }));

import { LedgerSteer } from './Ledger-ledger-steer';

it('shows your own message with your name in brass and the body in ink', () => {
  let tree: any;
  act(() => {
    tree = create(
      <LedgerSteer itemId="m1" bodyText="hi @kai" bodyTestID="body" mentionHandles={['kai']}
        byline={{ name: 'Dan', stamp: '09:51', isViewer: true }} />,
    );
  });
  const name = tree.root.find((node: any) => node.props.testID === 'chat-byline-name' && node.props.color);
  expect(name.props.color).toBe('needsYou');
  const body = tree.root.find((node: any) => node.props.view && node.props.markdown === 'hi @kai');
  expect(body.props.color).toBe('ink');
  expect(body.props.mentionHandles).toEqual(['kai']);
});
