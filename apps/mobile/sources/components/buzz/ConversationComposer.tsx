import { ErrorBanner } from '@/components/buzz/ErrorBanner';
import type { DictationTiming } from '@/buzz/dictation-timing';
import * as React from 'react';
import {
  type TextInput,
  Keyboard,
  Linking,
  Platform,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
  type TextInputKeyPressEventData,
  type TextInputSelectionChangeEventData,
  type TextLayoutEvent,
} from 'react-native';
import { YStack, useTheme } from 'tamagui';
import { useTextScale } from '@/ui/grammar';
import { NativeTypeInput, NativeTypeMeasure } from '@/ui/grammar-root';
import { groknight } from '@/buzz/groknight';
import { HullDialog } from './HullDialog';
import { COMPOSER_GLYPH_SIZE } from './MicGlyph';
import { VoiceAgentStrip, VoiceBar } from './VoiceBar';
import { RuntimeErrorBoundary } from './RuntimeErrorBoundary';
import type { VoiceCallState } from '@/buzz/use-voice-call';
import { BeelineMarkSpinner } from './BeelineMarkSpinner';
import { SurfaceGlyphLoader } from './SurfaceGlyphLoader';
import { useSpeechInput } from '@/buzz/speech-input';
import { composerBackspaceCursor, deleteComposerTagBackward, splitComposerTags } from '@/buzz/composer-tags';
import { ArrowUp, AudioLines, Mic, Plus, Square } from 'lucide-react-native';
import {
  ComposerAdjuncts,
  ComposerAttachment,
  ComposerButton,
  ComposerGlyph,
  ComposerControls,
  ComposerFrame,
  ComposerListening,
  ComposerMoreAttachments,
  ComposerNote,
  ComposerReply,
  ComposerStatus,
} from '@/ui/screens/composer/ComposerChrome';

/**
 * A dictated message on its way out. Stop sets `cancelled` until the parent sets
 * `committed`, the moment the message enters the Room.
 */
export type DictatedSend = { cancelled: boolean; committed: boolean; timing?: DictationTiming };

type Props = {
  voice?: VoiceCallState;
  value: string;
  /** Whether the server member roster contains an agent. */
  hasAgentMembers?: boolean;
  isDirectMessage?: boolean;
  height: number;
  maxHeight?: number;
  focused: boolean;
  disabled: boolean;
  attachDisabled?: boolean;
  canSend?: boolean;
  containerProps?: Record<string, unknown>;
  /**
   * react-native-web's View only forwards a fixed allowlist of DOM props
   * (clicks, pointers, keys, focus) to its underlying element, silently
   * dropping `onPaste` passed through `containerProps` — a real Ctrl+V never
   * reaches it. This is wired straight onto the container node instead.
   */
  onDesktopPaste?(event: ClipboardEvent): void;
  onAttach?(): void;
  onBlur(): void;
  onChangeText(value: string): void;
  onContentSizeChange(event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>): void;
  onFocus(): void;
  onKeyPress(event: NativeSyntheticEvent<TextInputKeyPressEventData>): void;
  onSelectionChange?(event: NativeSyntheticEvent<TextInputSelectionChangeEventData>): void;
  /** A dictated send passes its Stop handle; the call may return the send's promise. */
  onSend(dictated?: DictatedSend): unknown;
  /**
   * Speech recognition is available when the hook can use the browser or native
   * platform recogniser. Pass `false` to disable it (e.g. when the parent
   * environment already tested availability).
   */
  speechEnabled?: boolean;
  /** Names spoken in this conversation, so dictation spells them as written. */
  speechHints?: readonly string[];
  /**
   * Only supplied for a server-authorized, current working turn. The plain
   * tap-to-send composer takes no stop gesture of its own — the stop control
   * lives on `TurnProgressLine` — so this stays an accepted no-op kept for
   * the shared Room/corner call-site shape.
   */
  onStop?(): Promise<boolean>;
  inputRef?: React.Ref<TextInput>;
  /**
   * Changes when the parent consumes the current draft. The native input is
   * replaced so platform-owned text cannot survive a successful send, and
   * change callbacks identify the input generation that emitted them.
   */
  inputRevision?: number;
  isInputRevisionCurrent?(inputRevision: number): boolean;
  testIDPrefix?: string;
  /** One-line viewer pill: the same controls and speech state with centered type. */
  viewerPill?: boolean;
  reply?: {
    handle: string;
    preview: string;
  };
  onCancelReply?(): void;
  /**
   * Room member handles. One backspace right after an `@handle` for one of
   * them deletes the whole tag.
   */
  tagHandles?: ReadonlySet<string>;
  attachments?: readonly {
    uri: string;
    name: string;
    mimeType: string;
    sizeLabel: string;
    /** Background upload state; undefined before the upload starts reads as uploading. */
    uploadState?: 'uploading' | 'uploaded' | 'failed';
  }[];
  attachmentsUploading?: boolean;
  onRemoveAttachment?(index: number): void;
  onRetryAttachment?(index: number): void;
  /** The field's hint: "Message #chat" in a chat, "Reply in thread" in a corner. */
  placeholder?: string;
};

