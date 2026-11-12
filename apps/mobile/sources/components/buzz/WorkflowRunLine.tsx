import React, { useMemo, useState } from 'react';
import { CornerDownRight, type LucideProps } from 'lucide-react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { XStack, YStack, useTheme } from 'tamagui';
import {
  identityHandle,
  type WorkflowActorView,
  type WorkflowOpenedCornerView,
  type WorkflowRunDetailView,
} from '@beeline/api-contract/phone';
import {
  workflowPlanLine,
  workflowRunLine,
  workflowStateLabel,
  type WorkflowLineStatus,
  type WorkflowLineStep,
} from '@/buzz/workflow-graph';
import {
  formatRunDuration,
  stepSeconds,
  workflowStepAssignee,
  workflowStepMeta,
} from '@/buzz/workflow-run-copy';
import { isGeneratedAgentAvatarUrl } from '@/buzz/identity-mark';
import { Inked, T } from '@/ui/grammar';
import { findRoomCornerRow, useRoomCornerRecord } from '@/buzz/room-corner-store';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from './ChevronGlyph';
import { ContentTarget } from './IndexRow';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import { IdentityMark } from './IdentityMark';
import { HullLivePulse } from './MonoHull';

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

const CIRCLE = 20;
const HALO = 32;
/** The circle's top within a step row, and the line's x (the circle's centre). */
const CIRCLE_TOP = 8;
const LINE_X = 28;
/** Where a step's copy column starts, right of the rail and its halo. */
const COPY_X = 56;
/** The assignee's mark: the step circle's size, so the row keeps one height. */
const ASSIGNEE_MARK = CIRCLE;

/** The status in words, for a screen reader: the circle's shape and tone say it to the eye. */
const STATUS_WORD: Record<WorkflowLineStatus, string> = {
  done: 'done',
  current: 'current step',
  pending: 'not yet reached',
  failed: 'failed',
};

const reached = (step: WorkflowLineStep) =>
  step.status === 'done' || step.status === 'current' || step.status === 'failed';

type SegmentTone = 'brass' | 'quiet';

/** Brass where the run went, quiet ahead. */
function segmentTone(above: WorkflowLineStep, below: WorkflowLineStep): SegmentTone {
  return reached(above) && reached(below) ? 'brass' : 'quiet';
}

/** One step's circle: brass check, breathing brass ring, hollow, or ink x. */
export function WorkflowStepCircle({
  status,
  size = CIRCLE,
  testID,
}: {
  status: WorkflowLineStatus;
  size?: number;
  testID?: string;
}) {
  const { brass, ground, hollow, ink } = usePalette();
  return (
    <Svg
      {...DECORATIVE_GLYPH_PROPS}
      height={size}
      testID={testID}
      viewBox="0 0 20 20"
      width={size}
    >
      {status === 'done' ? (
        <>
          <Circle cx={10} cy={10} fill={brass} r={9} />
          <Path
            d="M6 10.2l2.6 2.6L14 7.4"
            fill="none"
            stroke={ground}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2.2}
          />
        </>
      ) : status === 'current' ? (
        <>
          <Circle cx={10} cy={10} fill={ground} r={8.25} stroke={brass} strokeWidth={1.5} />
          <Circle cx={10} cy={10} fill={brass} r={4} />
        </>
      ) : status === 'failed' ? (
        <>
          <Circle cx={10} cy={10} fill={ground} r={8.25} stroke={ink} strokeWidth={1.5} />
          <Path d="M7 7l6 6M13 7l-6 6" stroke={ink} strokeLinecap="round" strokeWidth={1.6} />
        </>
      ) : (
        <Circle cx={10} cy={10} fill={ground} r={8} stroke={hollow} strokeWidth={1.5} />
      )}
    </Svg>
  );
}

/** The SVG inks: react-native-svg takes colour strings, read from the theme. */
function usePalette() {
  const t = useTheme() as Record<string, { val: string } | undefined>;
  return {
    brass: t.needsYou?.val,
    ground: t.canvas?.val,
    hollow: t.secondary?.val,
    ink: t.secondary?.val,
  };
}

