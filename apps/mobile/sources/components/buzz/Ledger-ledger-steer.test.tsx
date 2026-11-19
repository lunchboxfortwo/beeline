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

import { LedgerSteer, LedgerSystemLine } from './Ledger-ledger-steer';

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


it('shows historical failed-head facts with the exact compact copy in the small role', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let tree: any;
  act(() => { tree = create(<LedgerSystemLine id="failure" text="Old stored PR title" stamp="09:51" bare
    event={{ subject: { kind: 'github', name: '@GitHub' }, kind: 'check-failed', verb: 'found failing checks on',
      object: { text: 'Setup: quiet defaults', url: 'https://github.com/owner/widgets/pull/112', headSha: '82828a8' + '1'.repeat(33) },
      consequence: 'failing typecheck' }} />); });
  const node = tree.root.find((node: any) => node.props.testID === 'system-line-text-failure' && node.props.v);
  expect(node.props.v).toBe('meta');
  expect(node.props.children).toEqual(['Failed check 82828a8']);
  act(() => tree.unmount());
});


it.each([
  '2 commits pushed · 82828a8',
  'Check failed · TYPECHECK · 82828a8',
  'Checks passed · 82828a8',
  'Review requested · Vera',
  '1 merge conflict',
])('renders the complete repository sentence in the small role: %s', verb => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let tree: any;
  act(() => { tree = create(<LedgerSystemLine id="repository" text="Old stored text" stamp="09:51" bare
    event={{ subject: { kind: 'github', name: '@beeline-app[bot]' }, verb,
      object: { text: 'PR title on feature/branch', headSha: '82828a8' + '1'.repeat(33) } }} />); });
  const node = tree.root.find((node: any) => node.props.testID === 'system-line-text-repository' && node.props.v);
  expect(node.props.v).toBe('meta');
  expect(node.props.children).toEqual([verb]);
  act(() => tree.unmount());
});
