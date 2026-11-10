import type { CornerLifecycleView, CornerStateFacts, DerivedCornerState } from '@beeline/api-contract/phone';
import type { CornerEvent } from './corner-lifecycle-values.js';

export type CornerCheckSummary = NonNullable<CornerLifecycleView['checksSummary']> & {
  reportedHeadSha?: string;
  reportedFailing?: readonly string[];
  attempt?: number;
  statusChangedAt?: number;
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
} & (
  | { state: 'working' | 'idle' | 'archived' }
  | { state: 'review'; phase: 'checks' | 'reviewer' }
  | { state: 'waiting'; reason: 'blocked' | 'user_action' | 'question' }
);

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
    | 'merge-conflict'
    | 'command';
  key: string;
};

export type MachineNotification = { kind: 'idle' | 'waiting' | 'draft'; key: string };

export type CornerMachineFacts = CornerStateFacts & {
  headSha?: string;
  approved?: boolean;
  mergeHeld?: boolean;
  mergeConflictDelivered?: boolean;
  lostEffects?: string[];
  draftReadyFailure?: boolean;
  waitReason?: 'blocked' | 'user_action' | 'question';
  reviewerConfigured?: boolean;
  /** Actual implementer admission; peer work still owns the Working badge. */
  implementerActive?: boolean;
  /** An actual request for this head; reviewer activity also includes event notices. */
  reviewRequestActive?: boolean;
  reviewRequests?: number;
  reviewEnded?: { id: string; findings?: string; emptyCount?: number; delivered?: boolean };
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
      : event.kind !== 'pull-request-closed' &&
          f.lifecycle?.checksSummary?.status === 'unknown' &&
          f.lifecycle.checksSummary.fetchStartedAt === undefined
        ? current.headSha
        : undefined);
  const pullRequest = f.lifecycle?.pr?.number;
  const redKey = `red:${headSha}`;
  const sameTarget = current.headSha === headSha && current.pullRequest === pullRequest;
  // A receipt cannot suppress a wake whose durable command was lost.
  const effects = (sameTarget ? [...(current.effects ?? [])] : []).filter(
    (key) =>
      (key !== `merge-conflict:${headSha ?? ''}` || f.mergeConflictDelivered !== false) &&
      !(f.lostEffects ?? []).includes(key),
  );
  const base: Pick<CornerMachine, 'headSha' | 'pullRequest' | 'effects' | 'reviewDue'> = {
    ...(headSha ? { headSha } : {}),
    ...(pullRequest ? { pullRequest } : {}),
    effects,
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
  const checksUnderway =
    checks === 'pending' ||
    f.lifecycle?.checksSummary?.checks.some((check) => check.status === 'pending') ||
    (Boolean(f.lifecycle?.pr || headSha) &&
      f.lifecycle?.checksSummary?.status === 'unknown' &&
      f.lifecycle.checksSummary.total === 0 &&
      f.lifecycle.checksSummary.fetchStartedAt === undefined);
  const providerEnded = f.lifecycle?.outcome === 'abandoned' || f.lifecycle?.lifecycle === 'done';
  const merged = f.lifecycle?.outcome === 'landed' || Boolean(f.lifecycle?.pr?.mergedAt);
  if (
    event.kind === 'command' &&
    (current.state === 'archived' || f.archived) &&
    !['stop', 'restart'].includes(event.command.action ?? 'input')
  )
    return { state: current, wakes, notifications, suppression: 'archived' };
  if (event.kind === 'command')
    return { state: current, wakes: [{ kind: 'command', key: '' }], notifications };
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
        state: 'archived',
        outcome: event.kind === 'merged' || merged || current.outcome === 'landed' ? 'landed' : 'closed',
      },
      wakes,
      notifications,
    };
  if (event.kind === 'checks-pending' && !checksUnderway)
    return { state: current, wakes, notifications, suppression: 'checks are not pending' };
  if (event.kind === 'checks' && (checks !== event.result || f.checkSourceId === 'stale'))
    return { state: current, wakes, notifications, suppression: 'stale check event' };
  if (
    (event.kind === 'approval' && event.headSha !== headSha) ||
    (event.kind === 'push' && event.headSha !== headSha) ||
    (event.kind === 'merge-refused' && event.headSha !== headSha)
  )
    return { state: current, wakes, notifications, suppression: 'stale head' };
  if (event.kind === 'approval' && checks === 'passing' && !effects.includes('approved-on-green'))
    effects.push('approved-on-green');
  if (f.approved && f.draftReadyFailure && checks === 'passing') notify('draft', `draft:${headSha}`);
  if (event.kind === 'open' && event.command)
    wake('open', `open:${event.command.privatePayload?.openKey ?? ''}`);
  if (event.kind === 'brief-revised') wake('revision', `revision:${event.revision}`);
  if (event.kind === 'merge-refused')
    wake(
      'merge-refused',
      `refused:${event.headSha}:${event.reason}:${event.confirmedUnmerged ? f.checkSourceId : ''}`,
    );
  // Explicit waits remain visible even while CI or a receipt is running. Red
  // and green facts still retain their existing admission through that wait.
  const review = f.reviewEnded;
  const exhausted = (review?.emptyCount ?? 0) >= 2;
  if (
    headSha &&
    checks === 'passing' &&
    !f.approved &&
    !exhausted &&
    !(f.reviewRequestActive ?? f.reviewerActive) &&
    ((sameTarget && current.reviewDue) || event.kind === 'checks')
  )
    base.reviewDue = true;
  if (
    review &&
    headSha &&
    !f.approved &&
    !f.turnRunning &&
    !f.blocker &&
    (exhausted || (review.findings && !review.delivered))
  )
    wake('review-findings', `review-failed:${headSha}:${review.id}`);
  if (
    checks === 'failing' &&
    !checksUnderway &&
    f.checkSourceId &&
    (!f.turnRunning || event.kind === 'checks')
  )
    wake('checks-failed', redKey);
  if (f.lifecycle?.pr?.mergeability === 'dirty') wake('merge-conflict');
  if (checks === 'passing' && headSha && f.lifecycle?.pr?.mergeability !== 'dirty') {
    if (f.approved) {
      if (
        !f.mergeHeld &&
        !f.reviewerActive &&
        event.kind !== 'approval' &&
        !effects.includes('approved-on-green')
      )
        wake('land');
    } else if (
      !(f.implementerActive ?? f.turnRunning) &&
      !(f.reviewRequestActive ?? f.reviewerActive) &&
      !exhausted &&
      !wakes.some((effect) => effect.kind === 'review-findings') &&
      (base.reviewDue || !f.reviewRequests || review?.emptyCount === 1)
    ) {
      if (f.reviewerConfigured)
        wake('review', review?.emptyCount === 1 ? `review-retry:${headSha}:${review.id}` : undefined);
      else if (!f.blocker) wake('review-gap');
    }
  }
  let state: CornerMachine;
  if (
    f.blocker &&
    (f.blocker.blocker?.kind !== 'merge-hold' ||
      (!f.turnRunning && !f.reviewerActive && !checksUnderway && !wakes.some((w) => w.kind === 'review')))
  ) {
    const reason =
      f.waitReason ??
      (f.blocker.reason === 'question'
        ? 'question'
        : f.blocker.reason === 'approve' || f.blocker.reason === 'connect'
          ? 'user_action'
          : 'blocked');
    state = { ...base, state: 'waiting', reason };
    notify('waiting', `waiting:${f.blocker.itemId ?? reason}`);
  } else if (f.turnRunning || wakes.some((w) => !['review', 'review-gap'].includes(w.kind)))
    state = { ...base, state: 'working' };
  else if (
    f.reviewerActive ||
    wakes.some((w) => w.kind === 'review') ||
    (checks === 'passing' &&
      Boolean(headSha) &&
      f.reviewerConfigured !== undefined &&
      !f.reviewEnded &&
      !f.approved)
  )
    state = { ...base, state: 'review', phase: 'reviewer' };
  else if (checksUnderway) state = { ...base, state: 'review', phase: 'checks' };
  else {
    state = { ...base, state: 'idle' };
    if (f.idleEligible && f.idleSince) notify('idle', `idle:${f.idleSince}`);
  }
  return { state, wakes, notifications };
}

/** Compatibility input adapter. All badge decisions use the machine above. */
export function deriveCornerState(facts: CornerStateFacts): DerivedCornerState {
  const { state } = transitionCorner({ state: 'idle' }, { facts, event: { kind: 'reconcile' } });
  return {
    state: state.state,
    ...(state.state === 'waiting' && facts.blocker ? facts.blocker : {}),
  };
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
