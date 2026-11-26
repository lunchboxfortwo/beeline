import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: () => null }));
vi.mock('@/ui/grammar', async () => {
  const { createElement } = await import('react');
  return {
    T: (p: any) => createElement('Text', p, p.children),
    Btn: (p: any) => createElement('Button', { 'aria-label': p.label, ...p }, p.children),
    SheetScroll: (p: any) => createElement('ScrollView', p, p.children),
    SheetFrame: (p: any) => (p.open ? createElement('Sheet', { testID: p.testID, title: p.title }, p.children) : null),
  };
});

import { NewTaskSheet } from './NewTaskSheet';

it('creates a UUID backlog task with chosen chat, title, optional objective, and optional assignee', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const close = vi.fn();
  const onCreate = vi.fn(async () => true);
  const chats = [
    { id: 'chat-1', name: 'beeline' },
    { id: 'chat-2', name: 'ops' },
  ];
  const people = [
    { pubkey: 'human-1', kind: 'human' as const, name: 'Ada' },
    { pubkey: 'agent-1', kind: 'agent' as const, name: 'Ruby' },
  ];
  let tree: any;
  act(() => {
    tree = create(
      <NewTaskSheet
        open
        close={close}
        chats={chats}
        people={people}
        defaultChatId="chat-1"
        onCreate={onCreate}
      />,
    );
  });
  const host = (id: string) =>
    tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === id);
  try {
    // Switch chat from default #beeline to #ops
    act(() => { host('new-task-chat-toggle').props.onPress(); });
    act(() => {
      tree.root.find((node: any) => node.props['aria-label'] === 'Select chat #ops').props.onPress();
    });
    // Fill title and objective
    act(() => { host('new-task-title').props.onChangeText('Fix column drag'); });
    act(() => { host('new-task-objective').props.onChangeText('Allow dragging tasks across columns.'); });
    // Pick assignee
    act(() => { host('new-task-assignee-toggle').props.onPress(); });
    act(() => {
      tree.root.find((node: any) => node.props['aria-label'] === 'Assign to Ruby').props.onPress();
    });
    // Submit
    await act(async () => { await host('new-task-submit').props.onPress(); });
    expect(onCreate).toHaveBeenCalledWith({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
      roomId: 'chat-2',
      title: 'Fix column drag',
      objective: 'Allow dragging tasks across columns.',
      assigneeId: 'agent-1',
    });
    expect(close).toHaveBeenCalledOnce();
  } finally {
    act(() => tree.unmount());
  }
});
