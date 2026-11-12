import { LedgerDisclosure, LedgerLogGroup } from './LedgerDisclosure';
import { webhookCallerMessage } from '@/buzz/system-lines';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { ScrollView, XStack, YStack } from 'tamagui';
import { T, TypedView } from '@/ui/grammar';
import { MonoMarkdown } from './MonoMarkdown';
import { ContentTarget } from './IndexRow';
import type { SystemEvent, SystemSubject } from '@beeline/api-contract/phone';
import { LedgerBodyProps, LedgerEntryFrame, SystemLineCutSearch, webFitsTwoLines, startCutSearch, closedCutLength } from './Ledger';
import { TranscriptLine } from '@/ui/screens/transcript/TranscriptLine';
import { DayCaption, HistoryLine } from '@/ui/screens/transcript/TranscriptMarkers';



/**
 * You, steering: the same transcript line as everyone, with your name in brass
 * and the body in ink.
 * A run of your own messages keeps flowing under one sender line.
 */
export function LedgerSteer({
  itemId,
  bodyText,
  pending = false,
  bodyTestID,
  byline,
  chronological = false,
  precededByDayCaption = false,
  replyReference,
  bodyAction,
  attachments,
  mentionHandles,
  viewerHandle,
  onMention,
  channelIndex,
  onChannelReference,
  codeRoomId,
  onOpenCode,
}: Omit<LedgerBodyProps, 'marginalia' | 'machineNoise' | 'typewriter' | 'settleFrom'> & { pending?: boolean }) {
  return (
    <LedgerEntryFrame
      hasByline={Boolean(byline)}
      chronological={chronological}
      precededByDayCaption={precededByDayCaption}
      testID={`chat-message-${itemId}`}
    >
      <TranscriptLine sender={byline}>
      {replyReference}
      {bodyText ? (
        bodyAction ? (
          <ContentTarget
            accessibilityLabel={bodyAction.accessibilityLabel}
            accessibilityRole="button"
            onPress={bodyAction.onPress}
            testID={bodyAction.testID}
          >
            <TypedView
              view={MonoMarkdown}
              v="body"
              color={pending ? 'secondary' : 'ink'}
              markdown={bodyText}
              mentionHandles={mentionHandles}
              viewerHandle={viewerHandle}
              onMention={onMention}
              channelIndex={channelIndex}
              onChannelReference={onChannelReference}
              codeSource={codeRoomId ? { roomId: codeRoomId, messageId: itemId } : undefined}
              onOpenCode={onOpenCode}
              testID={bodyTestID}
            />
          </ContentTarget>
        ) : (
          <TypedView
            view={MonoMarkdown}
            v="body"
            color={pending ? 'secondary' : 'ink'}
            markdown={bodyText}
            mentionHandles={mentionHandles}
            viewerHandle={viewerHandle}
            onMention={onMention}
            channelIndex={channelIndex}
            onChannelReference={onChannelReference}
            codeSource={codeRoomId ? { roomId: codeRoomId, messageId: itemId } : undefined}
            onOpenCode={onOpenCode}
            testID={bodyTestID}
          />
        )
      ) : null}
      {attachments}
      </TranscriptLine>
    </LedgerEntryFrame>
  );
}


/**
 * One derived Room-state notice. It is metadata, not a speaker turn: no
 * avatar, byline, rule, fill, or card. The optional landed-work digest is the
 * sole content-tier line and reuses relay copy rather than generating prose.
 */
export function LedgerRoomUpdate({
  id,
  line,
  stamp,
  digest,
  tone = 'quiet',
}: {
  id: string;
  line: string;
  stamp: string;
  digest?: string;
  tone?: 'quiet' | 'brass';
}) {
  return (
    // The row keeps its stamp pinned right, clear of the line beside it.
    <XStack width="100%" minWidth={0} gap="2" alignItems="flex-start" paddingVertical="1" marginBottom="4" testID={`room-update-${id}`}>
      <YStack flex={1} minWidth={0}>
        <T
          v="meta"
          color={tone === 'brass' ? 'needsYou' : 'secondary'}
          numberOfLines={1}
          testID={`room-update-line-${id}`}
        >
          {line}
        </T>
        {digest ? (
          <T v="meta" color="secondary" numberOfLines={2} marginTop="1" marginLeft="4" testID={`room-update-digest-${id}`}>
            {digest}
          </T>
        ) : null}
      </YStack>
      {/* No fixed width: a 36px box clips `17:06` to `17:…`. */}
      <T v="code" color="secondary" textAlign="right" flexShrink={0} numberOfLines={1} testID={`room-update-stamp-${id}`}>
        {stamp}
      </T>
    </XStack>
  );
}


