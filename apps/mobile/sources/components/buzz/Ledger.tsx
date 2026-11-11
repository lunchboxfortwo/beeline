import { StyleSheet } from 'react-native-unistyles';
import React, { useEffect, useRef, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { ContentTarget } from './IndexRow';
import Animated, { cancelAnimation, Easing, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { hasMessageRevealed, markMessageRevealed } from '@/buzz/message-reveal';
import { TranscriptLine, type TranscriptSender } from '@/ui/screens/transcript/TranscriptLine';
import { MonoMarkdown } from './MonoMarkdown';
import type { ChannelReferenceIndex, ChannelReferenceTarget } from '@/buzz/channel-reference';
import { provisionalProseStyle, settledAgentProseStyle } from './Ledger-styles';
import { LedgerSteer, LedgerRoomUpdate, LedgerHistoryLine, LedgerSystemLine, LedgerDayCaption, withLedgerDayCaption, LedgerGhostLine, LedgerUntaggedHint } from './Ledger-ledger-steer';



/**
 * The one transcript primitive a Room and a Corner both render. The same rule
 * holds for people and agents (build spec → "Transcript line"): a 28 px face in
 * a 44 px tap target, the name and the time open each sender group, and
 * follow-ups sit in the same column under it. The viewer's own messages are
 * brass body text; a mention of the viewer is highlighted.
 *
 * The layout lives in `ui/screens/transcript/TranscriptLine.tsx`; this file
 * keeps the list mechanics (rhythm on the upright cell, the reveal, the settle).
 */

/** The speaker's identity mark on the sender line. */
export type LedgerBylineMark = NonNullable<TranscriptSender['mark']>;

/** The author byline; continuations omit it. */
export type LedgerByline = TranscriptSender & {
  /** True only for the viewer's own turn. */
  isViewer?: boolean;
};


export type LedgerBodyProps = {
  itemId: string;
  bodyText: string | undefined;
  bodyTestID: string;
  /**
   * The message byline. Omitted only for a human continuation in the same run.
   */
  byline?: LedgerByline;
  /** True when this message continues the speaker run above it. */
  continued?: boolean;
  /**
   * The transcript lays rows out chronologically (desktop's ordinary flow)
   * rather than in the phone's inverted list, so a cell's layout-top — not its
   * layout-bottom — is its visual top. Speaker-change extra padding mirrors to
   * that visual-top edge.
   */
  chronological?: boolean;
  /**
   * The day caption already occupies the visual-top edge of this cell, so the
   * extra speaker-change padding would double the air.
   */
  precededByDayCaption?: boolean;
  marginalia?: React.ReactNode;
  replyReference?: React.ReactNode;
  /** An exact source jump for bodies whose whole quote is one control. */
  bodyAction?: {
    onPress(): void;
    accessibilityLabel: string;
    testID: string;
  };
  attachments?: React.ReactNode;
  /** The turn's tool run, collapsed — rendered under the prose it belongs to. */
  machineNoise?: React.ReactNode;
  /** A just-committed agent paragraph can reveal locally, even though the
   * relay publishes it atomically. */
  typewriter?: boolean;
  /**
   * The provisional text this durable reply is replacing (C98). Present only
   * when the reader was actually watching this turn stream, and spent once —
   * the settled words cross-fade up out of it instead of snapping over it.
   */
  settleFrom?: string;
  /** Handles backed by this message's real p-tags and current Room members. */
  mentionHandles?: readonly string[];
  /** The viewer's own handle: a mention of it is highlighted. */
  viewerHandle?: string;
  /** Invoked when a resolved member mention is pressed. */
  onMention?: (handle: string) => void;
  /** Known rooms/corners of THIS workspace; omitted → no `#` reference links. */
  channelIndex?: ChannelReferenceIndex;
  /** Invoked when a recognized `#room`/`#room/corner` reference is pressed. */
  onChannelReference?: (target: ChannelReferenceTarget, text: string) => void;
  /** Opens a long code block and restores this row when the reader closes. */
  codeRoomId?: string;
  onOpenCode?: (messageId: string) => void;
};


/**
 * The transcript's one paragraph and speaker rhythm. Activity rows share this
 * with durable prose so crossing the streaming boundary cannot add a second
 * margin system.
 */
export function ledgerEntryRhythm({
  hasByline,
  chronological = false,
  precededByDayCaption = false,
}: {
  hasByline: boolean;
  chronological?: boolean;
  precededByDayCaption?: boolean;
}): StyleProp<ViewStyle> {
  return [
    styles.entry,
    hasByline &&
      !precededByDayCaption &&
      (chronological ? styles.entryWithBylineChronological : styles.entryWithByline),
  ];
}


const TYPEWRITER_MS_PER_CHARACTER = 10;


function TypewriterMarkdown({
  markdown,
  textStyle,
  testID,
  revealId,
  mentionHandles,
  viewerHandle,
  onMention,
  channelIndex,
  onChannelReference,
  codeRoomId,
  onOpenCode,
}: {
  markdown: string;
  textStyle: React.ComponentProps<typeof MonoMarkdown>['textStyle'];
  testID: string;
  /** Stable id of the message this prose belongs to. The reveal plays at
   *  most once per id per app session — the SAME consume-once registry the
   *  entrance fade uses (`NewMessageMaterialize`) — so warm revalidation or a
   *  WS replay re-stamping `isNew` on room open cannot re-run it over
   *  already-seen text.
   */
  revealId?: string;
  mentionHandles?: readonly string[];
  viewerHandle?: string;
  onMention?: (handle: string) => void;
  channelIndex?: ChannelReferenceIndex;
  onChannelReference?: (target: ChannelReferenceTarget, text: string) => void;
  codeRoomId?: string;
  onOpenCode?: (messageId: string) => void;
}) {
  const reducedMotion = useReducedMotion();
  // Decided ONCE per mounted instance (same contract as `NewMessageMaterialize`):
  // a re-render while the reveal is running — presence tick, roster update —
  // must not flip the gate and cut the animation short. Cross-instance replay
  // (FlatList recycling the row, re-entering the Room) is closed by the shared
  // session reveal registry below.
  const animateRef = useRef<boolean | null>(null);
  if (animateRef.current === null) {
    animateRef.current =
      !reducedMotion && (revealId === undefined || !hasMessageRevealed(revealId));
  }
  const animate = animateRef.current;
  const opacity = useSharedValue(animate ? 0 : 1);
  const revealStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  // Mark after commit, not during render: a render React discards must not
  // spend the message's one reveal. Reduced motion shows everything at once,
  // but the reveal still counts — the message was seen.
  useEffect(() => {
    if (revealId !== undefined) markMessageRevealed(revealId);
  }, [revealId]);

  useEffect(() => {
    if (!animate) return;
    if (reducedMotion) {
      opacity.value = 1;
      return;
    }
    opacity.value = withTiming(1, {
      duration: Math.min(900, markdown.length * TYPEWRITER_MS_PER_CHARACTER),
      easing: Easing.out(Easing.cubic),
    });
    return () => cancelAnimation(opacity);
  }, [markdown, reducedMotion, animate, opacity]);

  return (
    <Animated.View style={revealStyle}>
      <MonoMarkdown
        markdown={markdown}
        mentionHandles={mentionHandles}
        viewerHandle={viewerHandle}
        onMention={onMention}
        channelIndex={channelIndex}
        onChannelReference={onChannelReference}
        codeSource={codeRoomId && revealId ? { roomId: codeRoomId, messageId: revealId } : undefined}
        onOpenCode={onOpenCode}
        testID={testID}
        textStyle={textStyle}
      />
    </Animated.View>
  );
}


/** One short transition. Long enough to read as a dissolve, short enough that
 *  nobody waits for the words they were already reading. */
const SETTLE_MS = 220;


/**
 * The settle (C98): provisional out, settled in, at the same place on the page.
 *
 * The two layers overlap — the settled words drive the layout and the
 * provisional ghost is hung over them, absolutely, so nothing reflows while
 * the fade runs. When the reply differs from what was streamed (a retracted
 * sentence, a rewritten opening) the dissolve is what carries the reader
 * across the difference; when it is identical the reader sees only the tone
 * and the face resolve.
 *
 * Reduced motion settles instantly: no ghost, no steps, the provisional style
 * simply gives way to the settled one.
 */
function SettleFade({ provisional, children }: { provisional: string; children: React.ReactNode }) {
  const reducedMotion = useReducedMotion();
  const [complete, setComplete] = useState(reducedMotion);
  const progress = useSharedValue(reducedMotion ? 1 : 0);
  const settledStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const ghostStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));
  useEffect(() => {
    if (reducedMotion) return;
    progress.value = withTiming(1, { duration: SETTLE_MS }, (finished) => {
      if (finished) runOnJS(setComplete)(true);
    });
    return () => cancelAnimation(progress);
  }, [reducedMotion, progress]);
  if (complete || reducedMotion) return <>{children}</>;
  return (
    <View testID="ledger-settle">
      <Animated.View style={settledStyle}>{children}</Animated.View>
      <Animated.View pointerEvents="none" style={[styles.settleGhost, ghostStyle]}>
        <MonoMarkdown
          markdown={provisional}
          testID="ledger-settle-ghost"
          textStyle={styles.ledgerProvisional}
        />
      </Animated.View>
    </View>
  );
}


