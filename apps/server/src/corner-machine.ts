import { threadState,type CornerLifecycleView,type CornerStateReason,type ThreadState } from '@beeline/api-contract/phone';
import type { CornerEvent } from './corner-lifecycle-values.js';
import { cornerGateChecks } from './corner-ci-gate.js';

export type CornerCheckSummary = NonNullable<CornerLifecycleView['checksSummary']> & {
  reportedHeadSha?: string;
  reportedFailing?: readonly string[];
  attempt?: number;
  statusChangedAt?: number;
  zeroCheckSource?: 'workflow-count' | 'worker-completion';
};

export type CornerCheckObservation = {
  headSha: string;
  previousHeadSha?: string;
  prior?: CornerCheckSummary;
  next: CornerCheckSummary;
  settled?: boolean;
};

export type CornerChecksPlan = {
  sameReportedHead: boolean;
  newAttempt: boolean;
  attempt: number;
  reportFailure: boolean;
  storedSummary: CornerCheckSummary;
};

/** The only corner state machine. Provider facts and execution receipts are inputs;
 * every transition, wake and notification is decided here, including recovery. */
export type CornerMachine = {
  headSha?: string;
  pullRequest?: number;
  effects?: string[];
  /** A green handoff for this target that has not reached a pending review request. */
  reviewDue?: boolean;
  outcome?: 'landed' | 'closed';
  /** A person or agent parked the thread in Backlog (update_work); it rests idle with reason backlog. */
  backlog?: true;
} & ThreadState;

export type MachineWake = {
  kind:
    | 'open'
    | 'revision'
    | 'checks-failed'
    | 'review'
    | 'review-findings'
    | 'review-gap'
    | 'land'
    | 'merge-refused'
    | 'merge-conflict';
  key: string;
};

export type MachineNotification = { kind: 'idle' | 'waiting'; key: string };

export type CornerMachineFacts = {
  archived: boolean;
  locked?: boolean;
  /** Running worker receipts; reviewer work has its own input. */
  turnRunning: boolean;
  reviewerActive?: boolean;
  /** Another agent's running turn. */
  peerActive?: boolean;
  /** The agents the state names: the implementer, and the reviewer and peer of their activity. */
  implementerId?: string;
  reviewerId?: string;
  peerId?: string;
  lifecycle?: CornerLifecycleView;
  /** The selected blocker; a merge hold is selected only when no other blocker is open. */
  blocker?: { reason: CornerStateReason; itemId?: string };
  headSha?: string;
  approved?: boolean;
  reviewerRequired?: boolean;
  mergeHeld?: boolean;
  mergeConflictDelivered?: boolean;
  lostEffects?: string[];
  reviewerConfigured?: boolean;
  /** Actual implementer admission; peer work still owns the Working badge. */
  implementerActive?: boolean;
  /** An actual request for this head; reviewer activity also includes event notices. */
  reviewRequestActive?: boolean;
  reviewRequests?: number;
  reviewEnded?: { id: string; findings?: string; delivered?: boolean };
  idleSince?: string;
  idleEligible?: boolean;
  checkSourceId?: string;
};

export type CornerMachineEvent = { facts: CornerMachineFacts; event: CornerEvent };