/** A 2pt piece of the line, solid brass or quiet: above the circle, or from below it to the row's foot. */
function Segment({ tone, below, testID }: { tone: SegmentTone; below: boolean; testID?: string }) {
  return (
    <YStack
      position="absolute"
      left={LINE_X - 1}
      width={2}
      top={below ? CIRCLE_TOP + CIRCLE : 0}
      height={below ? undefined : CIRCLE_TOP}
      bottom={below ? 0 : undefined}
      backgroundColor={tone === 'brass' ? 'needsYou' : 'strongStroke'}
      testID={testID ? `${testID}-${tone}` : undefined}
    />
  );
}

/**
 * A workflow read before any run exists (a schedule's workflow): its
 * contract alone, so every step is pending and nothing claims a run status.
 */
export type WorkflowPlanView = {
  readonly contract: WorkflowRunDetailView['contract'];
  readonly roleHolders: WorkflowRunDetailView['roleHolders'];
  readonly run?: undefined;
  readonly history?: undefined;
  readonly viewer?: undefined;
};

/**
 * Every step of the workflow, one row each: done steps, the current step with
 * its live narration, and upcoming steps dimmed. The page reads the run;
 * decisions stay on the choice cards in the Room.
 */
export function WorkflowRunLine({
  detail,
  now,
  liveDrafts,
  onOpenCorner,
  onOpenMessage,
  testID = 'workflow-run-line',
}: {
  detail: WorkflowRunDetailView | WorkflowPlanView;
  now: number;
  /** Newest chunks keyed by agent id and turn request id. */
  liveDrafts?: ReadonlyMap<string, string>;
  onOpenCorner: (corner: WorkflowOpenedCornerView) => void;
  /** Opens the source message a gate was answered from, when the run records one. */
  onOpenMessage?: (messageId: string) => void;
  testID?: string;
}) {
  const line = useMemo(
    () =>
      detail.run
        ? workflowRunLine(detail.contract, detail.history, detail.run.status)
        : workflowPlanLine(detail.contract),
    [detail.contract, detail.history, detail.run],
  );
  return (
    // The current step's halo (HALO, wider than the circle it rings) would
    // otherwise touch whatever sits directly above the rail.
    <YStack paddingTop="2" testID={testID}>
      {line.map((step, index) => (
        <StepRow
          above={index > 0 ? segmentTone(line[index - 1]!, step) : undefined}
          below={index < line.length - 1 ? segmentTone(step, line[index + 1]!) : undefined}
          detail={detail}
          key={step.visitId ?? step.state}
          liveDrafts={liveDrafts}
          now={now}
          onOpenCorner={onOpenCorner}
          onOpenMessage={onOpenMessage}
          step={step}
          testID={`${testID}-step-${step.state}${line.slice(0, index).some((previous) => previous.state === step.state) ? `-visit-${index}` : ''}`}
        />
      ))}
    </YStack>
  );
}

/** The step's holder at the row's right: their mark and handle, brass when it is the viewer. */
function Assignee({
  actor,
  viewer,
  testID,
}: {
  actor: WorkflowActorView;
  viewer: boolean;
  testID: string;
}) {
  const brass = viewer || (actor.kind === 'agent' && isGeneratedAgentAvatarUrl(actor.avatar));
  return (
    // The row's own label already names the assignee.
    <XStack
      accessibilityElementsHidden
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      alignItems="center"
      gap="2"
      maxWidth={140}
      testID={`${testID}-assignee${viewer ? '-viewer' : ''}`}
    >
      <IdentityMark
        avatarUrl={actor.avatar}
        face={actor.face}
        kind={actor.kind}
        name={actor.name}
        seed={actor.id}
        size={ASSIGNEE_MARK}
        testID={`${testID}-assignee-mark`}
      />
      <T v="meta" color={brass ? 'needsYou' : 'secondary'} numberOfLines={1} testID={`${testID}-assignee-handle`}>
        {`@${identityHandle(actor)}`}
      </T>
    </XStack>
  );
}

