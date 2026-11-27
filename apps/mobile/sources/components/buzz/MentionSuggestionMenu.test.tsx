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
import { TextSizeContext, ThreadGlyph, typeStyle, type TextSize } from '@/ui/grammar';

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
  expect(texts()).toContain('In #beeline');
  act(() => tree.unmount());
  act(() => {
    tree = create(<ChannelSuggestionMenu query="be" overflow={3} highlightedIndex={0} keyboardOpen onSelect={() => undefined}
      matches={[{ kind: 'room', id: 'r1', token: 'beeline', subtitle: 'Beeline-Work/beeline' }, corner]} />);
  });
  expect(texts()).toEqual(expect.arrayContaining(['Chats', 'beeline', 'Beeline-Work/beeline', 'and 3 others']));
  act(() => tree.unmount());
  act(() => {
    tree = create(<ChannelSuggestionMenu query="" overflow={0} highlightedIndex={0} keyboardOpen onSelect={() => undefined}
      nowMs={(1_000_000 + 120) * 1000} matches={[{ ...corner, activityAt: 1_000_000 }, { kind: 'room', id: 'r2', token: 'issues-triage' }]} />);
  });
  expect(texts()).toEqual(['In #beeline', 'one-row-header', '2m', 'issues-triage']);
});

it('uses one title and keeps the keyboard window at three rows with this chat first', () => {
  const chat = { kind: 'room' as const, id: 'r', token: 'beeline', currentChat: true };
  const matches = [chat, ...Array.from({ length: 5 }, (_, i) => ({ kind: 'corner' as const, id: `c${i}`, token: `beeline/thread-${i}`, name: `thread-${i}` }))];
  act(() => { tree = create(<ChannelSuggestionMenu query="beeline" matches={matches} overflow={2} highlightedIndex={0} keyboardOpen onSelect={() => undefined} />); });
  expect(texts().filter((text: string) => text === 'In #beeline')).toHaveLength(1);
  expect(texts()).toContain('this chat');
  expect(texts()).toContain('and 5 others');
  expect(texts()).not.toContain('Other rooms');
  const scroll = tree.root.find((node: any) => node.type === 'ScrollView');
  expect(scroll.props.maxHeight).toBe(3 * 56);
  expect(tree.root.findAll((node: any) => node.type === 'ListItem')[0].props.testID).toBe('channel-suggestion-beeline');
});

it.each(['small', 'medium', 'large'] as const)(
  'aligns the thread mark to the thread name line when a suggestion carries a subtitle (%s text size)',
  (size: TextSize) => {
    const nameLine = typeStyle('metaStrong', size).lineHeight;
    const markSlot = Math.max(28, nameLine);
    const expectedInset = (markSlot - nameLine) / 2;
    const withSubtitle = {
      kind: 'corner' as const,
      id: 'c-sub',
      token: 'beeline/thread-glyph-center',
      name: 'thread-glyph-center',
      subtitle: '#beeline · active',
      activityAt: 1_000_000,
    };
    const withoutSubtitle = {
      kind: 'corner' as const,
      id: 'c-plain',
      token: 'beeline/one-row-header',
      name: 'one-row-header',
      activityAt: 1_000_000,
    };
    act(() => {
      tree = create(
        <TextSizeContext.Provider value={size}>
          <ChannelSuggestionMenu
            query="beeline/"
            matches={[withSubtitle, withoutSubtitle]}
            overflow={0}
            highlightedIndex={0}
            keyboardOpen
            nowMs={(1_000_000 + 60) * 1000}
            onSelect={() => undefined}
          />
        </TextSizeContext.Provider>,
      );
    });

    const subRow = row('channel-suggestion-beeline/thread-glyph-center');
    const subInner = subRow.find((n: any) => n.type === 'XStack' && n.props.flex === 1);
    expect(subInner.props.alignItems).toBe('flex-start');
    const subMark = subRow.find((n: any) => n.type === 'YStack' && n.props.testID === 'channel-suggestion-beeline/thread-glyph-center-mark');
    expect(subMark.props).toMatchObject({ width: 28, height: markSlot, justifyContent: 'center' });
    expect(subMark.findAllByType(ThreadGlyph)).toHaveLength(1);
    const subInset = subRow.find((n: any) => n.type === 'YStack' && n.props.testID === 'channel-suggestion-beeline/thread-glyph-center-name-inset');
    expect(subInset.props.height).toBe(expectedInset);
    expect(subInset.props.height + nameLine / 2).toBe(markSlot / 2);

    const plainRow = row('channel-suggestion-beeline/one-row-header');
    const plainInner = plainRow.find((n: any) => n.type === 'XStack' && n.props.flex === 1);
    expect(plainInner.props.alignItems).toBe('center');
    expect(plainRow.findAll((n: any) => n.props?.testID === 'channel-suggestion-beeline/one-row-header-name-inset')).toHaveLength(0);
  },
);