/** Paging state belongs inside the transcript as one quiet line, never a card. */
export function LedgerHistoryLine({ text }: { text: string }) {
  return <HistoryLine text={text} />;
}


/**
 * The one renderer for a server-phrased system line (`buzz/system-lines.ts`):
 * `<subject> <verb>[ <object>][ · <consequence>]` in the quiet `meta` role,
 * no avatar, the stamp pinned right. Names are brass and tappable; an object
 * with a URL is a link. Every message remains a separate row. A row
 * from before the grammar has no event and shows its text verbatim.
 */
export function LedgerSystemLine({
  id,
  text,
  event,
  stamp,
  onOpenIdentity,
  onOpenUrl,
  onOpenBrief,
  bare = false,
}: {
  id: string;
  text: string;
  event?: SystemEvent;
  stamp: string;
  /** Read inside an opened pill, whose header already carries the time. */
  bare?: boolean;
  onOpenIdentity?: (identityId: string) => void;
  onOpenUrl?: (url: string) => void;
  /** Opens the corner's latest brief; a revision notice links to it. */
  onOpenBrief?: () => void;
}) {
  const callerMessage = webhookCallerMessage(event);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const [search, setSearch] = useState<SystemLineCutSearch | null>(null);
  const [cut, setCut] = useState<{ key: string; at: number } | null>(null);
  const measurementRef = useRef<unknown>(null);
  const probeRef = useRef<unknown>(null);
  const fullText = event
    ? `${event.subject.name} ${event.verb}${event.object?.text ? ` ${event.object.text}` : ''}${event.consequence ? ` · ${event.consequence}` : ''}`
    : text;
  const measureWebOverflow = () => {
    const element = measurementRef.current as unknown as HTMLElement | null;
    if (element) setOverflows(webFitsTwoLines(element) === false);
  };
  useEffect(() => {
    setExpanded(false);
    if (Platform.OS === 'web') measureWebOverflow();
  }, [id, fullText]);
  // The closed line ends in "… more" on its second line. Text clamping cannot
  // append after its ellipsis, so a hidden probe finds the longest cut that
  // still fits: word ends first, single characters for one unbroken word.
  const cutKey = `${fullText}\n${width}`;
  const cutAt = cut?.key === cutKey ? cut.at : null;
  useEffect(() => {
    if (!overflows || width === null || cutAt !== null || search?.key === cutKey) return;
    const started = startCutSearch(cutKey, fullText, 'word');
    if (started.candidates.length) setSearch(started);
    else setCut({ key: cutKey, at: fullText.length });
  }, [overflows, width, cutAt, search?.key, cutKey, fullText]);
  const probing =
    search?.key === cutKey && cutAt === null && search.hi - search.lo > 1 ? search : null;
  const probeIndex = probing ? (probing.lo + probing.hi) >> 1 : null;
  const probeCandidate =
    probing && probeIndex !== null ? probing.candidates[probeIndex] : null;
  const settleProbe = (fits: boolean) => {
    if (!probing || probeIndex === null) return;
    const lo = fits ? probeIndex : probing.lo;
    const hi = fits ? probing.hi : probeIndex;
    if (hi - lo > 1) setSearch({ ...probing, lo, hi });
    else if (lo >= 0) setCut({ key: cutKey, at: probing.candidates[lo] });
    else if (probing.mode === 'word') setSearch(startCutSearch(cutKey, fullText, 'char'));
    else setCut({ key: cutKey, at: probing.candidates[0] ?? 1 });
  };
  useLayoutEffect(() => {
    if (Platform.OS !== 'web' || probeCandidate === null) return;
    const element = probeRef.current as unknown as HTMLElement | null;
    const fits = element ? webFitsTwoLines(element) : null;
    if (fits !== null) settleProbe(fits);
  }, [probeCandidate, cutKey]);
  const name = (subject: SystemSubject, index: number) => (piece: string) => (
    <T
      v="meta"
      color="needsYou"
      key={`${subject.id ?? subject.name}-${index}`}
      onPress={
        subject.id && onOpenIdentity
          ? (event) => {
              event.stopPropagation();
              onOpenIdentity(subject.id!);
            }
          : undefined
      }
      testID={`system-line-name-${id}-${index}`}
    >
      {piece}
    </T>
  );
  // Each segment renders any prefix of its text, so the closed cut keeps names and links.
  const segments: { text: string; render?: (piece: string) => React.ReactNode }[] = [];
  if (event) {
    segments.push(
      { text: event.subject.name, render: name(event.subject, 0) },
      { text: ` ${event.verb}` },
    );
    const object = event.object;
    if (object?.text) {
      segments.push({ text: ' ' });
      // The brief keeps no history on the phone: any revision notice opens
      // the latest brief.
      const briefRevision =
        event.verb === 'revised the corner brief' && /^Revision [1-9]\d*$/.test(object.text);
      if (briefRevision && onOpenBrief) {
        segments.push({
          text: object.text,
          render: (piece) => (
            <T
              v="meta"
              color="secondary"
              textDecorationLine="underline"
              key="object"
              accessibilityRole="link"
              onPress={(event) => {
                event.stopPropagation();
                onOpenBrief();
              }}
              testID={`system-line-object-${id}`}
            >
              {piece}
            </T>
          ),
        });
      } else if (object.id) {
        segments.push({
          text: object.text,
          render: (piece) => (
            <T
              v="meta"
              color="needsYou"
              key="object"
              onPress={
                onOpenIdentity
                  ? (event) => {
                      event.stopPropagation();
                      onOpenIdentity(object.id!);
                    }
                  : undefined
              }
              testID={`system-line-object-${id}`}
            >
              {piece}
            </T>
          ),
        });
      } else if (object.url) {
        segments.push({
          text: object.text,
          render: (piece) => (
            <T
              v="meta"
              color="secondary"
              textDecorationLine="underline"
              key="object"
              onPress={
                onOpenUrl
                  ? (event) => {
                      event.stopPropagation();
                      onOpenUrl(object.url!);
                    }
                  : undefined
              }
              testID={`system-line-object-${id}`}
            >
              {piece}
            </T>
          ),
        });
      } else {
        segments.push({ text: object.text });
      }
    }
    if (event.consequence) segments.push({ text: ` · ${event.consequence}` });
  } else {
    segments.push({ text });
  }
  const renderSegments = (length = fullText.length) => {
    const nodes: React.ReactNode[] = [];
    let left = length;
    for (const segment of segments) {
      if (left <= 0) break;
      const piece = segment.text.slice(0, left);
      left -= piece.length;
      nodes.push(segment.render ? segment.render(piece) : piece);
    }
    return nodes;
  };
  // A non-breaking space binds the word to the text, so it never sits alone on a new line.
  const toggleWord = (word: 'more' | 'less') => (
    <T v="metaStrong" color="needsYou" key="toggle" testID={`system-line-toggle-word-${id}`}>
      {` ${word}`}
    </T>
  );
  const closedLength = cutAt === null ? null : closedCutLength(fullText, cutAt);
  const body = (
    <T
      v="meta"
      color={bare ? 'ink' : 'secondary'}
      numberOfLines={expanded ? undefined : 2}
      ellipsizeMode="tail"
      testID={`system-line-text-${id}`}
    >
      {overflows && expanded
        ? [...renderSegments(fullText.trimEnd().length), toggleWord('less')]
        : overflows && closedLength !== null
          ? [...renderSegments(closedLength), '…', toggleWord('more')]
          : event
            ? renderSegments()
            : text}
    </T>
  );
  const hiddenText = {
    accessible: false,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
    'aria-hidden': true,
  } as const;
  return (
    <XStack
      width="100%"
      minWidth={0}
      gap="2"
      alignItems="flex-start"
      paddingVertical={bare ? 0 : '1'}
      marginBottom={bare ? 0 : '4'}
      testID={`system-line-${id}`}
    >
      <YStack flex={1} minWidth={0}>
        {/* Measure unclamped copy: native reports lines, web reports its laid-out height.
            Android ignores pointerEvents on Text, so the view keeps the copy from taking
            taps where it overflows onto the row below. */}
        <YStack
          pointerEvents="none"
          position="absolute"
          top={0}
          left={0}
          right={0}
          opacity={0}
          onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
        >
          <T
            v="meta"
            color="secondary"
            ref={measurementRef as never}
            testID={`system-line-measurement-${id}`}
            {...hiddenText}
            onTextLayout={
              Platform.OS === 'web'
                ? undefined
                : ({ nativeEvent }) => {
                    setOverflows(nativeEvent.lines.length > 2);
                  }
            }
            onLayout={Platform.OS === 'web' ? measureWebOverflow : undefined}
          >
            {fullText}
          </T>
        </YStack>
        {probeCandidate !== null ? (
          <YStack pointerEvents="none" position="absolute" top={0} left={0} right={0} opacity={0}>
            <T
              v="meta"
              color="secondary"
              key={`${probing!.mode}-${probeCandidate}`}
              ref={probeRef as never}
              testID={`system-line-probe-${id}`}
              {...hiddenText}
              onTextLayout={
                Platform.OS === 'web'
                  ? undefined
                  : ({ nativeEvent }) => settleProbe(nativeEvent.lines.length <= 2)
              }
            >
              {fullText.slice(0, closedCutLength(fullText, probeCandidate))}…{toggleWord('more')}
            </T>
          </YStack>
        ) : null}
        {overflows ? (
          <LedgerDisclosure
            textToggle
            expanded={expanded}
            accessibilityState={{ expanded }}
            accessibilityLabel={
              expanded ? 'Show less of system message' : 'Show full system message'
            }
            onPress={() => setExpanded((value) => !value)}
            rowTestID={`system-line-toggle-${id}`}
          >
            {body}
          </LedgerDisclosure>
        ) : (
          body
        )}
        {callerMessage !== undefined ? (
          <>
            <T v="meta" color="secondary" testID={`system-line-caller-label-${id}`}>
              Caller's message:
            </T>
            <T
              v="meta"
              color="secondary"
              userSelect="text"
              dataDetectorType="none"
              testID={`system-line-caller-message-${id}`}
            >
              {`“${callerMessage}”`}
            </T>
          </>
        ) : null}
      </YStack>
      {bare ? null : (
        <T v="code" color="secondary" textAlign="right" flexShrink={0} numberOfLines={1} testID={`system-line-stamp-${id}`}>
          {stamp}
        </T>
      )}
    </XStack>
  );
}


