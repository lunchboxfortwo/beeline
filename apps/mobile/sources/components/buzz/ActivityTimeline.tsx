import { appReadErrorCopy } from '@/buzz/app-error-copy';
import { displayRoomMessage } from '@/buzz/room-view-presentation';
import { readRoomViewMessage, type PhoneOperationMap } from '@beeline/api-contract/phone';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, XStack, YStack } from 'tamagui';
import { Spinner, T, TypedView } from '@/ui/grammar';
import type { AgentActivityItem } from '@/sync/transport/rig-transport';
import { buildTurnActivity } from '@/buzz/activity-timeline';
import type { ToolIdentityLookup } from '@/buzz/tool-identity-lookup';
import {
  foldConsecutiveReadLines,
  groupToolLedgerRuns,
  toolLedgerLines,
  toolRunSummaryParts,
  type ToolLedgerLine,
  type ToolLedgerRun,
} from '@/buzz/tool-ledger';
import { ToolOutputSheet } from './ToolOutputSheet';
import { TranscriptLine } from '@/ui/screens/transcript/TranscriptLine';
import { type LedgerBylineMark } from './Ledger';
import { MonoMarkdown } from './MonoMarkdown';
import { StreamingProse } from './StreamingProse';
import { LedgerDisclosure, LedgerLogGroup } from './LedgerDisclosure';
import { TranscriptNavigationRow } from './IndexRow';

/** Bounded flat-list viewport height (~5 single-item rows) when a turn has >5 rows. */
const FLAT_LEDGER_SCROLL_MAX_HEIGHT = 240;

type ActivityTimelineProps = {
  active?: boolean;
  items: readonly AgentActivityItem[];
  handle?: string;
  stamp?: string;
  /** Desktop transcripts flow chronologically; phone transcripts are inverted. */
  chronological?: boolean;
  testID?: string;
  messageDraft?: string;
  messageDraftKey?: string;
  /** Loaded room roster and channel/thread index for resolving raw IDs to human names. */
  lookup?: ToolIdentityLookup;
  /** The streaming speaker's identity mark — the SAME mark the settled row's
   *  sender line renders (`TranscriptLine`), so the draft lane carries the
   *  agent tile and the byline never moves when the draft settles. */
  mark?: LedgerBylineMark;
};

const OUTCOME_WORDS = {
  running: 'running',
  success: 'succeeded',
  failure: 'failed',
} as const;

function originCopy(origin: ToolLedgerLine['origin']): string | undefined {
  if (!origin || origin.kind !== 'subagent') return undefined;
  return origin.label ? `subagent · ${origin.label}` : 'subagent';
}

function lineAccessibilityLabel(line: ToolLedgerLine): string {
  if (line.kind === 'note') {
    return line.startupWarning ? `Startup note: ${line.label}` : `Note: ${line.label}`;
  }
  const parts: string[] = [];
  const origin = originCopy(line.origin);
  if (origin) parts.push(origin);
  parts.push(line.label);
  if (line.kind !== 'thought') parts.push(OUTCOME_WORDS[line.outcome]);
  if (line.signal) parts.push(`signalled ${line.signal}`);
  if (line.stat?.kind === 'diff') parts.push(`+${line.stat.added} -${line.stat.removed}`);
  else if (line.stat?.kind === 'exit') parts.push(line.stat.text);
  else if (line.stat?.kind === 'text') parts.push(line.stat.text);
  if (line.reason) parts.push(line.reason);
  return parts.join(', ');
}

/** Fixed leading verb column width so Space Grotesk row verbs align cleanly. */
const VERB_COLUMN_MIN_WIDTH = 68;

/**
 * Shared 3-part transcript step row: fixed-width verb column, 2-line wrapped
 * subject (tail ellipsis), quiet right stat column, optional subagent origin
 * line, and `>` chevron ONLY when opening reveals an additional stored fact.
 */
