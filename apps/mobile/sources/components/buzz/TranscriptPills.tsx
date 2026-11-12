import React, { useMemo } from 'react';
import { YStack } from 'tamagui';
import { TypedView } from '@/ui/grammar';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { ledgerStamp } from '@/buzz/relative-time';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';
import { PillRow, type PillFace, type PillItem } from '@/ui/screens/transcript/PillRow';
import { LedgerSystemLine } from './Ledger';
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
  if (message.isSystemNotice || author === SYSTEM_IDENTITY_PUBKEY || !author) {
    return {
      id: message.id,
      system: true,
      from: BEELINE,
      to: systemTarget(message, resolve),
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
  const text = recipient
    ? `@${(recipient.handle ?? recipient.name).replace(/^@/, '')} ${message.agentCommand!.text}`
    : message.text;
  return {
    id: message.id,
    system: false,
    from: resolve(author, authorName, 'agent'),
    to,
    time,
    body: (
      // The settled agent-prose tone: body in ink.
      <TypedView view={MonoMarkdown} v="body" color="ink" markdown={text} testID={`pill-message-${message.id}`} />
    ),
  };
}

/** One transcript row of pills: a folded run, or a lone system/agent-to-agent message. */
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
    () => run.map((message) => pillItem(message, resolve, { onOpenIdentity, onOpenUrl, onOpenBrief, onOpenCorner, cornerId })),
    [run, resolve, onOpenIdentity, onOpenUrl, onOpenBrief, onOpenCorner, cornerId],
  );
  return (
    // The ledger's bylined entry rhythm: the speaker-change air on top.
    <YStack width="100%" minWidth={0} paddingTop="4" paddingBottom="2" testID={`chat-message-${run[0]?.id ?? ''}`}>
      {run.length === 1 && run[0]?.notificationLifecycleRun ? (
        <NotificationLifecycleCard message={run[0]} cornerId={cornerId}
          onOpenCorner={onOpenCorner ?? (() => {})} onOpenUrl={onOpenUrl ?? (() => {})} />
      ) : <PillRow items={items} testID={`pill-row-${run[0]?.id ?? ''}`} />}
    </YStack>
  );
}
