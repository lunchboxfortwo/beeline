import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@beeline/api-contract/phone', () => ({ VOICE_LONG_PRESS_MS: 450 }));
import { ComposerAttachment, ComposerButton, ComposerFrame, ComposerListening } from './ComposerChrome';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let tree: any;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { if (tree) act(() => tree.unmount()); tree = undefined; vi.useRealTimers(); });
const button = () => tree.root.find((node: any) => node.type === 'Button');

it('a tap on the mic dictates; holding it past the voice long press opens conversation mode instead', () => {
  const onPress = vi.fn();
  const onHold = vi.fn();
  act(() => { tree = create(<ComposerButton label="Start speech input" onPress={onPress} onHold={onHold} testID="chat-mic">x</ComposerButton>); });
  act(() => { button().props.onPressIn(); vi.advanceTimersByTime(200); button().props.onPressOut(); button().props.onPress(); });
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(onHold).not.toHaveBeenCalled();
  act(() => { button().props.onPressIn(); vi.advanceTimersByTime(450); button().props.onPressOut(); button().props.onPress(); });
  expect(onHold).toHaveBeenCalledTimes(1);
  expect(onPress).toHaveBeenCalledTimes(1);
});

it('the card takes the brass border only while the field has focus', () => {
  const frame = (focused: boolean) => {
    act(() => { tree = create(<ComposerFrame focused={focused}>x</ComposerFrame>); });
    const card = tree.root.find((node: any) => node.type === 'Card');
    const color = card.props.borderColor;
    act(() => tree.unmount());
    tree = undefined;
    return color;
  };
  expect(frame(true)).toBe('needsYou');
  expect(frame(false)).toBe('stroke');
});

it('a failed upload says so and offers Retry beside Remove', () => {
  const onRetry = vi.fn();
  act(() => {
    tree = create(<ComposerAttachment index={0} uri="file:///review.pdf" name="review.pdf" sizeLabel="12 KB" mimeType="application/pdf"
      uploadState="failed" busy={false} onRetry={onRetry} onRemove={() => undefined} />);
  });
  expect(tree.root.findAll((node: any) => node.props['aria-label'] === 'review.pdf, upload failed').length).toBeGreaterThan(0);
  tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'pending-chat-attachment-retry-0').props.onPress();
  expect(onRetry).toHaveBeenCalled();
});

it('draws the speaking waveform while dictation listens', () => {
    let tree: any;
    act(() => { tree = create(<ComposerListening level={0.6} live testID="chat-speech-waveform" tagsTestID="tags" />); });
    const line = tree.root.findAll((node: any) => node.props?.testID === 'chat-speech-waveform-level' && typeof node.type === 'string');
    expect(line).toHaveLength(1);
    expect(line[0].findAll((node: any) => node.type === 'YStack' && node.props.backgroundColor === 'needsYou')).toHaveLength(64);
    act(() => tree.unmount());
});

it('keeps uploading thumbnails at 48px, dimmed, with a named remove control', () => {
  const remove = vi.fn();
  act(() => { tree = create(<ComposerAttachment index={0} uri="file:///photo.jpg" name="photo.jpg" sizeLabel="1 KB" mimeType="image/jpeg" uploadState="uploading" busy={false} onRetry={() => undefined} onRemove={remove} />); });
  const tile = tree.root.find((node: any) => node.type === 'YStack' && node.props.testID === 'pending-chat-attachment-0');
  expect(tile.props.height).toBe(48);
  expect(tile.props.width).toBe(48);
  const preview = tree.root.find((node: any) => node.type === 'YStack' && node.props['aria-label'] === 'photo.jpg, uploading');
  expect(preview.props.opacity).toBe(0.4);
  expect(preview.props.borderRadius).toBe('house');
  const close = tree.root.find((node: any) => node.type === 'XStack' && node.props.testID === 'pending-chat-attachment-remove-0');
  expect(close.props.accessibilityLabel).toBe('Remove photo.jpg');
  close.props.onPress();
  expect(remove).toHaveBeenCalledOnce();
});