function ToolLedgerLineRow({
  line,
  divider = false,
  onPress,
  testID,
}: {
  line: ToolLedgerLine;
  divider?: boolean;
  onPress?: () => void;
  testID?: string;
}) {
  const showVerdict = line.kind === 'tool';
  const accessibilityLabel = lineAccessibilityLabel(line);
  if (line.kind === 'note' && line.startupWarning) {
    return (
      <TranscriptNavigationRow
        divider={divider}
        dividerWidth={1}
        quietChevron
        testID={testID}
        singleDestination={Boolean(onPress)}
        trailing={
          onPress
            ? {
                onPress,
                accessibilityLabel,
                accessibilityRole: 'button',
                accessibilityHint: 'Opens this startup note',
              }
            : undefined
        }
      >
        <XStack alignItems="flex-start" gap="2" minWidth={0}>
          <T v="meta" color="secondary" minWidth={VERB_COLUMN_MIN_WIDTH} flexShrink={0} numberOfLines={1}>
            Startup note
          </T>
          <T v="meta" color="secondary" flex={1} minWidth={0} numberOfLines={2}>
            {line.label}
          </T>
        </XStack>
      </TranscriptNavigationRow>
    );
  }
  if (line.kind === 'note') {
    // Interim agent prose sits inline in the flat list without a trailing chevron.
    return (
      <TranscriptNavigationRow divider={divider} dividerWidth={1} quietChevron testID={testID}>
        <YStack width="100%" minWidth={0}>
          <TypedView view={MonoMarkdown} v="meta" markdown={line.label} />
        </YStack>
      </TranscriptNavigationRow>
    );
  }
  const action = line.verb ?? (line.glyph === '>_' ? 'ran' : line.glyph === '≡' ? 'read' : 'used');
  const hasNamedAction = line.label.startsWith(`${action} `);
  const verb =
    line.outcome === 'failure'
      ? 'Failed'
      : line.outcome === 'running'
        ? 'Running'
        : action.charAt(0).toUpperCase() + action.slice(1);
  const redundantFailureLabel = line.outcome === 'failure' && /^action\s+failed$/i.test(line.label);
  const isHumanTargetRow =
    (action === 'sent' || action === 'replied') && /(?:^|\s)[@#][A-Za-z0-9._-]+/.test(line.label);
  const labelSegments = isHumanTargetRow ? line.label.split(/((?:^|\s)[@#][A-Za-z0-9._-]+)/g) : null;
  const originText = originCopy(line.origin);
  const quietReceipt = !onPress && line.outcome === 'success';
  const showVerbColumn = !hasNamedAction || line.outcome === 'failure';

  return (
    <TranscriptNavigationRow
      testID={testID}
      singleDestination={Boolean(onPress)}
      divider={divider}
      dividerWidth={1}
      quietChevron
      trailing={
        onPress
          ? {
              onPress,
              accessibilityLabel,
              accessibilityRole: 'button',
              accessibilityState: { busy: line.outcome === 'running' },
              accessibilityHint: 'Opens this call’s output',
            }
          : undefined
      }
    >
      <YStack gap="0.5" width="100%" minWidth={0}>
        {originText ? (
          <T
            v="code"
            color="secondary"
            numberOfLines={1}
            testID={`activity-origin-${line.id}`}
          >
            {originText}
          </T>
        ) : null}
        <XStack alignItems="flex-start" gap="2" width="100%" minWidth={0}>
          {showVerbColumn ? (
            <T
              v={line.outcome === 'failure' ? 'metaStrong' : 'meta'}
              color={line.outcome === 'failure' ? 'ink' : 'secondary'}
              minWidth={VERB_COLUMN_MIN_WIDTH}
              flexShrink={0}
              numberOfLines={1}
            >
              {verb}
            </T>
          ) : null}
          <YStack flex={1} minWidth={48} gap="0.5">
            {!redundantFailureLabel ? (
              labelSegments && labelSegments.length > 1 ? (
                <T
                  v="meta"
                  color={quietReceipt ? 'secondary' : 'ink'}
                  ellipsizeMode="tail"
                  numberOfLines={2}
                >
                  {labelSegments.map((part, index) => {
                    const match = part.match(/^(\s*)([@#][A-Za-z0-9._-]+)$/);
                    if (!match) return <React.Fragment key={index}>{part}</React.Fragment>;
                    return (
                      <React.Fragment key={index}>
                        {match[1]}
                        <T v="metaStrong" color="ink">
                          {match[2]}
                        </T>
                      </React.Fragment>
                    );
                  })}
                </T>
              ) : (
                <T
                  v={line.subjectMono ? 'code' : 'meta'}
                  color={quietReceipt ? 'secondary' : 'ink'}
                  ellipsizeMode="tail"
                  numberOfLines={2}
                >
                  {line.label}
                </T>
              )
            ) : null}
            {line.outcome === 'failure' && line.reason ? (
              <T v="meta" color="secondary" width="100%" minWidth={0} testID={`activity-reason-${line.id}`}>
                {line.reason}
              </T>
            ) : null}
          </YStack>
          {line.stat ? (
            line.stat.kind === 'signal' || line.stat.kind === 'exit' ? (
              <T v="code" color="ink" flexShrink={0} fontVariant={['tabular-nums']} numberOfLines={1}>
                {line.stat.text}
              </T>
            ) : line.stat.kind === 'diff' ? (
              <XStack alignItems="center" gap="1" flexShrink={0}>
                {line.stat.added > 0 ? (
                  <T v="code" color="ink" fontVariant={['tabular-nums']} numberOfLines={1}>
                    {`+${line.stat.added}`}
                  </T>
                ) : null}
                {line.stat.removed > 0 ? (
                  <T v="code" color="secondary" fontVariant={['tabular-nums']} numberOfLines={1}>
                    {`-${line.stat.removed}`}
                  </T>
                ) : null}
              </XStack>
            ) : (
              <T v="code" color="secondary" flexShrink={0} fontVariant={['tabular-nums']} numberOfLines={1}>
                {line.stat.text}
              </T>
            )
          ) : null}
          {showVerdict && line.outcome === 'running' ? (
            <Spinner color="secondary" testID={`activity-verdict-${line.id}`} />
          ) : null}
        </XStack>
      </YStack>
    </TranscriptNavigationRow>
  );
}

function toolPageLines(
  page: PhoneOperationMap['readRoomTools']['output'],
  lookup?: ToolIdentityLookup,
): ToolLedgerLine[] {
  if (!Array.isArray(page.messages) || page.messages.length > 50)
    throw new Error('Tool output did not match the expected format.');
  const messages = page.messages.map(readRoomViewMessage);
  if (messages.some((message) => !message))
    throw new Error('Tool output did not match the expected format.');
  return toolLedgerLines(
    buildTurnActivity(
      messages.flatMap((message) => displayRoomMessage(message!, '').activity ?? []),
      { settled: true, lookup },
    ).steps,
    false,
    lookup,
  );
}

function useToolOutput(lookup?: ToolIdentityLookup) {
  const [line, setLine] = useState<ToolLedgerLine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = React.useRef(0);
  useEffect(
    () => () => {
      current.current++;
    },
    [],
  );
  const open = (next: ToolLedgerLine) => {
    const generation = ++current.current;
    setError(null);
    if (!next.toolOutput) {
      setLine(next);
      return;
    }
    setLine({ ...next, detail: 'Loading…', rawOutput: 'Loading…' });
    const targetRef = {
      roomId: next.toolOutput.roomId,
      anchor: next.toolOutput.anchor,
      messageId: next.toolOutput.messageId,
    };
    const request = monolithPhoneOperation('readRoomTools', targetRef);
    void request
      .then((page) => {
        if (generation !== current.current) return;
        const fetched = toolPageLines(page, lookup);
        const itemIndex = next.toolOutput?.itemIndex;
        const full =
          (itemIndex !== undefined
            ? fetched.find((item) => item.id === `${next.toolOutput!.messageId}:${itemIndex}`) ??
              fetched[itemIndex]
            : undefined) ?? fetched.find((item) => item.id === next.id);
        if (!full) {
          const missing = 'This step’s saved detail is no longer available.';
          setLine({ ...next, detail: undefined, rawOutput: undefined, blocks: undefined });
          setError(missing);
          return;
        }
        setLine({
          ...next,
          label: full.label ?? next.label,
          sheetTitle: full.sheetTitle ?? next.sheetTitle,
          verb: full.verb ?? next.verb,
          subjectMono: full.subjectMono ?? next.subjectMono,
          stat: full.stat ?? next.stat,
          searchScope: full.searchScope ?? next.searchScope,
          summary: full.summary ?? next.summary,
          exitCode: full.exitCode ?? next.exitCode,
          signal: full.signal ?? next.signal,
          outputTruncated: full.outputTruncated ?? next.outputTruncated,
          omittedCount: full.omittedCount ?? next.omittedCount,
          sanitized: full.sanitized ?? next.sanitized,
          hasDetail: full.hasDetail ?? next.hasDetail,
          origin: full.origin ?? next.origin,
          receipt: full.receipt ?? next.receipt,
          detail: full.detail,
          rawOutput: full.rawOutput,
          blocks: full.blocks,
          files: full.files ?? next.files,
          plan: full.plan ?? next.plan,
          terminalOnly: full.terminalOnly ?? next.terminalOnly,
          requester: full.requester,
          reason: full.reason,
          outputHidden: full.outputHidden,
          command: full.command ?? next.command,
          input: full.input ?? next.input,
        });
      })
      .catch((cause) => {
        if (generation !== current.current) return;
        const message = appReadErrorCopy(cause);
        setLine({ ...next, detail: message || undefined, rawOutput: undefined, blocks: undefined });
        setError(message || null);
      });
  };
  return {
    line,
    error,
    open,
    close: () => {
      current.current++;
      setLine(null);
    },
  };
}

/**
 * One quiet outcome-focused disclosure — `Edited ChevronGlyph.tsx · ran tests ⌄` —
 * that opens flush on the message text edge into 1px hairline-separated rows
 * with consecutive read-only checks folded into an expandable `Checked` row.
 */
function ToolRunGroupRow({
  run,
  lookup,
  onPressLine,
}: {
  run: Extract<ToolLedgerRun, { kind: 'group' }>;
  lookup?: ToolIdentityLookup;
  onPressLine?: (line: ToolLedgerLine) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [expandedFolds, setExpandedFolds] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState<ToolLedgerLine[]>([]);
  const [remoteIndex, setRemoteIndex] = useState(0);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = React.useRef(false);
  const remote = run.lines.flatMap((line) => (line.toolGroup ? [line.toolGroup] : []));
  const hasRemote = remoteIndex < remote.length;
  const lines = useMemo(
    () => (remote.length ? [...run.lines.filter((line) => !line.toolGroup), ...loaded] : run.lines),
    [loaded, remote.length, run.lines],
  );
  const remoteUnloaded = remote.length > 0 && loaded.length === 0;
  const displayItems = useMemo(() => foldConsecutiveReadLines(lines), [lines]);
  const visibleRowCount = displayItems.reduce(
    (sum, item) => sum + (item.kind === 'read-fold' && expandedFolds[item.id] ? 1 + item.lines.length : 1),
    0,
  );
  const load = () => {
    const group = remote[remoteIndex];
    if (!group || pending.current) return;
    pending.current = true;
    setLoading(true);
    setFailed(false);
    const request = monolithPhoneOperation('readRoomTools', {
      roomId: group.roomId,
      anchor: group.anchor,
      ...(cursor ? { before: cursor } : {}),
    });
    void request
      .then((page) => {
        const fetched = toolPageLines(page, lookup);
        setLoaded((previous) => [...previous, ...fetched]);
        setCursor(page.next);
        if (!page.next) setRemoteIndex((index) => index + 1);
      })
      .catch(() => setFailed(true))
      .finally(() => {
        pending.current = false;
        setLoading(false);
      });
  };
  const summaryParts = useMemo(() => {
    const loadedFailed = lines.filter(
      (line) => line.outcome === 'failure' && !line.startupWarning,
    ).length;
    const failedCount = hasRemote ? Math.max(run.failed, loadedFailed) : loadedFailed;
    return toolRunSummaryParts(remoteUnloaded ? run.lines : lines, {
      remoteUnloaded,
      failed: failedCount,
    });
  }, [hasRemote, lines, remoteUnloaded, run.failed, run.lines]);
  const summary = summaryParts.map((part) => part.text).join(' · ');
  const pressHandler = (item: ToolLedgerLine) =>
    item.inspectable ? () => onPressLine?.(item) : undefined;

  return (
    <LedgerLogGroup testID={`tool-run-container-${run.id}`}>
      <LedgerDisclosure
        expanded={expanded}
        onPress={() => {
          if (!expanded && remote.length && !loaded.length) {
            load();
          }
          setExpanded((value) => !value);
        }}
        accessibilityLabel={`${summary}, expandable`}
        accessibilityState={{ expanded }}
        rowTestID={`tool-run-group-${run.id}`}
      >
        {summaryParts.map((part, index) => (
          <React.Fragment key={`${part.text}-${index}`}>
            {index > 0 ? ' · ' : null}
            {part.emphasis === 'strong' ? (
              <T v="metaStrong" color="ink">
                {part.text}
              </T>
            ) : (
              part.text
            )}
          </React.Fragment>
        ))}
      </LedgerDisclosure>
      {expanded ? (
        <YStack marginTop="1" width="100%" minWidth={0} testID={`tool-run-list-${run.id}`}>
          {visibleRowCount > 5 ? (
            <ScrollView
              nestedScrollEnabled
              maxHeight={FLAT_LEDGER_SCROLL_MAX_HEIGHT}
              testID={`tool-run-scroll-${run.id}`}
            >
              {displayItems.map((item, index) =>
                item.kind === 'line' ? (
                  <ToolLedgerLineRow
                    key={item.line.id}
                    line={item.line}
                    divider={index > 0}
                    onPress={pressHandler(item.line)}
                    testID={`tool-ledger-line-${item.line.id}`}
                  />
                ) : (
                  <ToolReadFoldRow
                    key={item.id}
                    fold={item}
                    divider={index > 0}
                    expanded={Boolean(expandedFolds[item.id])}
                    onToggle={() =>
                      setExpandedFolds((previous) => ({ ...previous, [item.id]: !previous[item.id] }))
                    }
                    onPressLine={onPressLine}
                  />
                ),
              )}
            </ScrollView>
          ) : (
            displayItems.map((item, index) =>
              item.kind === 'line' ? (
                <ToolLedgerLineRow
                  key={item.line.id}
                  line={item.line}
                  divider={index > 0}
                  onPress={pressHandler(item.line)}
                  testID={`tool-ledger-line-${item.line.id}`}
                />
              ) : (
                <ToolReadFoldRow
                  key={item.id}
                  fold={item}
                  divider={index > 0}
                  expanded={Boolean(expandedFolds[item.id])}
                  onToggle={() =>
                    setExpandedFolds((previous) => ({ ...previous, [item.id]: !previous[item.id] }))
                  }
                  onPressLine={onPressLine}
                />
              ),
            )
          )}
          {hasRemote ? (
            <LedgerDisclosure
              expanded={false}
              accessibilityState={{ expanded: false }}
              accessibilityLabel={`${Math.max(0, run.count - loaded.length)} more steps`}
              onPress={load}
              rowTestID={`tool-run-more-${run.id}`}
            >
              {loading ? 'Loading…' : failed ? 'Retry' : `${Math.max(0, run.count - loaded.length)} more`}
            </LedgerDisclosure>
          ) : null}
        </YStack>
      ) : null}
    </LedgerLogGroup>
  );
}

function ToolReadFoldRow({
  fold,
  divider,
  expanded,
  onToggle,
  onPressLine,
}: {
  fold: Extract<ReturnType<typeof foldConsecutiveReadLines>[number], { kind: 'read-fold' }>;
  divider: boolean;
  expanded: boolean;
  onToggle: () => void;
  onPressLine?: (line: ToolLedgerLine) => void;
}) {
  const foldText = fold.detail ? `${fold.lead} · ${fold.detail}` : fold.lead;
  return (
    <>
      <TranscriptNavigationRow
        testID={`tool-read-fold-${fold.id}`}
        singleDestination
        divider={divider}
        dividerWidth={1}
        quietChevron
        chevronDirection={expanded ? 'up' : 'down'}
        trailing={{
          onPress: onToggle,
          accessibilityLabel: `Checked ${foldText}, expandable`,
          accessibilityRole: 'button',
          accessibilityState: { expanded },
          accessibilityHint: 'Shows each checked item',
        }}
      >
        <XStack alignItems="flex-start" gap="2" width="100%" minWidth={0}>
          <T
            v="meta"
            color="secondary"
            minWidth={VERB_COLUMN_MIN_WIDTH}
            flexShrink={0}
            numberOfLines={1}
          >
            Checked
          </T>
          <T
            v="meta"
            color="secondary"
            ellipsizeMode="tail"
            numberOfLines={2}
            flex={1}
            minWidth={48}
          >
            {foldText}
          </T>
        </XStack>
      </TranscriptNavigationRow>
      {expanded
        ? fold.lines.map((child) => (
            <ToolLedgerLineRow
              key={child.id}
              line={child}
              divider
              onPress={child.inspectable ? () => onPressLine?.(child) : undefined}
              testID={`tool-ledger-line-${child.id}`}
            />
          ))
        : null}
    </>
  );
}

function sheetSubtitleFor(line: ToolLedgerLine | null): string | undefined {
  if (!line) return undefined;
  if (line.outcome === 'failure') return line.reason;
  return line.requester;
}

/**
 * A settled reply's steps line: the turn's tool calls and interim notes folded
 * under one quiet step-count trigger. Renders nothing when the reply has no steps.
 */
export const TurnStepsLine = React.memo(function TurnStepsLine({
  items,
  lookup,
  testID,
}: {
  items: readonly AgentActivityItem[];
  lookup?: ToolIdentityLookup;
  testID?: string;
}) {
  const runs = useMemo(
    () =>
      groupToolLedgerRuns(
        toolLedgerLines(buildTurnActivity(items, { settled: true, lookup }).steps, false, lookup),
      ),
    [items, lookup],
  );
  const { line: sheetLine, error: sheetError, open: openLine, close: closeLine } =
    useToolOutput(lookup);
  if (!runs.length) return null;
  return (
    <YStack testID={testID}>
      {runs.map((run) => (
        <ToolRunGroupRow key={run.id} lookup={lookup} onPressLine={openLine} run={run} />
      ))}
      <ToolOutputSheet
        searchScope={sheetLine?.searchScope}
        command={sheetLine?.command}
        input={sheetLine?.input}
        summary={sheetLine?.summary}
        receipt={sheetLine?.receipt}
        detail={sheetLine?.detail}
        rawOutput={sheetLine?.rawOutput}
        blocks={sheetLine?.blocks}
        files={sheetLine?.files}
        plan={sheetLine?.plan}
        outcome={sheetLine?.outcome}
        exitCode={sheetLine?.exitCode}
        signal={sheetLine?.signal}
        outputTruncated={sheetLine?.outputTruncated}
        omittedCount={sheetLine?.omittedCount}
        sanitized={sheetLine?.sanitized}
        terminalOnly={sheetLine?.terminalOnly}
        outputHidden={sheetLine?.outputHidden}
        requester={sheetLine?.requester}
        lookup={lookup}
        error={sheetError}
        onClose={closeLine}
        subtitle={sheetSubtitleFor(sheetLine)}
        title={sheetLine?.sheetTitle ?? sheetLine?.label ?? 'Output'}
        visible={Boolean(sheetLine)}
      />
    </YStack>
  );
});

/**
 * The live conversational turn: agent prose, and beneath it the flat tool
 * ledger — one collapsed step-count disclosure per agent turn, expanding to
 * one flat row per step.
 */
export const ActivityTimeline = React.memo(function ActivityTimeline({
  active = false,
  handle,
  items,
  stamp,
  testID,
  messageDraft,
  messageDraftKey,
  lookup,
  mark,
}: ActivityTimelineProps) {
  const turn = useMemo(
    () => buildTurnActivity(items, { settled: !active, lookup }),
    [items, active, lookup],
  );
  const runs = useMemo(
    () => groupToolLedgerRuns(toolLedgerLines(turn.steps, active, lookup)),
    [turn, active, lookup],
  );
  const { line: sheetLine, error: sheetError, open: openLine, close: closeLine } =
    useToolOutput(lookup);
  if (!turn.narration.length && !runs.length && !messageDraft && !messageDraftKey) return null;

  return (
    <YStack width="100%" minWidth={0} paddingTop={handle ? '4' : '1'} paddingBottom="2" testID={testID}>
      <TranscriptLine sender={handle ? { name: handle, stamp: stamp ?? '', mark } : undefined}>
        {turn.narration.map((narration, index) => (
          <TypedView
            view={MonoMarkdown}
            v="body"
            key={`${index}:${narration}`}
            markdown={narration}
            testID={`activity-narration-${index}`}
          />
        ))}
        {runs.map((run) => (
          <ToolRunGroupRow key={run.id} lookup={lookup} onPressLine={openLine} run={run} />
        ))}
        {messageDraft || messageDraftKey ? (
          <YStack marginTop="1">
            <TypedView
              view={StreamingProse}
              v="body"
              color="secondary"
              {...(messageDraftKey ? { streamKey: messageDraftKey } : { markdown: messageDraft! })}
              testID="activity-message-draft"
            />
          </YStack>
        ) : null}
      </TranscriptLine>
      <ToolOutputSheet
        searchScope={sheetLine?.searchScope}
        command={sheetLine?.command}
        input={sheetLine?.input}
        summary={sheetLine?.summary}
        receipt={sheetLine?.receipt}
        detail={sheetLine?.detail}
        rawOutput={sheetLine?.rawOutput}
        blocks={sheetLine?.blocks}
        files={sheetLine?.files}
        plan={sheetLine?.plan}
        outcome={sheetLine?.outcome}
        exitCode={sheetLine?.exitCode}
        signal={sheetLine?.signal}
        outputTruncated={sheetLine?.outputTruncated}
        omittedCount={sheetLine?.omittedCount}
        sanitized={sheetLine?.sanitized}
        terminalOnly={sheetLine?.terminalOnly}
        outputHidden={sheetLine?.outputHidden}
        requester={sheetLine?.requester}
        lookup={lookup}
        error={sheetError}
        onClose={closeLine}
        subtitle={sheetSubtitleFor(sheetLine)}
        title={sheetLine?.sheetTitle ?? sheetLine?.label ?? 'Output'}
        visible={Boolean(sheetLine)}
      />
    </YStack>
  );
});
