import React, { useMemo } from 'react';
import { TypedView } from '@/ui/grammar';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { ledgerStamp } from '@/buzz/relative-time';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';
import { isAgentRunStep, stopNotice } from '@/buzz/transcript-pills';
import { PillRow, type PillFace, type PillItem } from '@/ui/screens/transcript/PillRow';
import { LedgerEntryFrame, LedgerSystemLine } from './Ledger';
import { MonoMarkdown } from './MonoMarkdown';
import { NotificationLifecycleCard } from './PrLifecycleCard';

const BEELINE: PillFace = { kind: 'system', name: 'Beeline' };

/** Who a pubkey is, for a pill face: the roster's agent or person, by id. */
export type PillIdentityResolver = (id: string, name: string, kind?: 'agent' | 'human') => PillFace;

function systemTarget(message: ChatDisplayMessage, resolve: PillIdentityResolver): PillFace | undefined {
  const subject = message.systemEvent?.subject;
  if (!subject?.id || (subject.kind !== 'person' && subject.kind !== 'agent')) return undefined;
  return resolve(subject.id, subject.name, subject.kind === 'agent' ? 'agent' : 'human');
}

type PillHandlers = {
  onOpenIdentity?: (id: string) => void;
  onOpenUrl?: (url: string) => void;
  onOpenBrief?: () => void;
  onOpenCorner?: (cornerId: string) => void;
  /** The open corner, when the transcript is a thread. */
  cornerId?: string;
};

function pillItem(message: ChatDisplayMessage, resolve: PillIdentityResolver, handlers: PillHandlers, inRun = false): PillItem {
  const time = ledgerStamp(message.timestamp);
  const author = message.authorIdentity?.pubkey ?? message.pubkey;
  const stop = stopNotice(message);
  // A message() to an agent keeps its sender's face even when stored as a system notice.
  const agentMessage = message.agentCommand?.recipient.kind === 'agent' && author && author !== SYSTEM_IDENTITY_PUBKEY;
  if (stop || (!agentMessage && (message.isSystemNotice || author === SYSTEM_IDENTITY_PUBKEY || !author))) {
    return {
      id: message.id,
      system: true,
      ...(stop
        // A stop is the stopper's face, the stop glyph and the stopped agent's face; the line itself opens on tap.
        ? { stop: true, from: resolve(stop.stopper.id, stop.stopper.name, stop.stopper.kind),
          to: resolve(stop.stopped.id, stop.stopped.name, 'agent') }
        : { from: BEELINE, to: systemTarget(message, resolve), summary: message.text }),
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
  const authorName = message.authorIdentity?.name ?? '';
  const recipient = message.agentCommand?.recipient;
  const firstMention = message.mentionPubkeys?.[0];
  const to = recipient
    ? resolve(recipient.id, recipient.name, 'agent')
    : firstMention ? resolve(firstMention, '', 'agent') : undefined;
  // Inside an opened run the face → face heading already names the recipient.
  const text = recipient
    ? inRun ? message.agentCommand!.text : `@${(recipient.handle ?? recipient.name).replace(/^@/, '')} ${message.agentCommand!.text}`
    : message.text;
  return {
    id: message.id,
    system: false,
    from: resolve(author, authorName, 'agent'),
    to,
    time,
    body: (
      // The settled agent-prose tone: body in ink; a run's messages read one step quieter.
      <TypedView view={MonoMarkdown} v="body" color={inRun ? 'secondary' : 'ink'} markdown={text} testID={`pill-message-${message.id}`} />
    ),
  };
}

/**
 * Consecutive agent run steps (agent-to-agent messages and agent stops) fold
 * into one pill that opens as a list in send order. Consecutive system notices
 * (person stops included) fold the same way. A lone step or notice keeps its own pill.
 */
export function pillItems(run: readonly ChatDisplayMessage[], resolve: PillIdentityResolver, handlers: PillHandlers): PillItem[] {
  const items: PillItem[] = [];
  let steps: ChatDisplayMessage[] = [];
  let notices: PillItem[] = [];
  const fold = (entries: readonly PillItem[], system: boolean) => {
    if (entries.length > 1) {
      items.push({ id: entries[0]!.id, system, from: entries[0]!.from, to: entries[0]!.to,
        time: entries.at(-1)!.time, run: entries, body: null });
    } else items.push(...entries);
  };
  const flushSteps = () => {
    fold(steps.length > 1 ? steps.map((message) => pillItem(message, resolve, handlers, true))
      : steps.map((message) => pillItem(message, resolve, handlers)), false);
    steps = [];
  };
  const flushNotices = () => { fold(notices, true); notices = []; };
  for (const message of run) {
    if (isAgentRunStep(message)) { flushNotices(); steps.push(message); continue; }
    flushSteps();
    const item = pillItem(message, resolve, handlers);
    if (item.system) { notices.push(item); continue; }
    flushNotices();
    items.push(item);
  }
  flushSteps();
  flushNotices();
  return items;
}

/** One transcript row of pills: system lines, lone agent messages, stops and folded agent runs. */
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
      {run.length === 1 && run[0]?.notificationLifecycleRun ? (
        <NotificationLifecycleCard message={run[0]} cornerId={cornerId}
          onOpenCorner={onOpenCorner ?? (() => {})} onOpenUrl={onOpenUrl ?? (() => {})} />
      ) : <PillRow items={items} testID={`pill-row-${run[0]?.id ?? ''}`} />}
    </LedgerEntryFrame>
  );
}
