import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: () => null }));
vi.mock('@/components/buzz/MemberRosterRow', () => ({
  memberRosterSubtitle: (row: { kind: string; ownerHandle?: string; role?: string }) =>
    row.kind === 'agent' ? (row.ownerHandle ? `@${row.ownerHandle}` : undefined) : row.role,
  memberRosterModel: (row: { model?: string }) => row.model,
}));
vi.mock('@/buzz/agent-display', () => ({ resolveAgentDisplayIdentity: (pubkey: string) => ({ name: pubkey }) }));
import { ChannelSuggestionMenu, MentionSuggestionMenu } from './MentionSuggestionMenu';
import { CHANNEL_MENTION_PUBKEY } from '@/buzz/room-participants';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let tree: any;
afterEach(() => { if (tree) act(() => tree.unmount()); tree = undefined; });
const texts = () => tree.root.findAll((node: any) => node.type === 'Text').map((node: any) =>
  [node.props.children].flat().join(''));
const row = (testID: string) => tree.root.find((node: any) => node.type === 'ListItem' && node.props.testID === testID);

it('heads @ suggestions with the chat in a plain sentence and reads like the roster', () => {
  const onSelect = vi.fn();
  const alan = { pubkey: 'alan', name: 'Alan', handle: 'alan', kind: 'agent' as const, agent: {} as never, model: 'Claude Opus 5.5', ownerHandle: 'lunchboxfortwo' };
  act(() => {
    tree = create(<MentionSuggestionMenu place="#beeline" overflow={1} highlightedIndex={1} keyboardOpen={false}
      personAvatar={() => undefined} onSelect={onSelect}
      matches={[{ pubkey: CHANNEL_MENTION_PUBKEY, name: 'channel', handle: 'channel', kind: 'person' }, alan]} />);
  });
  expect(texts()).toEqual(expect.arrayContaining([
    'People and agents in #beeline', '@channel', 'Everyone in this chat', '@alan',
    '@lunchboxfortwo · Claude Opus 5.5', 'and 1 other',
  ]));
  expect(row('mention-suggestion-alan').props.backgroundColor).toBe('highlight');
  expect(row('mention-suggestion-channel').props.backgroundColor).toBe('canvas');
  row('mention-suggestion-alan').props.onPress();
  expect(onSelect).toHaveBeenCalledWith(alan);
});

it('names the chat above its threads, then lists the other rooms', () => {
  const corner = { kind: 'corner' as const, id: 'c1', token: 'beeline/one-row-header', name: 'one-row-header', activityAt: 1_000 };
  act(() => {
    tree = create(<ChannelSuggestionMenu query="beeline/" matches={[corner]} overflow={0} highlightedIndex={0}
      keyboardOpen onSelect={() => undefined} />);
  });
  expect(texts()).toContain('Threads in #beeline');
  act(() => tree.unmount());
  act(() => {
    tree = create(<ChannelSuggestionMenu query="be" overflow={3} highlightedIndex={0} keyboardOpen onSelect={() => undefined}
      matches={[{ kind: 'room', id: 'r1', token: 'beeline', subtitle: 'Beeline-Work/beeline' }, corner]} />);
  });
  expect(texts()).toEqual(expect.arrayContaining(['Chats', '#beeline', 'Beeline-Work/beeline', 'and 3 others']));
  act(() => tree.unmount());
  act(() => {
    tree = create(<ChannelSuggestionMenu query="" overflow={0} highlightedIndex={0} keyboardOpen onSelect={() => undefined}
      nowMs={(1_000_000 + 120) * 1000} matches={[{ ...corner, activityAt: 1_000_000 }, { kind: 'room', id: 'r2', token: 'issues-triage' }]} />);
  });
  expect(texts()).toEqual(['Threads in #beeline', 'one-row-header', '2m', 'Other rooms', '#issues-triage']);
});