function OpenedCorners({
  corners,
  onOpenCorner,
  testID,
}: {
  corners: readonly WorkflowOpenedCornerView[];
  onOpenCorner: (corner: WorkflowOpenedCornerView) => void;
  testID: string;
}) {
  return (
    <YStack marginTop="2" testID={`${testID}-corners`}>
      {corners.map((corner) => (
        <OpenedCorner corner={corner} key={corner.id} onOpenCorner={onOpenCorner} />
      ))}
    </YStack>
  );
}

/**
 * The run names which corners a step opened; the parent Room's corner record
 * names them now. The run's saved name shows only when the record has no row
 * for the corner.
 */
function OpenedCorner({
  corner,
  onOpenCorner,
}: {
  corner: WorkflowOpenedCornerView;
  onOpenCorner: (corner: WorkflowOpenedCornerView) => void;
}) {
  const record = useRoomCornerRecord(corner.parentRoomId);
  const row = record ? findRoomCornerRow(record, corner.id) : undefined;
  const named = row ? { ...corner, name: row.corner.name } : corner;
  return (
    <ContentTarget
      accessibilityLabel={`Open thread ${named.name}`}
      accessibilityRole="link"
      onPress={() => onOpenCorner(named)}
      minHeight={44}
      flexDirection="row"
      alignItems="center"
      gap="2"
      testID={`workflow-run-corner-${corner.id}`}
    >
      <Inked<LucideProps> glyph={CornerDownRight} color="secondary" size={13} strokeWidth={1.7} />
      <T v="meta" color="ink" flex={1} minWidth={0} numberOfLines={1}>
        {named.name}
      </T>
      <Inked color="needsYou" glyph={ChevronGlyph} size={CHEVRON_ROW_SIZE} />
    </ContentTarget>
  );
}

