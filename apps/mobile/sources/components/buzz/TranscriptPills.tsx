import React, { useMemo } from 'react';
import { TypedView } from '@/ui/grammar';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { ledgerStamp } from '@/buzz/relative-time';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';
import { stopNotice } from '@/buzz/transcript-pills';
import { isNotice, PillRow, type PillFace, type PillItem } from '@/ui/screens/transcript/PillRow';
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

function pillItem(message: ChatDisplayMessage, resolve: PillIdentityResolver, handlers: PillHandlers): PillItem {
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

/**
 * Consecutive pill messages (agent-to-agent messages, stops and system
 * notices) fold into one pill that opens as a list in send order. A lone
 * message keeps its own pill. Anything else in the transcript ends the stretch.
 */
export function pillItems(run: readonly ChatDisplayMessage[], resolve: PillIdentityResolver, handlers: PillHandlers): PillItem[] {
  const entries = run.map((message) => pillItem(message, resolve, handlers));
  if (entries.length < 2) return entries;
  return [{ id: entries[0]!.id, system: entries.every(isNotice), from: entries[0]!.from, to: entries[0]!.to,
    time: entries.at(-1)!.time, run: entries, body: null }];
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
