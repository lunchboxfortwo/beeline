import { appReadErrorCopy } from '@/buzz/app-error-copy';
import { displayRoomMessage } from '@/buzz/room-view-presentation';
import { readRoomViewMessage, type PhoneOperationMap } from '@beeline/api-contract/phone';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, XStack, YStack } from 'tamagui';
import { Spinner, T, TypedView } from '@/ui/grammar';
import type { AgentActivityItem } from '@/sync/transport/rig-transport';
import { buildTurnActivity } from '@/buzz/activity-timeline';
import { formatToolCallDuration } from '@/buzz/tool-call-row';
import type { ToolIdentityLookup } from '@/buzz/tool-identity-lookup';
import {
  groupToolLedgerRuns,
  toolGroupSummary,
  toolLedgerLines,
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

function lineAccessibilityLabel(line: ToolLedgerLine): string {
  if (line.kind === 'note') {
    return line.startupWarning ? `Startup note: ${line.label}` : `Note: ${line.label}`;
  }
  const parts = [line.label];
  if (line.kind !== 'thought') parts.push(OUTCOME_WORDS[line.outcome]);
  if (line.reason) parts.push(line.reason);
  return parts.join(', ');
}

/**
 * Shared transcript child row: action, machine object and recorded duration.
 * The whole row opens the output sheet only when the call carries inspectable detail.
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
  const duration = formatToolCallDuration(line.durationMs);
  const showVerdict = line.kind === 'tool';
  const accessibilityLabel = lineAccessibilityLabel(line);
  if (line.kind === 'note' && line.startupWarning) {
    return (
      <TranscriptNavigationRow
        divider={divider}
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
          <T v="meta" color="secondary" flexShrink={0} numberOfLines={1}>
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
      <TranscriptNavigationRow divider={divider} testID={testID}>
        <YStack flex={1} minWidth={0}>
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
  return (
    <TranscriptNavigationRow
      testID={testID}
      singleDestination={Boolean(onPress)}
      divider={divider}
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
      <YStack gap="1" flex={1} minWidth={0}>
        <XStack alignItems="center" gap="2" minWidth={0}>
          {(!hasNamedAction || line.outcome === 'failure') && !(labelSegments && labelSegments.length > 1 && line.outcome !== 'failure') ? (
            <T
              v={line.outcome === 'failure' ? 'metaStrong' : 'meta'}
              color={line.outcome === 'failure' ? 'needsYou' : 'ink'}
              flexShrink={0}
              numberOfLines={1}
            >
              {verb}
            </T>
          ) : null}
          {!redundantFailureLabel ? (
            labelSegments && labelSegments.length > 1 ? (
              <T v="meta" color="ink" numberOfLines={2} flex={1} minWidth={48}>
                {!hasNamedAction && line.outcome !== 'failure' ? `${verb} ` : ''}
                {labelSegments.map((part, index) => {
                  const match = part.match(/^(\s*)([@#][A-Za-z0-9._-]+)$/);
                  if (!match) return <React.Fragment key={index}>{part}</React.Fragment>;
                  return (
                    <React.Fragment key={index}>
                      {match[1]}
                      <T v="metaStrong" color="needsYou">
                        {match[2]}
                      </T>
                    </React.Fragment>
                  );
                })}
              </T>
            ) : (
              <T v="code" ellipsizeMode="middle" numberOfLines={1} flex={1} minWidth={48}>
                {line.label}
              </T>
            )
          ) : null}
          {duration ? (
            <T v="code" color="secondary" flexShrink={0} fontVariant={['tabular-nums']}>
              {duration}
            </T>
          ) : null}
          {showVerdict && line.outcome === 'running' ? (
            <Spinner testID={`activity-verdict-${line.id}`} />
          ) : null}
        </XStack>
        {line.outcome === 'failure' && line.reason ? (
          <T v="meta" color="secondary" width="100%" minWidth={0} testID={`activity-reason-${line.id}`}>
            {line.reason}
          </T>
        ) : null}
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
    const request = monolithPhoneOperation('readRoomTools', next.toolOutput);
    void request
      .then((page) => {
        if (generation !== current.current) return;
        const full = toolPageLines(page, lookup).find((item) => item.id === next.id);
        setLine({
          ...next,
          label: full?.label ?? next.label,
          sheetTitle: full?.sheetTitle ?? next.sheetTitle,
          verb: full?.verb ?? next.verb,
          receipt: full?.receipt ?? next.receipt,
          detail: full?.detail,
          rawOutput: full?.rawOutput,
          files: full?.files ?? next.files,
          plan: full?.plan ?? next.plan,
          terminalOnly: full?.terminalOnly ?? next.terminalOnly,
          requester: full?.requester,
          reason: full?.reason,
          outputHidden: full?.outputHidden,
          command: full?.command ?? next.command,
          input: full?.input ?? next.input,
        });
      })
      .catch((cause) => {
        if (generation !== current.current) return;
        const message = appReadErrorCopy(cause);
        setLine({ ...next, detail: message || undefined, rawOutput: undefined });
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
 * One quiet step-count disclosure — `5 steps · 1 failed ⌄` — that opens into
 * one flat single-item-per-row list behind a left guide bar (~5 visible rows
 * scrollable when >5 rows).
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
  const [loaded, setLoaded] = useState<ToolLedgerLine[]>([]);
  const [remoteIndex, setRemoteIndex] = useState(0);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = React.useRef(false);
  const remote = run.lines.flatMap((line) => (line.toolGroup ? [line.toolGroup] : []));
  const hasRemote = remoteIndex < remote.length;
  const lines = remote.length ? [...run.lines.filter((line) => !line.toolGroup), ...loaded] : run.lines;
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
  const duration = formatToolCallDuration(run.durationMs);
  const summary = toolGroupSummary(run.count, run.failed, run.durationMs, run.notes);
  const steps = run.count > 0 || run.notes === 0;
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
        {steps ? `${run.count} ${run.count === 1 ? 'step' : 'steps'}` : null}
        {run.failed ? <T v="meta" color="needsYou">{` · ${run.failed} failed`}</T> : null}
        {run.notes ? `${steps ? ' · ' : ''}${run.notes} ${run.notes === 1 ? 'note' : 'notes'}` : null}
        {duration ? ` · ${duration}` : null}
      </LedgerDisclosure>
      {expanded ? (
        <YStack
          marginTop="1"
          marginLeft="1"
          paddingLeft="3"
          borderLeftWidth={1.5}
          borderLeftColor="strongStroke"
          testID={`tool-run-list-${run.id}`}
        >
          {lines.length > 5 ? (
            <ScrollView
              nestedScrollEnabled
              maxHeight={FLAT_LEDGER_SCROLL_MAX_HEIGHT}
              testID={`tool-run-scroll-${run.id}`}
            >
              {lines.map((line, index) => (
                <ToolLedgerLineRow
                  key={line.id}
                  line={line}
                  divider={index > 0}
                  onPress={pressHandler(line)}
                  testID={`tool-ledger-line-${line.id}`}
                />
              ))}
            </ScrollView>
          ) : (
            lines.map((line, index) => (
              <ToolLedgerLineRow
                key={line.id}
                line={line}
                divider={index > 0}
                onPress={pressHandler(line)}
                testID={`tool-ledger-line-${line.id}`}
              />
            ))
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
        command={sheetLine?.command}
        input={sheetLine?.input}
        receipt={sheetLine?.receipt}
        detail={sheetLine?.detail}
        rawOutput={sheetLine?.rawOutput}
        files={sheetLine?.files}
        plan={sheetLine?.plan}
        outcome={sheetLine?.outcome}
        terminalOnly={sheetLine?.terminalOnly}
        outputHidden={sheetLine?.outputHidden}
        requester={sheetLine?.requester}
        lookup={lookup}
        error={sheetError}
        onClose={closeLine}
        subtitle={sheetLine?.outcome === 'failure' ? sheetLine.reason : sheetLine?.requester}
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
        command={sheetLine?.command}
        input={sheetLine?.input}
        receipt={sheetLine?.receipt}
        detail={sheetLine?.detail}
        rawOutput={sheetLine?.rawOutput}
        files={sheetLine?.files}
        plan={sheetLine?.plan}
        outcome={sheetLine?.outcome}
        terminalOnly={sheetLine?.terminalOnly}
        outputHidden={sheetLine?.outputHidden}
        requester={sheetLine?.requester}
        lookup={lookup}
        error={sheetError}
        onClose={closeLine}
        subtitle={sheetLine?.outcome === 'failure' ? sheetLine.reason : sheetLine?.requester}
        title={sheetLine?.sheetTitle ?? sheetLine?.label ?? 'Output'}
        visible={Boolean(sheetLine)}
      />
    </YStack>
  );
});
