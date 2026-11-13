import { appErrorCopy } from '@/buzz/app-error-copy';
import React from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AttachmentReference } from '@beeline/buzz-client';
import type { RoomViewMessage } from '@beeline/api-contract/phone';
import { currentViewerConversation, subscribeViewerConversation, viewerAgentHandle, viewerContext, viewerContextLabel } from '@/buzz/viewer-conversation';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { COMPOSER_SINGLE_LINE_INPUT_HEIGHT, ConversationComposer, type DictatedSend } from '@/components/buzz/ConversationComposer';
import { TalkDock } from '@/ui/screens/viewers/TalkDock';

type Entry = { id: string; speaker: string; text: string; context?: string };

/** Small conversation controls that float above a full-height viewer. */
export function ViewerConversationDock({
  kind, title, roomId, agentHandle, artifact, captureScreen, keyboardAvoidedByParent = false,
}: {
  kind: 'artifact' | 'computer';
  title: string;
  roomId?: string;
  agentHandle?: string;
  artifact?: AttachmentReference;
  captureScreen?: () => Promise<string | null>;
  /** HullModal already moves its content above the keyboard; warm viewers do not. */
  keyboardAvoidedByParent?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const conversation = React.useSyncExternalStore(
    subscribeViewerConversation,
    () => currentViewerConversation(roomId),
    () => currentViewerConversation(roomId),
  );
  const initialIds = React.useRef(new Set(conversation?.messages.map((message) => message.id) ?? []));
  const initialTranscriptSeen = React.useRef(Boolean(conversation));
  const receivedIds = React.useRef(new Set<string>());
  const sentToAgent = React.useRef(false);
  const [entries, setEntries] = React.useState<Entry[]>([]);
  const [draft, setDraft] = React.useState('');
  const draftRef = React.useRef('');
  const [height, setHeight] = React.useState(COMPOSER_SINGLE_LINE_INPUT_HEIGHT);
  const [revision, setRevision] = React.useState(0);
  const [focused, setFocused] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  // The closed pill is one control tall; the transcript rises above it.
  const [pillHeight, setPillHeight] = React.useState(44);
  const [tickerVisible, setTickerVisible] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const keyboardHeight = useKeyboardState((state) => state.height);
  const keyboardLift = Platform.OS !== 'web' && focused && open ? keyboardHeight : 0;
  const bottom = keyboardLift > 0
    ? (keyboardAvoidedByParent ? 12 : keyboardLift + 12)
    : insets.bottom + (kind === 'computer' ? 12 + 42 + 12 : 12);
  const transcriptMaxHeight = Math.max(0, Math.min(
    windowHeight * 0.4, windowHeight - insets.top - (keyboardAvoidedByParent ? keyboardLift : 0) - bottom - pillHeight - 9 - 12,
  ));
  const context = viewerContext(kind, title);
  const currentAgent = viewerAgentHandle(kind, agentHandle, conversation?.messages ?? []);

  React.useEffect(() => {
    if (conversation && !initialTranscriptSeen.current) {
      initialTranscriptSeen.current = true;
      initialIds.current = new Set(conversation.messages.map((message) => message.id));
      return;
    }
    const arrivals = (conversation?.messages ?? []).filter((message: RoomViewMessage) =>
      message.author.kind === 'agent' && message.presentation === 'message' &&
      !initialIds.current.has(message.id) && !receivedIds.current.has(message.id));
    if (!arrivals.length) return;
    for (const message of arrivals) receivedIds.current.add(message.id);
    if (!sentToAgent.current) return;
    const replies = arrivals.filter((message) => !currentAgent ||
      message.author.handle?.replace(/^@/, '') === currentAgent);
    if (!replies.length) return;
    setEntries((current) => [...current, ...replies.map((message) => ({
      id: message.id,
      speaker: message.author.handle ?? message.author.name,
      text: message.text,
    }))].slice(-8));
  }, [conversation?.messages, currentAgent]);

  React.useEffect(() => {
    if (!entries.length) return;
    if (entries.at(-1)?.speaker === 'You') { setTickerVisible(false); return; }
    setTickerVisible(true);
    const timeout = setTimeout(() => setTickerVisible(false), 5500);
    return () => clearTimeout(timeout);
  }, [entries]);

  const send = async (dictated?: DictatedSend) => {
    const text = draftRef.current.trim();
    if (!text || !conversation || sending) return false;
    setSending(true);
    setError(null);
    const previouslySent = sentToAgent.current;
    try {
      const screenshotBase64 = kind === 'computer' ? await captureScreen?.() : undefined;
      if (kind === 'computer' && !screenshotBase64) throw new Error('The browser screen is not ready to capture. Try again.');
      // A fast reply can arrive before the send RPC returns.
      sentToAgent.current = true;
      const succeeded = await conversation.send({
        text, context, agentHandle: currentAgent,
        ...(artifact ? { artifact } : {}),
        ...(screenshotBase64 ? { screenshotBase64 } : {}),
      }, dictated);
      if (!succeeded) { sentToAgent.current = previouslySent; return false; }
      setEntries((current) => [...current, {
        id: `local:${Date.now()}`, speaker: 'You', text, context,
      }].slice(-8));
      setDraft('');
      draftRef.current = '';
      setHeight(COMPOSER_SINGLE_LINE_INPUT_HEIGHT);
      setRevision((current) => current + 1);
      return true;
    } catch (caught) {
      sentToAgent.current = previouslySent;
      setError(appErrorCopy(caught, 'Could not send this message.'));
      return false;
    } finally {
      setSending(false);
    }
  };
  const agentReplies = entries.filter((entry) => entry.speaker !== 'You');
  const showTranscript = Boolean(error || (open && entries.length) || (tickerVisible && agentReplies.length));
  const recent = open ? entries.slice(-3) : agentReplies.slice(-2);
  return (
    <TalkDock
      compact={kind === 'computer'}
      onPillHeightChange={setPillHeight}
      open={open}
      onToggle={() => {
        if (open) setTickerVisible(false);
        setOpen(!open);
      }}
      bottom={bottom}
      maxTranscriptHeight={transcriptMaxHeight}
      heading={`Recent conversation · ${currentAgent ?? 'agent'}`}
      entries={recent.map((entry) => ({
        id: entry.id, speaker: entry.speaker, text: entry.text, mine: entry.speaker === 'You',
        ...(entry.context ? { context: viewerContextLabel(entry.context) } : {}),
      }))}
      showTranscript={showTranscript}
      error={error}
      contextLabel={viewerContextLabel(context)}
      composer={
        <ConversationComposer
          viewerPill value={draft} height={height} focused={focused} disabled={sending || !conversation}
          inputRevision={revision} testIDPrefix="viewer" speechEnabled
          onBlur={() => setFocused(false)} onFocus={() => setFocused(true)}
          onChangeText={(text) => { draftRef.current = text; setDraft(text); }}
          onContentSizeChange={(event) => setHeight(draft.trim()
            ? Math.max(COMPOSER_SINGLE_LINE_INPUT_HEIGHT,
                Math.min(120, Math.ceil(event.nativeEvent.contentSize.height)))
            : COMPOSER_SINGLE_LINE_INPUT_HEIGHT)}
          onKeyPress={(event) => { if (Platform.OS === 'web' && event.nativeEvent.key === 'Enter' &&
            !(event.nativeEvent as unknown as { shiftKey?: boolean }).shiftKey) {
            event.preventDefault(); void send();
          } }}
          onSend={send}
        />
      }
    />
  );
}