/**
 * One turn on the transcript line: plain body text in ink for every speaker
 * (an agent's settled reply may type out once), under the sender line when it
 * opens a group.
 */
export function LedgerEntry({
  itemId,
  bodyText,
  bodyTestID,
  byline,
  continued = false,
  chronological = false,
  precededByDayCaption = false,
  luminous = false,
  replyReference,
  bodyAction,
  attachments,
  machineNoise,
  typewriter = false,
  settleFrom,
  mentionHandles,
  viewerHandle,
  onMention,
  channelIndex,
  onChannelReference,
  codeRoomId,
  onOpenCode,
}: Omit<LedgerBodyProps, 'marginalia'> & { luminous?: boolean }) {
  const text = bodyText ?? '';
  const bodyTextStyle = luminous ? styles.ledgerTextLuminous : styles.ledgerText;
  // A settling reply was already typed out, live, in front of the reader. It
  // cross-fades; it never re-types itself.
  const typeOut = typewriter && !settleFrom;
  const body = text ? (
    typeOut ? (
      <TypewriterMarkdown
        markdown={text}
        testID={bodyTestID}
        textStyle={bodyTextStyle}
        revealId={itemId}
        mentionHandles={mentionHandles}
        viewerHandle={viewerHandle}
        onMention={onMention}
        channelIndex={channelIndex}
        onChannelReference={onChannelReference}
        codeRoomId={codeRoomId}
        onOpenCode={onOpenCode}
      />
    ) : (
      <MonoMarkdown
        markdown={text}
        mentionHandles={mentionHandles}
        viewerHandle={viewerHandle}
        onMention={onMention}
        channelIndex={channelIndex}
        onChannelReference={onChannelReference}
        codeSource={codeRoomId ? { roomId: codeRoomId, messageId: itemId } : undefined}
        onOpenCode={onOpenCode}
        testID={bodyTestID}
        textStyle={bodyTextStyle}
      />
    )
  ) : null;
  return (
    <View
      style={ledgerEntryRhythm({
        hasByline: Boolean(byline),
        chronological,
        precededByDayCaption,
      })}
      testID={`chat-message-${itemId}`}
    >
      <TranscriptLine sender={byline}>
        {replyReference}
        {bodyAction && body ? (
          <ContentTarget
            accessibilityLabel={bodyAction.accessibilityLabel}
            accessibilityRole="button"
            onPress={bodyAction.onPress}
            testID={bodyAction.testID}
          >
            {settleFrom ? <SettleFade provisional={settleFrom}>{body}</SettleFade> : body}
          </ContentTarget>
        ) : settleFrom && body ? (
          <SettleFade provisional={settleFrom}>{body}</SettleFade>
        ) : (
          body
        )}
        {machineNoise}
        {attachments}
      </TranscriptLine>
    </View>
  );
}


