import React, { useMemo } from 'react';
import { TypedView } from '@/ui/grammar';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { ledgerStamp } from '@/buzz/relative-time';
import { isGitHubEventRun, stopNotice } from '@/buzz/transcript-pills';
import { countedLifecycleItemIds, type NotificationLifecycleRun } from '@/buzz/pr-lifecycle';
import { BEELINE_FACE, GITHUB_FACE, isNotice, PillRow, type PillEvent, type PillFace, type PillItem, type PillRunEntry } from '@/ui/screens/transcript/PillRow';
import { LedgerEntryFrame, LedgerSystemLine } from './Ledger';
import { MonoMarkdown } from './MonoMarkdown';
import { NotificationLifecycleCard } from './PrLifecycleCard';

/** Who a pubkey is, for a pill face: the roster's agent or person, by id. */
export type PillIdentityResolver = (id: string, name: string, kind?: 'agent' | 'human') => PillFace;

type PillHandlers = {
  onOpenIdentity?: (id: string) => void;
  onOpenUrl?: (url: string) => void;
  onOpenBrief?: () => void;
  onOpenCorner?: (cornerId: string) => void;
  /** The open corner, when the transcript is a thread. */
  cornerId?: string;
};

function pillItem(message: ChatDisplayMessage, resolve: PillIdentityResolver, handlers: PillHandlers): PillItem {
  const time = ledgerStamp(message.timestamp);
  const stop = stopNotice(message);
  if (stop) {
    return {
      id: message.id,
      system: true,
      // A stop is the stopper's face, the stop glyph and the stopped agent's face; the line itself opens on tap.
      stop: true,
      from: resolve(stop.stopper.id, stop.stopper.name, stop.stopper.kind),
      to: resolve(stop.stopped.id, stop.stopped.name, 'agent'),
      time,
      body: (
        <LedgerSystemLine
          id={message.id}
          text={message.text}
          {...(message.systemEvent ? { event: message.systemEvent } : {})}
          stamp={time}
          bare
          onOpenIdentity={handlers.onOpenIdentity}
          onOpenUrl={handlers.onOpenUrl}
          onOpenBrief={handlers.onOpenBrief}
        />
      ),
    };
  }
  // `isPillMessage` admits only an agent-authored message to another agent here.
  const author = message.authorIdentity?.pubkey ?? message.pubkey ?? '';
  const authorName = message.authorIdentity?.name ?? '';
  const recipient = message.agentCommand?.recipient;
  const firstMention = message.mentionPubkeys?.[0];
  const to = recipient
    ? resolve(recipient.id, recipient.name, 'agent')
    : firstMention ? resolve(firstMention, '', 'agent') : undefined;
  // Every opened pill reads as a run row: the face → face heading already names the recipient.
  const text = recipient ? message.agentCommand!.text : message.text;
  return {
    id: message.id,
    system: false,
    from: resolve(author, authorName, 'agent'),
    to,
    time,
    body: (
      // An opened pill's messages read one step quieter than the transcript's own.
      <TypedView view={MonoMarkdown} v="body" color="secondary" markdown={text} testID={`pill-message-${message.id}`} />
    ),
  };
}

type LifecycleItem = NotificationLifecycleRun['items'][number];

const NOUNS: Partial<Record<LifecycleItem['kind'], string>> = { 'pull-request': 'PR', issue: 'issue', check: 'check', corner: 'thread' };

/** The lone pill's mark: opened, merged, closed, check failed, issue opened or closed, or thread opened. */
function eventMark(item: LifecycleItem, verb: string): PillEvent['mark'] {
  if (item.kind === 'check') return /fail/i.test(item.state) ? 'failed' : undefined;
  if (item.kind === 'corner') return verb === 'Opened' ? 'thread' : verb === 'Merged' ? 'merged' : verb === 'Closed' ? 'closed' : undefined;
  if (item.kind === 'issue' && !item.displayText) {
    return ['Filed', 'Opened', 'Reopened'].includes(verb) ? 'issueOpened' : verb === 'Closed' ? 'issueClosed' : undefined;
  }
  if (item.kind !== 'pull-request' || item.displayText) return undefined;
  return verb === 'Opened' ? 'opened' : verb === 'Merged' ? 'merged' : verb === 'Closed' ? 'closed' : undefined;
}

/**
 * One GitHub or thread event as a run entry. GitHub reports PRs, issues,
 * commits and checks; Beeline reports threads, in a Room with or without a
 * repository. It opens its thread, or GitHub
 * when it has none. Inside its own thread a check or PR opens GitHub, since
 * the thread is already open.
 */
