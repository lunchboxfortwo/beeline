import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import { TranscriptReference } from './TranscriptReference';
import { TextSizeContext, type TextSize } from '@/ui/grammar';

vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/ui/lower-keyboard', () => ({ lowerKeyboard: vi.fn() }));

beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
const longOriginal = Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1}: ${'The second deploy failed. '.repeat(10)}`).join('\n\n');

it.each<TextSize>(['small', 'medium', 'large'])('QUOTE-CLAMP: limits the quoted original to two lines at %s text size, with or without a source link', size => {
  for (const onPress of [undefined, vi.fn()]) {
    let tree: any;
    act(() => { tree = create(<TextSizeContext.Provider value={size}>
      <TranscriptReference onPress={onPress} accessibilityLabel="Open original message" testID="quote">
        {longOriginal}
      </TranscriptReference>
    </TextSizeContext.Provider>); });
    // Exercise the real grammar T through to the Text host shared by phone and web/desktop.
    const text = tree.root.findByType('Text');
    expect(text.props.numberOfLines).toBe(2);
    expect(text.props.children).toBe(longOriginal);
    if (onPress) {
      const link = tree.root.find((node: any) => node.type === 'YStack' && node.props.testID === 'quote');
      act(() => link.props.onPress());
      expect(onPress).toHaveBeenCalledOnce();
    }
    act(() => tree.unmount());
  }
});

it('VIEWER-REFERENCE-CLAMP: keeps viewer provenance to one line', () => {
  let tree: any;
  act(() => { tree = create(<TranscriptReference viewer>{longOriginal}</TranscriptReference>); });
  const text = tree.root.findByType('Text');
  expect(text.props.numberOfLines).toBe(1);
  expect(text.props.children).toBe(longOriginal);
  act(() => tree.unmount());
});
