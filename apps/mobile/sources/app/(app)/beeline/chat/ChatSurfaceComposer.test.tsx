import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/sync/transport', () => ({}));
vi.mock('@/buzz/chat-attachment', () => ({ formatAttachmentSize: () => '' }));
vi.mock('@/buzz/agent-display', () => ({ resolveAgentDisplayIdentity: () => ({ name: '' }) }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('tamagui', () => ({ XStack: 'XStack', YStack: 'YStack' }));
vi.mock('@/ui/grammar', () => ({ T: 'T', Motion: 'Motion' }));
vi.mock('./chat-surface-values', () => ({ COMPOSER_MIN_HEIGHT: 26, COMPOSER_MAX_HEIGHT: 120 }));
vi.mock('@/components/buzz/TurnProgressLine', () => ({ TurnBandSlot: () => null, TurnSettledLine: () => null, TurnProgressLine: () => null }));
vi.mock('@/components/buzz/MentionSuggestionMenu', () => ({ ChannelSuggestionMenu: () => null, MentionSuggestionMenu: () => null }));
vi.mock('@/components/buzz/RepoPicker', () => ({ RepoPicker: () => null }));
vi.mock('@/components/buzz/SlashVerbPicker', () => ({ SlashVerbPicker: () => null }));
vi.mock('@/components/buzz/IndexRow', () => ({ IndexRow: () => null }));
vi.mock('@/components/buzz/ErrorBanner', () => ({ ErrorBanner: () => null }));
vi.mock('@/components/buzz/Button', () => ({ Button: () => null }));
const measurement = vi.hoisted(() => ({ reads: 0 }));
vi.mock('@/components/buzz/ConversationComposer', () => ({
  ConversationComposer: (props: any) => {
    // RN-web TextInput measures in its imperative ref, whose identity depends
    // on onContentSizeChange. Model alternating layout reads during reattach.
    React.useLayoutEffect(() => {
      measurement.reads++;
      props.onContentSizeChange({ nativeEvent: { contentSize: { height: measurement.reads % 2 ? 40 : 60 } } });
    }, [props.onContentSizeChange]);
    return React.createElement('Composer', props);
  },
}));
import { ChatSurfaceComposer } from './ChatSurfaceComposer';

type Props = React.ComponentProps<typeof ChatSurfaceComposer>;
let renderer: ReactTestRenderer | undefined;
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; });

it('COMPOSER-SIZE-1: settles ref measurements, grows and shrinks, then sends the current draft', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  measurement.reads = 0;
  const sent: string[] = [];
  function Room() {
    const [height, setHeight] = React.useState(26);
    const [text, setText] = React.useState('hello');
    const inputTextRef = React.useRef(text);
    const props = {
      desktopExperience: false, pendingAttachments: [], composerTagHandles: new Set(),
      voice: {}, roomSurface: { members: [] }, composerInputRevisionRef: { current: 0 },
      composerHeight: height, setComposerHeight: setHeight, inputText: text,
      inputTextRef, setInputText: setText,
      handleSend: async () => { sent.push(text); setText(''); setHeight(26); return true; },
    } as unknown as Props;
    return <ChatSurfaceComposer {...props} />;
  }
  act(() => { renderer = create(<Room />); });
  const composer = () => renderer!.root.findByType('Composer');
  expect(measurement.reads).toBe(1);
  expect(composer().props.height).toBe(40);
  for (const [measured, expected] of [[80.2, 81], [300, 120], [20, 26], [52, 52], [52, 52]]) {
    act(() => composer().props.onContentSizeChange({ nativeEvent: { contentSize: { height: measured } } }));
    expect(composer().props.height).toBe(expected);
  }
  act(() => composer().props.onChangeText('one\ntwo\nthree'));
  act(() => { void composer().props.onSend(); });
  expect(sent).toEqual(['one\ntwo\nthree']);
  expect(composer().props.value).toBe('');
  expect(composer().props.height).toBe(26);
  expect(measurement.reads).toBe(1);
});