function eventEntry(item: LifecycleItem, time: string, counted: boolean, handlers: PillHandlers): PillRunEntry & { event: PillEvent } {
  const state = item.state.replace(/^(PR|Checks) /, '');
  const verb = state.charAt(0).toUpperCase() + state.slice(1);
  const number = item.url?.match(/\/(?:pull|issues)\/(\d+)/)?.[1] ?? item.kindLine.match(/#(\d+)/)?.[1];
  const noun = NOUNS[item.kind];
  const spoken = item.displayText ?? [verb, noun, number ? `#${number}` : '', item.title].filter(Boolean).join(' ');
  const corner = item.cornerId && item.cornerId !== handlers.cornerId ? item.cornerId : undefined;
  const open = corner && handlers.onOpenCorner
    ? { label: 'Opens its thread', onPress: () => handlers.onOpenCorner!(corner) }
    : item.url && handlers.onOpenUrl
      ? { label: 'Opens GitHub', onPress: () => handlers.onOpenUrl!(item.url!) }
      : undefined;
  const source = item.kind === 'corner' ? 'beeline' : 'github';
  return {
    id: item.id,
    from: source === 'beeline' ? BEELINE_FACE : GITHUB_FACE,
    time,
    event: {
      source,
      mark: eventMark(item, verb),
      // A thread event names its kind on the line: "Opened thread github-event-pills".
      verb: item.displayText ? '' : item.kind === 'corner' ? `${verb} thread` : verb,
      ...(number && !item.displayText ? { number } : {}),
      title: item.displayText ? '' : item.title,
      ...(item.displayText ? { text: item.displayText } : {}),
      spoken,
      counted,
      ...(open ? { open } : {}),
    },
  };
}

/** A folded GitHub run's events, each at its own send time. */
function eventEntries(message: ChatDisplayMessage, counted: ReadonlySet<string>, handlers: PillHandlers): PillRunEntry[] {
  const sentAt = new Map((message.foldedReadBoundaries ?? []).map((boundary) => [boundary.id, boundary.orderAtMs]));
  return message.notificationLifecycleRun!.items.map((item) => {
    const at = sentAt.get(item.id);
    return eventEntry(item, ledgerStamp(at !== undefined ? at / 1_000 : message.timestamp), counted.has(item.id), handlers);
  });
}

/**
 * Consecutive pill messages (agent-to-agent messages, stops and GitHub events)
 * fold into one pill that opens as a list in send order. A lone message or
 * event keeps its own item. Anything else in the transcript ends the stretch.
 */
export function pillItems(run: readonly ChatDisplayMessage[], resolve: PillIdentityResolver, handlers: PillHandlers): PillItem[] {
  // A repeated webhook line for one PR event counts once across the whole run.
  const counted = countedLifecycleItemIds(run.flatMap((message) =>
    isGitHubEventRun(message) ? message.notificationLifecycleRun!.items : []));
  const entries: PillRunEntry[] = run.flatMap((message) => isGitHubEventRun(message)
    ? eventEntries(message, counted, handlers)
    : [pillItem(message, resolve, handlers)]);
  if (entries.length < 2) {
    return entries.map((entry) => ({ ...entry, system: Boolean(entry.system), body: entry.body ?? null }));
  }
  return [{ id: entries[0]!.id, system: entries.every(isNotice), from: entries[0]!.from, to: entries[0]!.to,
    time: entries.at(-1)!.time, run: entries, body: null }];
}

/** One transcript row of pills: a lone agent message, a stop, a GitHub event or a folded run. */
export function TranscriptPills({
  run,
  resolve,
  onOpenIdentity,
  onOpenUrl,
  onOpenBrief,
  onOpenCorner,
  cornerId,
}: {
  run: readonly ChatDisplayMessage[];
  resolve: PillIdentityResolver;
} & PillHandlers) {
  const items = useMemo(
    () => pillItems(run, resolve, { onOpenIdentity, onOpenUrl, onOpenBrief, onOpenCorner, cornerId }),
    [run, resolve, onOpenIdentity, onOpenUrl, onOpenBrief, onOpenCorner, cornerId],
  );
  return (
    // The ledger's bylined entry rhythm: 24 at a speaker change on both sides of the pills.
    <LedgerEntryFrame hasByline testID={`chat-message-${run[0]?.id ?? ''}`}>
      {/* Payment and wallet runs keep their own rows. */}
      {run.length === 1 && run[0]?.notificationLifecycleRun && !isGitHubEventRun(run[0]) ? (
        <NotificationLifecycleCard message={run[0]} cornerId={cornerId}
          onOpenCorner={onOpenCorner ?? (() => {})} onOpenUrl={onOpenUrl ?? (() => {})} />
      ) : <PillRow items={items} testID={`pill-row-${run[0]?.id ?? ''}`} />}
    </LedgerEntryFrame>
  );
}