export type SystemLineCutSearch = {
  key: string;
  mode: 'word' | 'char';
  candidates: number[];
  /** Highest candidate index known to fit, or -1. */
  lo: number;
  /** Lowest candidate index known not to fit. */
  hi: number;
};


export function startCutSearch(key: string, fullText: string, mode: 'word' | 'char'): SystemLineCutSearch {
  const candidates: number[] = [];
  for (let at = 1; at < fullText.length; at += 1) {
    if (mode === 'char' || (/\s/.test(fullText[at]!) && !/\s/.test(fullText[at - 1]!))) {
      candidates.push(at);
    }
  }
  if (!candidates.length && mode === 'word') return startCutSearch(key, fullText, 'char');
  return { key, mode, candidates, lo: -1, hi: candidates.length };
}


/** Drops trailing spaces and a dangling "·" so the ellipsis follows a word. */
export function closedCutLength(fullText: string, at: number): number {
  return fullText.slice(0, at).replace(/[\s·]+$/u, '').length;
}


export function webFitsTwoLines(element: HTMLElement): boolean | null {
  const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
  if (!Number.isFinite(lineHeight)) return null;
  return element.getBoundingClientRect().height <= lineHeight * 2 + 1;
}
export { LedgerSteer } from './Ledger-ledger-steer';
export { LedgerRoomUpdate } from './Ledger-ledger-steer';
export { LedgerHistoryLine } from './Ledger-ledger-steer';
export { LedgerSystemLine } from './Ledger-ledger-steer';
export { LedgerDayCaption } from './Ledger-ledger-steer';
export { withLedgerDayCaption } from './Ledger-ledger-steer';
export { LedgerGhostLine } from './Ledger-ledger-steer';
export { LedgerUntaggedHint } from './Ledger-ledger-steer';
export { provisionalProseStyle } from './Ledger-styles';
export { settledAgentProseStyle } from './Ledger-styles';