/**
 * The transcript's day caption (grammar meta, secondary, sentence case). In-flow
 * on the day-opener cell — never a separate list row, never sticky.
 */
export function LedgerDayCaption({ label }: { label: string }) {
  return <DayCaption label={label} />;
}


export function withLedgerDayCaption(node: React.ReactNode, label: string | null): React.ReactNode {
  if (!label) return node;
  const caption = <LedgerDayCaption label={label} />;
  return (
    <YStack>
      {caption}
      {node}
    </YStack>
  );
}


/**
 * A wall of tool output, folded into one ghost line.
 *
 * The dimmest tier, one line over a quiet left rule, with its own disclosure —
 * a `git push` rejection dump, a stack trace, an npm error wall never prints
 * down the slab. The label says what happened and the body stays behind a tap
 * (`DESIGN.md`, "Machine noise").
 */
export function LedgerGhostLine({
  label,
  body,
  testID,
}: {
  label: string;
  body: string;
  testID?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    // Tool readouts take the quiet mono treatment — clearly not conversation.
    <LedgerLogGroup width="100%" minWidth={0} testID={testID}>
      <LedgerDisclosure
        expanded={expanded}
        accessibilityLabel={label}
        accessibilityState={{ expanded }}
        rowTestID={testID ? `${testID}-toggle` : undefined}
        onPress={() => setExpanded((open) => !open)}
      >{label}</LedgerDisclosure>
      {expanded ? (
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
          <T v="code" color="secondary" userSelect="text" marginTop="1" testID={testID ? `${testID}-body` : undefined}>
            {body}
          </T>
        </ScrollView>
      ) : null}
    </LedgerLogGroup>
  );
}


/** Private teaching feedback beneath a locally sent message. */
export function LedgerUntaggedHint({ messageId }: { messageId: string }) {
  return (
    <T v="meta" color="secondary" marginTop="1" testID={`untagged-message-hint-${messageId}`}>
      No agent was tagged
    </T>
  );
}