export const COMPOSER_SINGLE_LINE_INPUT_HEIGHT = 26;
export const COMPOSER_MAX_INPUT_HEIGHT = 5 * groknight.type.body.lineHeight;
const NO_TAG_HANDLES: ReadonlySet<string> = new Set();

export function ConversationComposer(props: Props) {
  return <RuntimeErrorBoundary scope="conversation" onError={() => props.voice?.end()}
    onRetry={() => props.voice?.join()}>
    <ConversationComposerContent {...props} />
  </RuntimeErrorBoundary>;
}

/** The one text-entry row used by both desktop Room and embedded Corner conversations. */
function ConversationComposerContent({
  voice,
  hasAgentMembers = false,
  isDirectMessage = false,
  value,
  height,
  maxHeight = 120,
  focused,
  disabled,
  attachDisabled = false,
  canSend,
  containerProps,
  onDesktopPaste,
  onAttach,
  onBlur,
  onChangeText,
  onContentSizeChange,
  onFocus,
  onKeyPress,
  onSelectionChange,
  onSend,
  speechEnabled = true,
  speechHints,
  inputRef,
  inputRevision = 0,
  isInputRevisionCurrent,
  testIDPrefix = 'chat',
  viewerPill = false,
  reply,
  onCancelReply,
  tagHandles = NO_TAG_HANDLES,
  attachments = [],
  attachmentsUploading = false,
  onRemoveAttachment,
  onRetryAttachment,
  placeholder,
}: Props) {
  const brass = useTheme().needsYou?.val as string;
  const textScale = useTextScale();
  const containerRef = React.useRef<HTMLElement | null>(null);
  const ownInputRef = React.useRef<TextInput | null>(null);
  const [textOffset, setTextOffset] = React.useState(0);
  const [nativeLineHeight, setNativeLineHeight] = React.useState(COMPOSER_SINGLE_LINE_INPUT_HEIGHT);
  // An empty field shows its hint. At a large Text size the hint can wrap, and
  // the field must grow to show every line (the content size counts only text).
  const placeholderText = placeholder ?? (!isDirectMessage && hasAgentMembers ? 'Tag an agent with @' : 'Message');
  const [placeholderHeight, setPlaceholderHeight] = React.useState(0);
  const emptyHeight = value ? 0 : Math.min(maxHeight, placeholderHeight);
  // A caller can keep an empty field at 26dp (the viewer does). A scaled
  // natural line must still fit before Android can center its baseline.
  const inputHeight = Platform.OS === 'android'
    ? Math.max(height, Math.ceil(nativeLineHeight), emptyHeight)
    : Math.max(height, emptyHeight);
  // A scaled single line is still one line. Bottom-align only a paragraph
  // taller than the measured line, so the viewer's spare space stays balanced.
  const multiline = Math.max(height, emptyHeight) > Math.max(COMPOSER_SINGLE_LINE_INPUT_HEIGHT, Math.ceil(nativeLineHeight));
  // iOS top-aligns its intrinsic text. Its 26dp minimum leaves extra space
  // only for a short single line; a grown paragraph has no such extra inset.
  const drawingOffset = textOffset + (Platform.OS === 'ios' && !multiline
    ? Math.max(0, COMPOSER_SINGLE_LINE_INPUT_HEIGHT - nativeLineHeight) / 2
    : 0);
  const measurePlaceholder = React.useCallback((event: TextLayoutEvent) => {
    const lines = event.nativeEvent.lines;
    setPlaceholderHeight(Math.ceil(lines.reduce((sum, line) => sum + line.height, 0)));
  }, []);
  const measureTextBody = React.useCallback((event: TextLayoutEvent) => {
    const line = event.nativeEvent.lines[0];
    if (!line) return;
    // Center the cap-to-baseline body, rather than the font's asymmetric
    // ascent/descent box. Text and TextInput use the same natural metrics.
    // Moving the drawing does not change contentSize or inline span layout.
    // iOS reports the used glyph rect as `height`; ascent + descent describe
    // its full line fragment, including paragraph leading.
    const lineHeight = Platform.OS === 'ios' ? line.ascender + line.descender : line.height;
    const offset = lineHeight / 2 - line.ascender + line.capHeight / 2;
    if (Number.isFinite(offset)) {
      setTextOffset(offset);
      setNativeLineHeight(lineHeight);
    }
  }, []);
  const setInputRef = React.useCallback(
    (node: TextInput | null) => {
      ownInputRef.current = node;
      if (typeof inputRef === 'function') inputRef(node);
      else if (inputRef) (inputRef as React.MutableRefObject<TextInput | null>).current = node;
    },
    [inputRef],
  );
  // Web growth loop (typing reached the wrap point, then "Maximum update depth
  // exceeded" and the composer's error boundary). With the changing height in
  // the Unistyles style array, each height change made the textarea render
  // without its stylesheet rule, in the browser's default font. Where Space
  // Grotesk wraps the text and the default font does not, RN-web's
  // content-size reading flipped between two lines and one (40px, 32px), and
  // every reading resized the composer again. RN-web also measures inside its
  // ref callback, which re-attaches on every render here, so nothing settled.
  // On web the height is therefore set on the element, outside Unistyles, and
  // the content size is read after commit, once that height is in place, and
  // reported only when it changes.
  React.useLayoutEffect(() => {
    if (Platform.OS !== 'web') return;
    const growingTextarea = ownInputRef.current as unknown as HTMLTextAreaElement | null;
    if (!growingTextarea?.style) return;
    growingTextarea.style.height = `${inputHeight}px`;
    growingTextarea.style.maxHeight = `${maxHeight}px`;
  });
  const reportedContentSize = React.useRef<{ height: number; width: number; revision: number } | null>(null);
  const contentSizeHandler = React.useRef(onContentSizeChange);
  contentSizeHandler.current = onContentSizeChange;
  React.useLayoutEffect(() => {
    if (Platform.OS !== 'web') return;
    const measuredTextarea = ownInputRef.current as unknown as HTMLTextAreaElement | null;
    if (!measuredTextarea || typeof measuredTextarea.scrollHeight !== 'number') return;
    const contentHeight = measuredTextarea.scrollHeight;
    const contentWidth = measuredTextarea.scrollWidth;
    const reported = reportedContentSize.current;
    // A replaced input (a new revision) reports once, as RN-web did on attach.
    if (reported && reported.revision === inputRevision && reported.height === contentHeight && reported.width === contentWidth) return;
    reportedContentSize.current = { height: contentHeight, width: contentWidth, revision: inputRevision };
    contentSizeHandler.current({
      nativeEvent: { contentSize: { height: contentHeight, width: contentWidth } },
    } as NativeSyntheticEvent<TextInputContentSizeChangeEventData>);
  });
  const commitInputChange = (nextValue: string) => {
    if (isInputRevisionCurrent?.(inputRevision) === false) return;
    onChangeText(nextValue);
  };

  // Tags are plain text. Send and dictation still read the leading ones:
  // tags alone are not a message.
  const tagSplit = splitComposerTags(value, tagHandles);
  // The selection the input last reported, for a backspace after a tag.
  const selectionRef = React.useRef({ start: 0, end: 0 });
  // Where the cursor goes once the input holds the text without a deleted tag.
  const pendingCursorRef = React.useRef<number | null>(null);
  /** Deletes the whole tag that ends at `cursor`, if one does. */
  const deleteTagBackward = (cursor: number) => {
    const next = deleteComposerTagBackward(value, cursor, tagHandles);
    if (!next) return false;
    if (isInputRevisionCurrent?.(inputRevision) !== false) {
      pendingCursorRef.current = next.cursor;
      selectionRef.current = { start: next.cursor, end: next.cursor };
    }
    commitInputChange(next.text);
    return true;
  };
  const commitNativeChange = (nextText: string) => {
    // Android keyboards often send no Backspace key event, so a one-character
    // deletion at the end of a tag is read from the text instead.
    const cursor = composerBackspaceCursor(value, nextText, selectionRef.current);
    if (cursor !== null && deleteTagBackward(cursor)) return;
    commitInputChange(nextText);
  };
  React.useLayoutEffect(() => {
    const cursor = pendingCursorRef.current;
    if (cursor === null) return;
    pendingCursorRef.current = null;
    const input = ownInputRef.current as unknown as {
      setSelection?(start: number, end: number): void;
      setSelectionRange?(start: number, end: number): void;
    } | null;
    if (Platform.OS === 'web') input?.setSelectionRange?.(cursor, cursor);
    else input?.setSelection?.(cursor, cursor);
  }, [value]);

  React.useLayoutEffect(() => {
    if (Platform.OS !== 'web') return;
    const input = ownInputRef.current as unknown as HTMLTextAreaElement | null;
    if (!input || typeof input.getBoundingClientRect !== 'function') return;
    let active = true;
    const measure = () => {
      if (!active || typeof CanvasRenderingContext2D === 'undefined') return;
      const css = getComputedStyle(input);
      const context = document.createElement('canvas').getContext('2d');
      if (!context) return;
      context.font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
      const metrics = context.measureText('M');
      const lineHeight = parseFloat(css.lineHeight);
      const inputHeight = Math.min(input.clientHeight, COMPOSER_SINGLE_LINE_INPUT_HEIGHT);
      const offset = (inputHeight - lineHeight) / 2 +
        (metrics.actualBoundingBoxAscent - metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) / 2;
      if (Number.isFinite(offset)) setTextOffset(offset);
    };
    measure();
    // Re-measure after the actual face arrives, and after responsive resizing.
    void document.fonts?.ready.then(measure);
    document.fonts?.addEventListener('loadingdone', measure);
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(input);
    return () => {
      active = false;
      document.fonts?.removeEventListener('loadingdone', measure);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [height, inputRevision, textScale]);

  // Speech recognition — internal hook, scoped to the composer.
  // What the current take added to the text, so Stop can take exactly that out.
  const takeTextRef = React.useRef<string[]>([]);
  const speech = useSpeechInput((transcript) => {
    const separator = value && transcript && !/\s$/.test(value) ? ' ' : '';
    takeTextRef.current.push(separator + transcript);
    commitInputChange(value + separator + transcript);
  }, speechHints);
  const isListening = speech.state === 'listening';
  const isFinalizing = speech.state === 'finalizing';
  const isCapturingSpeech = isListening || isFinalizing;
  // A dictated message stays cancellable while it is sent, until it enters the Room.
  const [sendingTake, setSendingTake] = React.useState<DictatedSend | null>(null);
  // The parent replaces the input once it has taken the message into the Room.
  React.useEffect(() => setSendingTake(null), [inputRevision]);
  const dictationBusy = isCapturingSpeech || sendingTake !== null;
  const speechAvailable = speech.capability === 'available' && speechEnabled !== false;
  // Tags alone are not a message: the field reads as empty and keeps the mic.
  const hasSomethingToSend = canSend ?? Boolean(tagSplit.rest.trim());
  const sendingSpeech = isFinalizing || sendingTake !== null;
  // Fixed places: ＋ on the left; the voice spot holds the mic, or Stop while
  // a take is live; the far right is the go action — Conversation while there
  // is nothing to send, Send otherwise. While dictating, Send posts the take.
  // Without Conversation the far right is always Send, disabled when empty,
  // so it still never moves — including while an agent is working, when a
  // tap queues the next instruction.
  const showConversation = Boolean(voice) && (voice?.connecting || (!hasSomethingToSend && !dictationBusy));
  const sendDisabled = disabled || sendingSpeech || (!hasSomethingToSend && !isListening);
  const dailyLimitError = voice?.error?.startsWith('Calls resume at ') ? voice.error : null;
  const conversationActive = Boolean(!voice?.connecting && (voice?.call || (voice?.error && !dailyLimitError)));
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !showConversation || conversationActive) return;
    containerRef.current?.querySelector(`[data-testid="${testIDPrefix}-conversation"]`)
      ?.setAttribute('title', 'Conversation mode');
  }, [showConversation, conversationActive, testIDPrefix]);

  // Dictation shows a waveform, never live words. Only a failure that needs
  // the person to act has a line under the composer.
  const statusLine: string =
    speech.state === 'permission-denied'
      ? Platform.OS === 'web'
        ? 'allow microphone in browser site settings \u00b7 tap mic to try again'
        : 'microphone off in settings \u00b7 tap to open settings'
      : speech.state === 'nothing-recognised'
        ? "didn't catch that \u00b7 tap mic to try again"
        : '';

  React.useEffect(() => {
    if (!onDesktopPaste) return;
    const node = containerRef.current;
    if (!node) return;
    const listener = (event: Event) => onDesktopPaste(event as ClipboardEvent);
    node.addEventListener('paste', listener);
    return () => node.removeEventListener('paste', listener);
  }, [onDesktopPaste]);
  const discardTake = () => {
    if (sendingTake?.committed) return;
    if (sendingTake) sendingTake.cancelled = true;
    if (isCapturingSpeech) speech.cancel();
    setSendingTake(null);
    const added = takeTextRef.current;
    takeTextRef.current = [];
    if (added.length === 0) return;
    // Tags, typed text and the reply stay; only the take's words go.
    commitInputChange(
      added.reduceRight((text, part) => {
        const at = text.lastIndexOf(part);
        return at < 0 ? text : text.slice(0, at) + text.slice(at + part.length);
      }, value),
    );
  };
  // Send while dictating: stop, wait for the final words, then send them with
  // any typed text and staged files.
  const sendTake = () => {
    const timing = speech.dictationTiming?.();
    timing?.mark('send_tapped');
    const hadTypedText = Boolean(tagSplit.rest.trim());
    // Held from the press, so the field stays a waveform from the
    // transcription through the send.
    const send: DictatedSend = { cancelled: false, committed: false, timing };
    const settle = () =>
      setSendingTake((current) => (current === send ? null : current));
    setSendingTake(send);
    void speech.stop().then((captured) => {
      if (send.cancelled || captured === null || !(hadTypedText || captured)) {
        settle();
        return;
      }
      void Promise.resolve(onSend(send)).finally(settle);
    });
  };
  const visibleAttachments = attachments.slice(0, 3);
  const hiddenAttachmentCount = Math.max(0, attachments.length - visibleAttachments.length);
  const permissionDeniedNative = speech.state === 'permission-denied' && Platform.OS !== 'web';
  return (
    <>
    {(conversationActive || voice?.connecting) && voice && <VoiceAgentStrip voice={voice} />}
    <YStack ref={containerRef as never} {...containerProps}>
      {(reply || attachments.length > 0) && (
        <ComposerAdjuncts testID={`${testIDPrefix}-composer-adjuncts`}>
          {reply && <ComposerReply handle={reply.handle} preview={reply.preview} onCancel={onCancelReply} />}
          {visibleAttachments.map((attachment, index) => (
            <ComposerAttachment
              key={`${attachment.uri}:${index}`}
              index={index}
              name={attachment.name}
              sizeLabel={attachment.sizeLabel}
              mimeType={attachment.mimeType}
              uploadState={attachment.uploadState}
              busy={attachmentsUploading}
              onRetry={() => onRetryAttachment?.(index)}
              onRemove={() => onRemoveAttachment?.(index)}
            />
          ))}
          {hiddenAttachmentCount > 0 && <ComposerMoreAttachments count={hiddenAttachmentCount} />}
        </ComposerAdjuncts>
      )}
      <ComposerFrame focused={focused} pill={viewerPill}>
      {conversationActive && voice ? (
        <VoiceBar voice={voice} testIDPrefix={testIDPrefix} />
      ) : (
        <ComposerControls multiline={multiline} testID={`${testIDPrefix}-composer-input-row`}>
        {/* Room attachments remain available while dictating. */}
        {!viewerPill && (
          <ComposerButton
            label="Attach photo or document"
            disabled={attachDisabled || !onAttach}
            onPress={onAttach}
            testID={`${testIDPrefix}-attach-button`}
          >
            <ComposerGlyph icon={Plus} />
          </ComposerButton>
        )}
        <YStack flex={1} position="relative" minWidth={0} justifyContent="center" minHeight={44} paddingVertical="1" paddingLeft={viewerPill ? '2' : undefined}>
          {Platform.OS !== 'web' ? (
            <NativeTypeMeasure
              line={Platform.OS === 'android' ? 'unset' : 'type'}
              centered={Platform.OS === 'android'}
              accessible={false}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              pointerEvents="none"
              numberOfLines={1}
              onTextLayout={measureTextBody}
              testID={`${testIDPrefix}-text-measurement`}
            >
              Message
            </NativeTypeMeasure>
          ) : null}
          {Platform.OS !== 'web' && !value ? (
            <NativeTypeMeasure
              line={Platform.OS === 'android' ? 'unset' : 'type'}
              centered={Platform.OS === 'android'}
              fill
              accessible={false}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              pointerEvents="none"
              onTextLayout={measurePlaceholder}
              testID={`${testIDPrefix}-placeholder-measurement`}
            >
              {placeholderText}
            </NativeTypeMeasure>
          ) : null}
          <NativeTypeInput
            key={inputRevision}
            ref={setInputRef}
            // A successful send replaces this native input to fence off stale
            // text events. If the consumed input was focused, transfer focus
            // to its empty replacement so consecutive messages need no tap.
            autoFocus={focused}
            // Not the body line height on web: kept below Space Grotesk's real
            // glyph bounds so centering never crops accents or descenders
            // (`chat.composer-layout.test.ts`). Android unsets it: an inline tag
            // starts the text span mid-line and Android's partial relayout then
            // drops the tag's line from the measured height on alternate keystrokes.
            line={Platform.OS === 'ios' ? 'type' : Platform.OS === 'android' ? 'unset' : 20}
            centered={Platform.OS === 'android'}
            // Web sets the changing height on the element (growth loop note above).
            box={Platform.OS === 'ios' || Platform.OS === 'web'
              ? { minHeight: COMPOSER_SINGLE_LINE_INPUT_HEIGHT, maxHeight: COMPOSER_MAX_INPUT_HEIGHT }
              : { minHeight: COMPOSER_SINGLE_LINE_INPUT_HEIGHT, height: inputHeight, maxHeight }}
            translateY={drawingOffset}
            // The input stays mounted under the listening line; its typed text
            // returns when dictation ends.
            hidden={dictationBusy}
            value={value}
            onChangeText={Platform.OS === 'web' ? commitInputChange : commitNativeChange}
            // Web reads its content size after commit (growth loop note above).
            onContentSizeChange={Platform.OS === 'web' ? undefined : onContentSizeChange}
            onFocus={onFocus}
            onBlur={onBlur}
            onKeyPress={(event) => {
              // The web gets every Backspace as a key event, before the
              // browser deletes anything; a word or line delete keeps its own.
              const key = event.nativeEvent as TextInputKeyPressEventData & {
                altKey?: boolean;
                ctrlKey?: boolean;
                metaKey?: boolean;
              };
              if (
                Platform.OS === 'web' &&
                key.key === 'Backspace' &&
                !key.altKey &&
                !key.ctrlKey &&
                !key.metaKey
              ) {
                const node = (event as unknown as { target?: HTMLTextAreaElement }).target;
                const selection =
                  typeof node?.selectionStart === 'number'
                    ? { start: node.selectionStart, end: node.selectionEnd }
                    : selectionRef.current;
                if (selection.start === selection.end && deleteTagBackward(selection.start)) {
                  event.preventDefault();
                  return;
                }
              }
              onKeyPress(event);
            }}
            onSelectionChange={(event) => {
              selectionRef.current = event.nativeEvent.selection;
              onSelectionChange?.(event);
            }}
            placeholder={placeholderText}
            multiline
            // Android keyboards otherwise take the whole screen in landscape and
            // type into the OS extract editor instead of this composer. The prop
            // sets IME_FLAG_NO_FULLSCREEN; it is a no-op on the other platforms.
            disableFullscreenUI
            returnKeyType="default"
            scrollEnabled={height >= maxHeight}
            submitBehavior="newline"
            testID={`${testIDPrefix}-input`}
            accessibilityLabel="Message"
          />
          {dictationBusy ? (
            <ComposerListening
              tags={tagSplit.tags.length > 0 ? tagSplit.prefix.trimEnd() : undefined}
              level={speech.volumeLevel}
              live={isListening}
              testID={`${testIDPrefix}-speech-waveform`}
              tagsTestID={`${testIDPrefix}-dictation-tags`}
            />
          ) : null}
        </YStack>
        {speechAvailable && dictationBusy ? (
          // Keyed apart from the mic, so a press in flight on one never lands on the other.
          <ComposerButton
            key="stop"
            label="Stop recording"
            hint="Discards this take; typed text stays"
            disabled={sendingTake?.committed}
            onPress={discardTake}
            testID={`${testIDPrefix}-speech-discard`}
          >
            <ComposerGlyph icon={Square} />
          </ComposerButton>
        ) : speechAvailable ? (
          <ComposerButton
            key="mic"
            label={permissionDeniedNative ? 'Open microphone settings' : 'Start speech input'}
            hint="Dictates into the message field"
            dimmed={speech.state === 'permission-denied'}
            onHold={voice && !disabled ? () => {
              Keyboard.dismiss();
              void voice.join();
            } : undefined}
            onPress={() => {
              if (permissionDeniedNative) {
                void Linking.openSettings();
                return;
              }
              takeTextRef.current = [];
              // A take needs no keyboard; lowering it shows the whole Room.
              Keyboard.dismiss();
              speech.start();
            }}
            testID={`${testIDPrefix}-mic`}
          >
            <ComposerGlyph icon={Mic} />
          </ComposerButton>
        ) : null}
        {showConversation ? (
          <ComposerButton
            label={voice?.connecting ? 'Connecting conversation mode' : 'Conversation mode'}
            disabled={disabled || voice?.connecting}
            busy={voice?.connecting}
            onPress={() => {
              Keyboard.dismiss();
              void voice?.join();
            }}
            testID={`${testIDPrefix}-conversation`}
          >
            {voice?.connecting ? <SurfaceGlyphLoader compact size={COMPOSER_GLYPH_SIZE} testID="voice-startup-loader" />
              : <ComposerGlyph icon={AudioLines} />}
          </ComposerButton>
        ) : (
          <ComposerButton
            primary
            label={sendingSpeech ? 'Finishing speech input' : 'Send message'}
            hint={
              sendingSpeech
                ? 'Waits for the final transcription before sending'
                : isListening
                  ? 'Stops dictation and sends'
                  : undefined
            }
            disabled={sendDisabled}
            busy={sendingSpeech}
            // Never pass the responder event itself: the Room's handleSend
            // reads its first argument as a MessageShortcut, and a PressEvent
            // (truthy, no `.text`) made it skip the composer-clear block so
            // the field kept its text after every send.
            onPress={() => (isListening ? sendTake() : onSend?.())}
            testID={`${testIDPrefix}-send`}
          >
            {sendingSpeech ? (
              <BeelineMarkSpinner ink={brass} live testID={`${testIDPrefix}-speech-finalizing`} />
            ) : (
              <ComposerGlyph icon={ArrowUp} primary />
            )}
          </ComposerButton>
        )}
        </ComposerControls>
      )}
      {dailyLimitError && <ComposerNote>
        <ErrorBanner inline title={dailyLimitError} titleTestID="voice-connection-error" />
      </ComposerNote>}
      {statusLine ? (
        <ComposerStatus
          text={statusLine}
          onPress={permissionDeniedNative ? () => void Linking.openSettings() : undefined}
          testID={`${testIDPrefix}-speech-status`}
        />
      ) : null}
      </ComposerFrame>
      <HullDialog
        visible={speech.modelDownloadOffered}
        title="Download the voice model?"
        body="Android punctuates dictation with its on-device voice model, which is not on this phone yet. Android may ask to confirm the download."
        onRequestClose={() => void speech.declineModelDownload()}
        actions={[
          {
            label: 'Not now',
            onPress: () => void speech.declineModelDownload(),
            testID: `${testIDPrefix}-speech-model-decline`,
          },
          {
            label: 'Download',
            variant: 'primary',
            onPress: speech.acceptModelDownload,
            testID: `${testIDPrefix}-speech-model-download`,
          },
        ]}
        testID={`${testIDPrefix}-speech-model-dialog`}
      />
    </YStack>
    </>
  );
}
