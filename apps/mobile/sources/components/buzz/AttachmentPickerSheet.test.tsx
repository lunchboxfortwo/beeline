import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

const back = vi.hoisted(() => ({ listeners: [] as (() => boolean)[] }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  BackHandler: {
    addEventListener: (_: string, handler: () => boolean) => {
      back.listeners.push(handler);
      return { remove: () => { back.listeners = back.listeners.filter((h) => h !== handler); } };
    },
  },
}));
vi.mock('@/ui/lower-keyboard', () => ({ lowerKeyboard: () => undefined }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
import { AttachmentPickerSheet } from './AttachmentPickerSheet';

it('ATTACH-BACK-1: one Back closes Attach and leaves the chat open; the next Back leaves the chat', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const leaveChat = vi.fn(() => true);
  const pick = vi.fn();
  back.listeners = [leaveChat];
  const pressBack = () => {
    for (const listener of [...back.listeners].reverse()) if (listener()) break;
  };
  function Chat() {
    const [visible, setVisible] = React.useState(true);
    return <AttachmentPickerSheet visible={visible} onClose={() => setVisible(false)} onPickPhoto={pick} onPickDocument={pick} />;
  }
  let tree: ReturnType<typeof create>;
  act(() => { tree = create(<Chat />); });
  expect(tree!.root.findByType('Sheet').props.open).toBe(true);
  act(pressBack);
  expect(tree!.root.findByType('Sheet').props.open).toBe(false);
  expect(leaveChat).not.toHaveBeenCalled();
  expect(pick).not.toHaveBeenCalled();
  act(pressBack);
  expect(leaveChat).toHaveBeenCalledOnce();
  act(() => tree!.unmount());
  expect(back.listeners).toEqual([leaveChat]);
});