export function transitionCorner(
  current: CornerMachine,
  { facts, event }: CornerMachineEvent,
): {
  state: CornerMachine;
  wakes: MachineWake[];
  notifications: MachineNotification[];
  suppression?: string;
} {
  const f = facts;
  const headSha =
    f.headSha ??
    f.lifecycle?.pr?.headSha ??
    (event.kind === 'push'
      ? event.headSha
      : f.lifecycle?.checksSummary?.status === 'unknown' &&
          f.lifecycle.checksSummary.fetchStartedAt === undefined
        ? current.headSha
        : undefined);
  const pullRequest = f.lifecycle?.pr?.number;
  const redKey = `red:${headSha}`;
  const sameTarget = current.headSha === headSha && current.pullRequest === pullRequest;
  // A receipt cannot suppress a wake whose durable command was lost.
  // PR movement cannot replenish a person's idle-report budget, including
  // after old completed queue rows have been retired.
  const effects = (current.effects ?? []).filter(key => sameTarget || key.startsWith('idle:')).filter(
    (key) =>
      (key !== `merge-conflict:${headSha ?? ''}` || f.mergeConflictDelivered !== false) &&
      !(f.lostEffects ?? []).includes(key),
  );
  const backlog = event.kind === 'backlog' ? event.backlog : current.backlog === true;
  const base: Pick<CornerMachine, 'headSha' | 'pullRequest' | 'effects' | 'reviewDue' | 'backlog'> = {
    ...(headSha ? { headSha } : {}),
    ...(pullRequest ? { pullRequest } : {}),
    effects,
    ...(backlog ? { backlog: true as const } : {}),
  };
  const wakes: MachineWake[] = [];
  const notifications: MachineNotification[] = [];
  const wake = (kind: MachineWake['kind'], key = `${kind}:${headSha ?? ''}`) => {
    if (!effects.includes(key)) wakes.push({ kind, key });
  };
  const notify = (kind: MachineNotification['kind'], key: string) => {
    if (!effects.includes(key)) notifications.push({ kind, key });
  };
  const checks = f.lifecycle?.checks ?? f.lifecycle?.checksSummary?.status;
  const gateChecks = cornerGateChecks(f.lifecycle, headSha);
  const reviewReady = cornerGateChecks(f.lifecycle, headSha, 'review') === 'passing';
  const checksUnderway =
    checks === 'pending' ||
    f.lifecycle?.checksSummary?.checks.some((check) => check.status === 'pending') ||
    (Boolean(f.lifecycle?.pr) &&
      f.lifecycle?.checksSummary?.status === 'unknown' &&
      f.lifecycle.checksSummary.total === 0 &&
      f.lifecycle.checksSummary.fetchStartedAt === undefined);
  const providerEnded = f.lifecycle?.outcome === 'abandoned' || f.lifecycle?.lifecycle === 'done';
  const merged = f.lifecycle?.outcome === 'landed' || Boolean(f.lifecycle?.pr?.mergedAt);
  if (current.state === 'archived')
    return !f.archived && (event.kind === 'closed' || event.kind === 'merged')
      ? { state: event.kind === 'merged' ? { ...current, outcome: 'landed' } : current, wakes, notifications }
      : { state: current, wakes, notifications, suppression: 'archived' };
  if (
    f.archived ||
    event.kind === 'closed' ||
    (!f.locked && (providerEnded || merged || event.kind === 'merged'))
  )
    return {
      state: {
        ...base,
        ...threadState({ ended: true }),
        outcome: event.kind === 'merged' || merged || current.outcome === 'landed' ? 'landed' : 'closed',
      },
      wakes,
      notifications,
    };
  if (event.kind === 'checks-pending' && !checksUnderway)
    return { state: current, wakes, notifications, suppression: 'checks are not pending' };
  if (event.kind === 'checks' &&
    ((event.result === 'passing' ? gateChecks : checks) !== event.result || f.checkSourceId === 'stale'))
    return { state: current, wakes, notifications, suppression: 'stale check event' };
  if (
    (event.kind === 'approval' && event.headSha !== headSha) ||
    (event.kind === 'push' && event.headSha !== headSha) ||
    (event.kind === 'merge-refused' && event.headSha !== headSha)
  )
    return { state: current, wakes, notifications, suppression: 'stale head' };
  if (event.kind === 'open' && event.command)
    wake('open', `open:${event.command.privatePayload?.openKey ?? ''}`);
  if (event.kind === 'backlog' && !event.backlog && event.command)
    wake('open', `resume:${event.command.privatePayload?.openKey ?? ''}`);
  if (event.kind === 'brief-revised') wake('revision', `revision:${event.revision}`);
  if (!backlog && event.kind === 'merge-refused')
    wake(
      'merge-refused',
      `refused:${event.headSha}:${event.reason}:${event.confirmedUnmerged ? f.checkSourceId : ''}`,
    );
  // Wakes read facts, never the state; red and green facts keep their admission through a wait.
  const review = f.reviewEnded;
  if (
    headSha &&
    reviewReady &&
    !f.approved &&
    !(f.reviewRequestActive ?? f.reviewerActive) &&
    ((sameTarget && current.reviewDue) || event.kind === 'checks' || event.kind === 'brief-revised')
  )
    base.reviewDue = true;
  if (!backlog) {
    if (
      review?.findings &&
      !review.delivered &&
      f.implementerId &&
      headSha &&
      !f.approved &&
      !f.turnRunning &&
      !f.blocker
    )
      wake('review-findings', `review-failed:${headSha}:${review.id}`);
    if (
      checks === 'failing' &&
      !checksUnderway &&
      f.checkSourceId &&
      (!f.turnRunning || event.kind === 'checks')
    )
      wake('checks-failed', redKey);
    // Only a live GitHub read emits this event; a stored verdict never wakes.
    if (event.kind === 'merge-conflict' && f.lifecycle?.pr?.mergeability === 'dirty') wake('merge-conflict');
    if (headSha) {
      if (f.approved || f.reviewerRequired === false) {
        if (
          gateChecks === 'passing' &&
          !f.mergeHeld &&
          (event.kind === 'approval' || event.kind === 'checks' || event.kind === 'hold-released')
        )
          wake('land');
      } else if (
        reviewReady &&
        !(f.implementerActive ?? f.turnRunning) &&
        !(f.reviewRequestActive ?? f.reviewerActive) &&
        !wakes.some((effect) => effect.kind === 'review-findings' || effect.kind === 'revision') &&
        (base.reviewDue || !f.reviewRequests)
      ) {
        if (f.reviewerConfigured)
          wake('review');
        else if (!f.blocker) wake('review-gap');
      }
    }
  }
  const state: CornerMachine = { ...base, ...threadState({
    implementerRunning: f.turnRunning || wakes.some((w) => !['review', 'land'].includes(w.kind)),
    reviewerActive: f.reviewerActive || wakes.some((w) => w.kind === 'review'),
    checksRunning: checksUnderway, decisionOpen: Boolean(f.blocker), backlog, peerRunning: f.peerActive,
    implementer: f.implementerId, reviewer: f.reviewerId, peer: f.peerId,
  }) };
  if (state.state === 'waiting') notify('waiting', `waiting:${f.blocker!.itemId ?? f.blocker!.reason}`);
  if (state.state === 'idle' && !state.reason && f.idleEligible && f.idleSince) notify('idle', `idle:${f.idleSince}`);
  return { state, wakes, notifications };
}

