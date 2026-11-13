import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, Keyboard: { dismiss: () => {} }, Linking: {} }));
vi.mock('tamagui', () => ({ YStack: 'YStack', useTheme: () => ({}) }));
vi.mock('@/ui/grammar', () => ({ useTextSize: () => 'large' }));
vi.mock('@/ui/grammar-root', () => ({ NativeTypeInput: 'NativeTypeInput', NativeTypeMeasure: 'NativeTypeMeasure' }));
vi.mock('@/buzz/groknight', () => ({ groknight: { type: { body: { lineHeight: 22 } } } }));
vi.mock('@/components/buzz/ErrorBanner', () => ({ ErrorBanner: () => null }));
vi.mock('./HullDialog', () => ({ HullDialog: () => null }));
vi.mock('./MicGlyph', () => ({ COMPOSER_GLYPH_SIZE: 20 }));
vi.mock('./VoiceBar', () => ({ VoiceAgentStrip: () => null, VoiceBar: () => null }));
vi.mock('./RuntimeErrorBoundary', () => ({ RuntimeErrorBoundary: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./BeelineMarkSpinner', () => ({ BeelineMarkSpinner: () => null }));
vi.mock('./SurfaceGlyphLoader', () => ({ SurfaceGlyphLoader: () => null }));
vi.mock('@/buzz/speech-input', () => ({ useSpeechInput: () => ({ state: 'idle', capability: 'unavailable' }) }));
vi.mock('lucide-react-native', () => ({ ArrowUp: 'ArrowUp', AudioLines: 'AudioLines', Mic: 'Mic', Plus: 'Plus', Square: 'Square' }));
vi.mock('@/ui/screens/composer/ComposerChrome', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    ComposerAdjuncts: Pass, ComposerAttachment: () => null, ComposerButton: () => null, ComposerGlyph: () => null,
    ComposerControls: Pass, ComposerFrame: Pass, ComposerListening: () => null, ComposerMoreAttachments: () => null,
    ComposerNote: () => null, ComposerReply: () => null, ComposerStatus: () => null,
  };
});

import { ConversationComposer } from './ConversationComposer';

const line = (height: number) => ({ height, ascender: 20, descender: 6, capHeight: 15, width: 200, x: 0, y: 0, text: '' });

it('COMPOSER-HINT-1: an empty field grows to show every line of a wrapped hint, then returns to its text height', () => {
  const props = {
    value: '', height: 26, maxHeight: 132, focused: false, disabled: false, canSend: false, placeholder: 'Message #design-proof',
    onChangeText: () => {}, onContentSizeChange: () => {}, onFocus: () => {}, onBlur: () => {}, onKeyPress: () => {}, onSend: () => {},
  };
  let tree: any;
  act(() => { tree = create(<ConversationComposer {...props} />); });
  const input = () => tree.root.findByType('NativeTypeInput' as any);
  const hint = tree.root.findByProps({ testID: 'chat-placeholder-measurement' });
  expect(hint.props.children).toBe('Message #design-proof');
  // At Large the hint wraps onto two 31dp lines.
  act(() => hint.props.onTextLayout({ nativeEvent: { lines: [line(31), line(31)] } }));
  expect(input().props.box.height).toBe(62);
  // Typed text owns the height again once the hint is gone.
  act(() => tree.update(<ConversationComposer {...props} value="hi" height={31} />));
  expect(input().props.box.height).toBe(31);
  expect(tree.root.findAllByProps({ testID: 'chat-placeholder-measurement' })).toHaveLength(0);
});