/** Right padding that keeps a pinned clock stamp clear of its line. */
const STAMP_GUTTER = 44;

export const styles = StyleSheet.create((theme) => ({
  /** A system line read inside an opened pill: no pinned stamp, no gutter. */
  systemLineBare: { paddingRight: 0, paddingVertical: 0, marginBottom: 0 },
  systemLineTextBare: { color: theme.buzz.ledgerBright },
  untaggedHint: {
    ...theme.buzz.type.meta,
    color: theme.buzz.ledgerQuiet,
    marginTop: theme.buzz.space.xs,
  },
  entry: {
    width: '100%',
    minWidth: 0,
    paddingTop: theme.buzz.messagePaddingVertical,
    paddingBottom: theme.buzz.messagePaddingVertical,
    marginBottom: theme.buzz.messageGap,
  },
  // Adjacent compact rows contribute 6px each for a 12px same-speaker gap.
  // A bylined row contributes the extra 12px on its visual-top edge, so the
  // preceding row's compact 6px makes the speaker-change boundary 24px
  // whether that preceding row is an agent (always bylined) or a person
  // continuation (no byline). Both lists are upright within a cell: the
  // chronological desktop list is upright, and the inverted phone list flips
  // the whole column and each cell back. A byline's air therefore belongs on
  // `paddingTop` in BOTH — putting it on `paddingBottom` dropped the 24px
  // speaker-change air on the message's visual BOTTOM instead, which is what
  // left a 30px tail under the newest turn and a 12px gap above the next one.
  entryWithByline: {
    paddingTop: theme.buzz.messagePaddingVertical * 3,
  },
  entryWithBylineChronological: {
    paddingTop: theme.buzz.messagePaddingVertical * 3,
  },
  /** Hung over the settled words, so the dissolve never moves the column. */
  settleGhost: { position: 'absolute', left: 0, right: 0, top: 0 },
  /**
   * A turn still being written (C98). Same face, size, leading and column as
   * the settled body — the ONLY difference is the quiet tone, so a settling
   * reply changes how the words read without moving them (one family means
   * no wrap point shifts at the settle).
   */
  ledgerProvisional: {
    fontFamily: theme.buzz.proseRegular,
    width: '100%',
    minWidth: 0,
    color: theme.buzz.ledgerQuiet,
    fontSize: theme.buzz.proseSize,
    lineHeight: theme.buzz.proseLineHeight,
  },
  ledgerTextLuminous: {
    fontFamily: theme.buzz.proseRegular,
    width: '100%',
    minWidth: 0,
    color: theme.buzz.ledgerBright,
    fontSize: theme.buzz.proseSize,
    lineHeight: theme.buzz.proseLineHeight,
  },
  ledgerText: {
    fontFamily: theme.buzz.proseRegular,
    width: '100%',
    minWidth: 0,
    color: theme.buzz.ledgerBright,
    fontSize: theme.buzz.proseSize,
    lineHeight: theme.buzz.proseLineHeight,
  },
  // Your own turn: brass body, regular weight, same size as everyone's.
  steerText: (pending: boolean) => ({
    fontFamily: theme.buzz.proseRegular,
    minWidth: 0,
    width: '100%',
    color: pending ? theme.buzz.textMuted : theme.buzz.accent,
    fontSize: theme.buzz.proseSize,
    lineHeight: theme.buzz.proseLineHeight,
  }),
  roomUpdate: {
    position: 'relative',
    width: '100%',
    minWidth: 0,
    paddingVertical: theme.buzz.space.xs,
    paddingRight: STAMP_GUTTER,
    marginBottom: theme.buzz.space.md,
  },
  roomUpdateLine: {
    ...theme.buzz.type.meta,
    fontFamily: theme.buzz.proseRegular,
    color: theme.buzz.ledgerQuiet,
  },
  roomUpdateLineBrass: { color: theme.buzz.accent },
  // No fixed width: a 36px box clips `17:06` (39px in 13px Plex Mono) to
  // `17:…`. The row's right padding already keeps the clock clear.
  roomUpdateStamp: {
    ...theme.buzz.type.machine,
    position: 'absolute',
    top: theme.buzz.space.xs,
    right: 0,
    color: theme.buzz.ledgerGhost,
    textAlign: 'right',
  },
  historyFailure: { paddingHorizontal: theme.buzz.roomList.edge },
  systemLine: {
    position: 'relative',
    width: '100%',
    minWidth: 0,
    paddingVertical: theme.buzz.space.xs,
    paddingRight: STAMP_GUTTER,
    marginBottom: theme.buzz.space.md,
  },
  systemLineText: {
    ...theme.buzz.type.meta,
    fontFamily: theme.buzz.proseRegular,
    color: theme.buzz.ledgerQuiet,
  },
  systemLineMeasurement: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    opacity: 0,
  },
  systemLineName: { fontFamily: theme.buzz.proseRegular, color: theme.buzz.accent },
  systemLineToggle: { fontFamily: theme.buzz.proseMedium, color: theme.buzz.accent },
  systemLineLink: {
    fontFamily: theme.buzz.proseRegular,
    color: theme.buzz.ledgerBody,
    textDecorationLine: 'underline',
  },
  roomUpdateDigest: {
    ...theme.buzz.type.meta,
    fontFamily: theme.buzz.proseRegular,
    marginTop: 4,
    marginLeft: theme.buzz.space.md,
    color: theme.buzz.ledgerBody,
  },
  // Tool readouts take the quiet left-rule mono treatment — clearly not
  // conversation.
  ghostBlock: {
    width: '100%',
    minWidth: 0,
  },
  ghostBody: {
    ...theme.buzz.type.machine,
    marginTop: 4,
    color: theme.buzz.ledgerGhost,
  },
}));