/** Plan the one settled failure report and retain provider observation metadata. */
export function planCornerCheckObservation({
  headSha,
  previousHeadSha,
  prior,
  next,
  settled,
}: CornerCheckObservation): CornerChecksPlan {
  const sameReportedHead = prior?.reportedHeadSha === headSha;
  const newAttempt = sameReportedHead && checksRestarted(prior.checks, next.checks);
  const attempt = sameReportedHead ? (prior.attempt ?? 0) + Number(newAttempt) : 0;
  const reportFailure =
    next.status === 'failing' &&
    settled !== false &&
    checksSettled(next.checks) &&
    !(sameReportedHead && prior.reportedFailing?.length);
  const unchanged =
    previousHeadSha === headSha &&
    prior?.status === next.status &&
    !newAttempt &&
    JSON.stringify((prior.checks ?? []).map((check) => [check.name, check.status]).sort()) ===
      JSON.stringify(next.checks.map((check) => [check.name, check.status]).sort());
  return {
    sameReportedHead,
    newAttempt,
    attempt,
    reportFailure,
    storedSummary: {
      ...next,
      statusChangedAt: unchanged
        ? (prior.statusChangedAt ?? prior.fetchStartedAt ?? prior.updatedAt)
        : next.fetchStartedAt,
      attempt,
      reportedHeadSha: headSha,
      reportedFailing: reportFailure ? next.failing : sameReportedHead ? (prior.reportedFailing ?? []) : [],
    },
  };
}

/** No check on the head is still running. */
export function checksSettled(checks: readonly { status: string }[] | undefined): boolean {
  return !checks?.some((check) => check.status === 'pending');
}

/** A new Actions job also identifies a rerun whose start webhook was missed. */
export function checksRestarted(
  previous: readonly { name: string; status: string; url?: string }[] | undefined,
  current: readonly { name: string; status: string; url?: string }[],
): boolean {
  if (!previous?.length || !checksSettled(previous)) return false;
  return (
    !checksSettled(current) ||
    current.some((check) => {
      const before = previous.find((item) => item.name === check.name);
      return Boolean(
        before?.url &&
        check.url &&
        actionsJobId(before.url) &&
        actionsJobId(check.url) &&
        actionsJobId(before.url) !== actionsJobId(check.url),
      );
    })
  );
}

export function actionsJobId(url: string | undefined): number | undefined {
  const match = url?.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#]|$)/);
  const id = match ? Number(match[1]) : undefined;
  return id && Number.isSafeInteger(id) ? id : undefined;
}
