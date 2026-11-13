import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ChatLinkView } from '@beeline/api-contract/phone';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/buzz/CodeBlock', () => ({ CodeBlock: () => null }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/components/buzz/HullDialog', () => ({
  HullModal: (props: Record<string, unknown>) => React.createElement('HullModal', props),
  HullFloatingSurface: (props: Record<string, unknown>) => React.createElement('HullFloatingSurface', props),
}));
vi.mock('@/components/buzz/Button', () => ({ Button: (props: Record<string, unknown>) => React.createElement('Button', props) }));
import { createChatLinkStore } from '@/buzz/chat-link-store';
import { ChatLinkProvider } from './ChatLinkProvider';
import { MonoMarkdown } from './MonoMarkdown';

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

const preview = { author: 'Candy', createdAt: Date.UTC(2026, 10, 12, 8, 15) / 1000, firstLine: 'Send button stays grey after the first message on Android.' };
const LINKS: Record<string, ChatLinkView> = {
  '↳sending-new-message': { key: '↳sending-new-message', kind: 'thread', roomId: 'thread-1', parentRoomId: 'room-1', name: 'sending-new-message' },
  '¶candy-2773': { key: '¶candy-2773', kind: 'message', messageId: 'f'.repeat(64), roomId: 'thread-1', workspaceId: 'w1', threadName: 'sending-new-message', preview },
  '¶bbc-118': { key: '¶bbc-118', kind: 'message', messageId: 'e'.repeat(64), roomId: 'room-2', workspaceId: 'w1', chatName: 'issues-triage', preview },
  '↳notes': { key: '↳notes', kind: 'private' },
  '¶eve-4': { key: '¶eve-4', kind: 'private' },
};

async function renderMessage(markdown: string) {
  const resolve = vi.fn(async (_roomId: string, tokens: readonly string[]) => ({
    links: tokens.flatMap((token) => LINKS[token.toLowerCase()] ? [LINKS[token.toLowerCase()]!] : []),
  }));
  const onOpenThread = vi.fn();
  const onOpenMessage = vi.fn();
  let tree: any;
  await act(async () => {
    tree = create(
      <ChatLinkProvider roomId="room-1" store={createChatLinkStore(resolve)} onOpenThread={onOpenThread} onOpenMessage={onOpenMessage}>
        <MonoMarkdown textStyle={{}} markdown={markdown} />
      </ChatLinkProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); });
  return { tree, resolve, onOpenThread, onOpenMessage };
}

const textOf = (node: any): string => React.Children.toArray(node.props.children)
  .map((child: any) => typeof child === 'string' ? child : child?.props ? textOf(child) : '').join('');

it('draws resolved thread and message links like a mention, and opens them', async () => {
  const { tree, resolve, onOpenThread, onOpenMessage } = await renderMessage(
    'The fix landed in ↳sending-new-message. Candy\'s report was ¶candy-2773.',
  );
  expect(resolve).toHaveBeenCalledExactlyOnceWith('room-1', ['↳sending-new-message', '¶candy-2773']);
  const thread = tree.root.findByProps({ testID: 'chat-link-thread' });
  const message = tree.root.findByProps({ testID: 'chat-link-message' });
  expect(textOf(thread)).toBe('↳sending-new-message');
  expect(textOf(message)).toBe('¶candy-2773');
  expect(thread.props.accessibilityRole).toBe('link');
  act(() => thread.props.onPress());
  expect(onOpenThread).toHaveBeenCalledWith(LINKS['↳sending-new-message']);
  act(() => message.props.onPress());
  expect(onOpenMessage).toHaveBeenCalledWith(LINKS['¶candy-2773']);
  act(() => tree.unmount());
});

it('names another chat, shows a private thread or message as private, and leaves a miss as plain text', async () => {
  const { tree } = await renderMessage('Same cause as ¶bbc-118. Notes are in ↳notes, see ¶eve-4. The old ¶ruby-9999 did not match.');
  expect(textOf(tree.root.findByProps({ testID: 'chat-link-message' }))).toBe('¶bbc-118 · #issues-triage');
  const hidden = tree.root.findAllByProps({ testID: 'chat-link-private' });
  expect([...new Set(hidden.map(textOf))]).toEqual(['↳ private thread', '¶ private message']);
  expect(hidden.every((node: any) => node.props.onPress === undefined)).toBe(true);
  const flat = (node: any): string => !node ? '' : typeof node === 'string' ? node
    : Array.isArray(node) ? node.map(flat).join('') : flat(node.children);
  expect(flat(tree.toJSON())).toContain('The old ¶ruby-9999 did not match.');
  expect(tree.root.findAllByProps({ testID: 'chat-link-message' }).some((node: any) => textOf(node).includes('ruby'))).toBe(false);
  act(() => tree.unmount());
});

it('long press previews the author, place, time and first line, and Open follows the link', async () => {
  const { tree, onOpenMessage } = await renderMessage('Report: ¶candy-2773');
  // On Android a selectable paragraph would also start native text selection
  // under the held link, so prose holding a link is not selectable there.
  expect(tree.root.findAll((node: any) => node.props.userSelect !== undefined && node.props.userSelect !== 'none')).toHaveLength(0);
  act(() => tree.root.findByProps({ testID: 'chat-link-message' }).props.onLongPress());
  const card = tree.root.findByProps({ testID: 'chat-link-preview' });
  const lines = card.findAll((node: any) => node.type === 'Text').map(textOf);
  expect(lines[0]).toMatch(/^Candy · ↳sending-new-message · \d\d:\d\d$/);
  expect(lines).toContain('Send button stays grey after the first message on Android.');
  act(() => tree.root.findByProps({ testID: 'chat-link-preview-open' }).props.onPress());
  expect(onOpenMessage).toHaveBeenCalledWith(LINKS['¶candy-2773']);
  expect(tree.root.findAllByProps({ testID: 'chat-link-preview' })).toHaveLength(0);
  act(() => tree.unmount());
});

it('keeps tokens as plain text outside a chat', () => {
  let tree: any;
  act(() => { tree = create(<MonoMarkdown textStyle={{}} markdown="See ↳notes" />); });
  expect(tree.root.findAllByProps({ testID: 'chat-link-thread' })).toHaveLength(0);
  act(() => tree.unmount());
});