function StepRow({
  step,
  detail,
  now,
  liveDrafts,
  above,
  below,
  onOpenCorner,
  onOpenMessage,
  testID,
}: {
  step: WorkflowLineStep;
  detail: WorkflowRunDetailView | WorkflowPlanView;
  now: number;
  liveDrafts?: ReadonlyMap<string, string>;
  above?: SegmentTone;
  below?: SegmentTone;
  onOpenCorner: (corner: WorkflowOpenedCornerView) => void;
  onOpenMessage?: (messageId: string) => void;
  testID: string;
}) {
  const visit = step.visits[0];
  const run = detail.run ?? { viewerHolds: false };
  const meta = workflowStepMeta(step, {
    contract: detail.contract,
    run,
    history: detail.history ?? [],
  });
  const assignee = workflowStepAssignee(step, { ...detail, run });
  const isViewer = assignee !== undefined && assignee.id === detail.viewer?.id;
  const current = step.status === 'current';
  const draft = current && assignee?.kind === 'agent'
    ? Array.from(liveDrafts ?? []).reverse().find(([turn]) => visit?.outputTurns?.includes(turn))?.[1]
      ?? visit?.liveOutput
    : undefined;
  // A gate's own resolution line already states the result (the pick and who
  // picked it); showing the agent's final message too would say it twice.
  const final = !current && step.kind === 'handoff' ? visit?.finalReply : undefined;
  // A cached response from before the server's description repair must not
  // put the retired migration placeholder back on either workflow surface.
  const savedDoes = detail.contract.handoffs[step.state]?.does;
  const does = savedDoes?.includes('describe what this step does') ? undefined : savedDoes;
  const gate = visit?.gate;
  const gateWaitingOn = detail.run?.viewerHolds ? 'you' : `a person in ${detail.run?.roomName}`;
  const gateLine =
    step.kind === 'gate'
      ? gate?.answer !== undefined
        ? `${gate.answer}${gate.answeredBy ? ` · ${gate.answeredBy.name}` : ''}${gate.sourceMessageId ? ' answered by message' : ''}`
        : current
          ? `Waiting on ${gateWaitingOn}`
          : undefined
      : undefined;
  const name = workflowStateLabel(step.state);
  const label = [name, does, STATUS_WORD[step.status], assignee?.name, meta].filter(Boolean).join(', ');
  const seconds = stepSeconds(step, now);
  // The terminal that ends the run reads by the clock it was reached, not an elapsed span.
  const reachedAt = step.kind === 'terminal' ? visit?.enteredAt : undefined;
  const dimmed = step.status === 'pending' ? 0.45 : 1;
  // Every step starts open; a tap collapses it to its one-line description,
  // and a second tap reopens it.
  const hasDetail = Boolean(draft || final || gateLine || visit?.openedCorners?.length);
  const [expanded, setExpanded] = useState(true);
  const open = expanded || !hasDetail;
  return (
    <YStack position="relative" testID={testID}>
      {above ? <Segment below={false} testID={`${testID}-above`} tone={above} /> : null}
      {below ? <Segment below testID={`${testID}-below`} tone={below} /> : null}
      <XStack
        accessibilityHint={hasDetail ? (expanded ? 'Hides this step’s output' : 'Shows this step’s output') : undefined}
        accessibilityLabel={label}
        accessibilityRole={hasDetail ? 'button' : undefined}
        accessibilityState={hasDetail ? { expanded } : undefined}
        aria-expanded={hasDetail ? expanded : undefined}
        onPress={hasDetail ? () => setExpanded((value) => !value) : undefined}
        alignItems="flex-start"
        paddingRight="4"
        testID={`${testID}-header`}
      >
        {current ? (
          <YStack position="absolute" left={LINE_X - HALO / 2} top={CIRCLE_TOP + CIRCLE / 2 - HALO / 2} width={HALO} height={HALO}>
            <HullLivePulse>
              <YStack width={HALO} height={HALO} borderRadius="full" borderWidth={1} borderColor="needsYou" testID={`${testID}-halo`} />
            </HullLivePulse>
          </YStack>
        ) : null}
        <YStack position="absolute" left={LINE_X - CIRCLE / 2} top={CIRCLE_TOP}>
          <WorkflowStepCircle status={step.status} testID={`${testID}-circle-${step.status}`} />
        </YStack>
        <YStack width={COPY_X} />
        <YStack flex={1} minWidth={0} paddingVertical="2" opacity={dimmed}>
          <T v={current ? 'heading' : 'body'} color="ink">
            {name}
            {meta ? <T v="meta" color="secondary">{` · ${meta}`}</T> : null}
          </T>
        </YStack>
        <XStack alignItems="center" gap="2" paddingTop="2" opacity={dimmed}>
          {assignee ? <Assignee actor={assignee} testID={testID} viewer={isViewer} /> : null}
          {reachedAt !== undefined ? (
            <T v="code" color="secondary" testID={`${testID}-duration`}>{CLOCK.format(new Date(reachedAt * 1_000))}</T>
          ) : seconds !== undefined ? (
            <T v="code" color="secondary" testID={`${testID}-duration`}>{formatRunDuration(seconds)}</T>
          ) : null}
        </XStack>
      </XStack>
      <XStack paddingRight="4" paddingBottom="2" opacity={dimmed}>
        <YStack width={COPY_X} />
        <YStack flex={1} minWidth={0}>
          {does ? <T v="meta" color="secondary" marginTop="1" testID={`${testID}-description`}>{does}</T> : null}
          {open && draft ? (
            // Transient while it's still being written: the provisional (quiet) prose tone.
            <T v="meta" color="secondary" marginTop="1" ellipsizeMode="head" numberOfLines={2} testID={`${testID}-live`}>
              {draft.replace(/\s+/g, ' ').trim()}
            </T>
          ) : null}
          {open && final ? (
            <T v="meta" color="ink" marginTop="1" testID={`${testID}-final`}>{final.text}</T>
          ) : null}
          {open && gateLine ? (
            gate?.sourceMessageId && onOpenMessage ? (
              <T
                v="meta"
                color="needsYou"
                marginTop="1"
                textDecorationLine="underline"
                accessibilityRole="link"
                onPress={() => onOpenMessage(gate.sourceMessageId!)}
                testID={`${testID}-gate`}
              >
                {gateLine}
              </T>
            ) : (
              <T v="meta" color="secondary" marginTop="1" testID={`${testID}-gate`}>{gateLine}</T>
            )
          ) : null}
          {open && visit?.openedCorners?.length ? (
            <OpenedCorners corners={visit.openedCorners} onOpenCorner={onOpenCorner} testID={testID} />
          ) : null}
        </YStack>
      </XStack>
    </YStack>
  );
}
