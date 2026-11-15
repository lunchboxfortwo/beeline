import React, { useEffect, useState } from 'react';
import { NotificationLifecycleCard } from '@/components/buzz/PrLifecycleCard';
import { CHOICE_NOTE_MAX_LENGTH, formatChoiceClock } from '@beeline/api-contract/phone';
import type { AgentPresentation, ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { connectorOfferWaitingLine } from '@/buzz/connector-offer-copy';
import { AppMark } from '@/components/buzz/AppMark';
import { INSTAGRAM_SIGN_IN_REQUIREMENT } from '@/buzz/app-sign-in-copy';
import { ledgerStamp } from '@/buzz/relative-time';
import { approvalSentence, squireApprovalAction } from '@beeline/api-contract/phone';
import { AgentApprovalCard, approvalAudience, approvalDecisionNote } from '@/components/buzz/AgentApprovalCard';
import { openExternalUrl } from '@/utils/open-external-url';
import { RequestMedia } from '@/ui/screens/transcript/cards/RequestMedia';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { TranscriptCard, type TranscriptCardAction, type TranscriptCardChoice } from '@/components/buzz/TranscriptCard';
import { OrdinaryLedgerMessageProps, ConnectorReceiptCard } from './RoomMessageVariants-attachment-card';
import { OrdinaryLedgerMessage } from './RoomMessageVariants-ordinary-ledger-message';



type WriteDecision = 'allow' | 'deny';


export interface WritePermissionCardProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  viewerIsAgent: boolean;
  viewerPubkey: string;
  /** The server's Workspace owner/admin decision (`viewer.permissions.manage`). */
  viewerCanManage?: boolean;
  actionId: string | null;
  targetBranch?: string;
  roomName?: string;
  onDecision(message: ChatDisplayMessage, decision: WriteDecision): void;
  onOpenCorner(cornerId: string): void;
}


export const WritePermissionCard = React.memo(function WritePermissionCard({
  message,
  agent,
  viewerIsAgent,
  viewerPubkey,
  viewerCanManage = false,
  actionId,
  targetBranch,
  roomName,
  onDecision,
  onOpenCorner,
}: WritePermissionCardProps) {
  const permission = message.writePermission!;
  const squireSpending = permission.purpose === 'squire-spending';
  const display = resolveAgentDisplayIdentity(permission.agentPubkey, agent);
  const pending = permission.status === 'pending';
  const busy = actionId === permission.permissionId;
  // Squire spending is the spending agent's owner's call alone (the server
  // names them on the card); other write requests go to the requester or a
  // Workspace owner or admin, the same rule `decidePermission` enforces.
  const canDecide =
    !viewerIsAgent &&
    (squireSpending
      ? Boolean(permission.ownerPubkey) && viewerPubkey === permission.ownerPubkey
      : viewerPubkey === permission.requesterPubkey || viewerCanManage);
  const footerNote = pending
    ? !permission.repository ? 'missing target' : !canDecide ? squireSpending ? 'waiting for its owner' : 'waiting for the requester or a workspace admin' : undefined
    : approvalDecisionNote(permission.status, permission.decider, permission.decidedAt ?? message.timestamp, viewerPubkey);
  const actions: TranscriptCardAction[] =
    pending && canDecide && permission.repository
      ? [
          {
            label: 'Approve',
            primary: true,
            disabled: busy,
            loading: busy,
            onPress: () => onDecision(message, 'allow'),
            testID: 'write-permission-allow',
          },
          {
            label: 'Deny',
            secondary: true,
            disabled: busy,
            onPress: () => onDecision(message, 'deny'),
            testID: 'write-permission-deny',
          },
        ]
      : !pending && permission.status === 'allowed' && permission.subchannelId
        ? [
            {
              label: 'Open',
              accessibilityRole: 'link',
              onPress: () => onOpenCorner(permission.subchannelId!),
              testID: 'write-permission-open-corner',
            },
          ]
        : [];
  return (
    <AgentApprovalCard
      tier={pending ? 'ask' : 'record'} testID={`write-permission-${permission.status}`} wrapTitle
      askingAgent={{ pubkey: permission.agentPubkey, kind: 'agent', name: display.name }} agent={agent}
      title={approvalSentence(permission.action ?? (squireSpending ? 'Spend with Trusty Squire' : 'Open an edit thread'), permission.approvalPurpose ?? permission.reason)}
      subline={`${squireSpending ? roomName ? `#${roomName}` : 'Chat' : permission.repository ?? 'Repository'} · ${approvalAudience(permission.requester, viewerPubkey)}`}
      stamp={ledgerStamp(message.timestamp)} body={permission.reason}
      media={pending ? <RequestMedia message={message} /> : undefined}
      facts={squireSpending ? [{ label: 'Uses', value: permission.tool }]
        : [{ label: 'Repository', value: permission.repository ?? 'Missing target' }, { label: 'Branch from', value: targetBranch ?? 'main' }]}
      footerNote={footerNote} decisionNote={!pending}
      footerNoteTestID={pending && permission.repository && !canDecide ? 'brief-approval-audience-wait' : undefined}
      footerNoteTone={permission.status === 'failed' || (pending && !permission.repository) ? 'failed' : 'quiet'}
      actions={actions}
    />
  );
});


export interface SquireApprovalCardProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  viewerPubkey?: string;
  onOpenSource?(roomId: string, messageId: string): void;
}


/**
 * A notification, not an authority surface: the primary action opens the
 * exact page Squire returned, where Squire's own passkey policy decides it.
 */
export const SquireApprovalCard = React.memo(function SquireApprovalCard({
  message, agent, viewerPubkey, onOpenSource,
}: SquireApprovalCardProps) {
  const approval = message.squireApproval!;
  const settled = Boolean(approval.status);
  const reference = approval.reference ?? approval.detail.match(/vault:\/\/[^\s·]+/)?.[0];
  const parts = approval.detail.split(' · ');
  const facts = approval.facts ?? (approval.tool === 'inject_card'
    ? [{ label: 'From', value: parts[1]?.replace(/^at /, '') || 'Checkout' }, ...(parts[2] ? [{ label: 'Amount', value: parts[2] }] : [])]
    : [{ label: approval.tool === 'operate_login' ? 'Site' : 'Key', value: reference ? 'Saved credential' : parts[0]?.replace(/^(Reveal|Edit|Delete|Sign in to) /, '') || 'Saved credential' },
      ]);
  const actions: TranscriptCardAction[] = [];
  if (approval.sourceRoomId && approval.sourceMessageId && onOpenSource) actions.push({
    label: 'View request', accessibilityRole: 'link',
    onPress: () => onOpenSource(approval.sourceRoomId!, approval.sourceMessageId!), testID: 'squire-approval-source',
  });
  // Approve opens the exact page Squire returned; Squire's own passkey decides there.
  // Only the owner receives the page; other Room members read the ask.
  const approvalUrl = approval.approvalUrl;
  if (!settled && approvalUrl) actions.push({ label: 'Approve', primary: true,
    accessibilityRole: 'link', destination: 'external', onPress: () => void openExternalUrl(approvalUrl), testID: 'squire-approval-open' });
  return <AgentApprovalCard tier={settled ? 'record' : 'ask'} testID="squire-approval-card" wrapTitle
    askingAgent={approval.agent} agent={agent}
    title={approvalSentence(approval.action ?? squireApprovalAction(approval.tool, approval.detail, approval.linkKind), approval.purpose ?? approval.reason)}
    subline={`${approval.tool === 'Link' ? 'Link' : 'Trusty Squire'} · ${approvalAudience(approval.owner, viewerPubkey)}`}
    sublineTestID="squire-approval-detail" stamp={ledgerStamp(message.timestamp)}
    body={approval.reason} media={settled ? undefined : <RequestMedia message={message} />} facts={facts} foldCode codeLabel="vault reference" code={reference} codePath={reference ? 'vault reference' : undefined}
    footerNote={approval.status ? approvalDecisionNote(approval.status, approval.decidedBy, approval.decidedAt ?? message.timestamp, viewerPubkey, approval.action ?? squireApprovalAction(approval.tool, approval.detail, approval.linkKind)) : undefined}
    decisionNote={settled} actions={actions} />;
});


export interface ConnectorOfferCardProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  viewerIsAgent: boolean;
  viewerPubkey: string;
  /** The server's Workspace owner/admin decision (`viewer.permissions.manage`). */
  viewerCanManage?: boolean;
  /** The offer whose acceptance is in flight. */
  actionId: string | null;
  onAccept(
    offerId: string,
    connectorType: NonNullable<ChatDisplayMessage['connectorOffer']>['connectorType'],
  ): void;
  /** Reopens an accepted ceremony that has not reached connected yet. */
  onContinue?(
    offerId: string,
    connectorType: NonNullable<ChatDisplayMessage['connectorOffer']>['connectorType'],
    connectorId: string,
  ): void;
  /** Opens the Workbench page — the settled card is one of its three remaining doors. */
  onOpenWorkbench(): void;
  onOpenReplacement(messageId: string): void;
  onDecline?(offerId: string): void;
}


export function AppSignInCard({ message, agentName, canConnect, onConnect, busy }: {
  message: ChatDisplayMessage;
  agentName: string;
  canConnect: boolean;
  onConnect: () => void;
  busy: boolean;
}) {
  const app = message.appSignIn!;
  if (app.status === 'connected')
    return (
      <TranscriptCard tier="record" title={`${app.name} connected · ${agentName} continues`}
        identity={<AppMark name={app.name} domain={app.domain} logo={app.logo} size={28} />}
        testID={`app-sign-in-${app.appKey}-connected`} />
    );
  return (
    <TranscriptCard
      tier="ask"
      wrapTitle
      title={approvalSentence(app.action ?? `Connect ${app.name}`, app.purpose)}
      testID={`app-sign-in-${app.appKey}`}
      body={`Sign in once. ${app.continuation ?? `${agentName} continues the request right after.`}${app.appKey === 'instagram' ? `\n${INSTAGRAM_SIGN_IN_REQUIREMENT}` : ''}`}
      inlineError={app.status === 'failed' ? { title: app.errorMessage ?? 'App sign-in failed. Try again.' } : undefined}
      footerNote={canConnect ? undefined : `Waiting for the account owner to connect ${app.name}.`}
      actions={canConnect ? [{
        label: busy ? 'Connecting' : app.status === 'failed' ? `Retry ${app.name}` : `Connect ${app.name}`,
        primary: true,
        disabled: busy,
        loading: busy,
        onPress: onConnect,
        testID: `app-sign-in-${app.appKey}-connect`,
      }] : []}
    />
  );
}


export const ConnectorOfferCard = React.memo(function ConnectorOfferCard({
  message,
  agent,
  viewerIsAgent,
  viewerPubkey,
  viewerCanManage = false,
  actionId,
  onAccept,
  onContinue,
  onOpenWorkbench,
  onOpenReplacement,
  onDecline,
}: ConnectorOfferCardProps) {
  const offer = message.connectorOffer!;
  const pending = offer.status === 'pending';
  const failed = offer.status === 'failed';
  const connecting = offer.status === 'connecting';
  const canAccept =
    !viewerIsAgent &&
    (viewerPubkey === offer.addressee.pubkey || viewerCanManage);
  const busy = actionId === offer.offerId;
  const actions: TranscriptCardAction[] =
    (pending || failed) && canAccept
      ? [
          {
            label: failed ? offer.replacementMessageId ? 'Open current card' : 'Retry' : 'Approve',
            primary: true,
            disabled: actionId !== null,
            loading: busy,
            onPress: () => offer.replacementMessageId
              ? onOpenReplacement(offer.replacementMessageId)
              : onAccept(offer.offerId, offer.connectorType),
            testID: `connector-offer-${offer.offerId}-accept`,
          },
        ]
      : connecting && canAccept && (offer.intent !== 'reconnect' || viewerPubkey === offer.addressee.pubkey) && offer.connectorId && onContinue
        ? [
            {
              label: 'Continue sign-in',
              primary: true,
              onPress: () => onContinue(offer.offerId, offer.connectorType, offer.connectorId!),
              testID: `connector-offer-${offer.offerId}-continue`,
            },
          ]
        : !pending && !connecting
          ? [
              {
                label: 'Manage',
                accessibilityRole: 'link',
                onPress: onOpenWorkbench,
                testID: `connector-offer-${offer.offerId}-workbench`,
              },
            ]
          : [];
  return (
    <AgentApprovalCard
      tier={pending || connecting ? 'ask' : 'record'}
      testID={`connector-offer-${pending ? 'pending' : connecting ? 'connecting' : 'settled'}`} wrapTitle
      askingAgent={offer.agent} agent={agent}
      title={approvalSentence(offer.action ?? `${offer.intent === 'reconnect' ? 'Reconnect' : offer.intent === 'switch' ? 'Switch' : 'Connect'} ${offer.connectorName}`, offer.purpose ?? offer.reason)}
      subline={offer.addressee.pubkey === viewerPubkey ? undefined : approvalAudience(offer.addressee, viewerPubkey)}
      sublineTestID={`connector-offer-${offer.offerId}-line`} body={offer.reason}
      facts={offer.connectorType === 'trusty-squire'
        ? [{ label: 'Can', value: 'Sign in to sites · use vault keys' }]
        : offer.connectorType === 'wallet'
          ? [{ label: 'Can', value: 'Sign transactions with your wallet' }]
          : undefined}
      decisionNote={!pending && !connecting}
      stamp={ledgerStamp(message.timestamp)}
      footerNote={
        connecting
          ? (offer.intent === 'reconnect' && !offer.acceptedBy ? 'Reconnecting…' : undefined)
          : pending
            ? canAccept
              ? undefined
              : connectorOfferWaitingLine(offer)
            : failed ? offer.replacementMessageId ? 'This card was replaced. Use the current connection card.' : 'Connection failed. Retry to continue.' : approvalDecisionNote(offer.status === 'denied' ? 'denied' : 'allowed', offer.acceptedBy, offer.acceptedAt ?? message.timestamp, viewerPubkey)
      }
      footerNoteTestID={
        connecting
          ? `connector-offer-${offer.offerId}-connecting`
          : pending
            ? canAccept
              ? undefined
              : `connector-offer-${offer.offerId}-waiting`
            : `connector-offer-${offer.offerId}-outcome`
      }
      actions={pending && canAccept && onDecline ? [...actions, { label: 'Deny', secondary: true, onPress: () => onDecline(offer.offerId), testID: `connector-offer-${offer.offerId}-deny`, disabled: actionId !== null }] : actions}
    />
  );
});


export interface ChoiceCardProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  viewerIsAgent: boolean;
  viewerPubkey: string;
  actionId: string | null;
  onAnswer(choiceId: string, optionId: string, note?: string): void;
  onSkip(choiceId: string): void;
}


function choiceHandle(identity?: { handle?: string; name: string; pubkey: string }): string {
  const handle = identity?.handle?.replace(/^@/, '');
  return handle || identity?.name?.replace(/^@/, '') || 'someone';
}


/**
 * One choice family: lettered plates for a question or a poll. Skip is a footer
 * word on an open question. Settled questions show their decision without
 * option plates. Closed polls retain their vote results in a still brass wash.
 */
export const ChoiceCard = React.memo(function ChoiceCard({
  message,
  agent,
  viewerIsAgent,
  viewerPubkey,
  actionId,
  onAnswer,
  onSkip,
}: ChoiceCardProps) {
  const card = message.choice!;
  const display =
    card.agent.kind === 'agent' ? resolveAgentDisplayIdentity(card.agent.pubkey, agent) : null;
  const agentName = display && agent ? display.name : card.agent.name;
  const open = card.status === 'open';
  const viewerVote = card.responses.find((response) => response.identityId === viewerPubkey);
  const canAct =
    open && !viewerIsAgent && (card.mode === 'question' || card.electorate.includes(viewerPubkey));
  const busy = actionId === card.choiceId;
  // Only a workflow gate takes a note; its outcome still comes from the pick.
  const takesNote = canAct && card.mode === 'question' && !!card.runId;
  const [note, setNote] = React.useState('');
  const answer = (optionId: string) =>
    takesNote && note.trim()
      ? onAnswer(card.choiceId, optionId, note.trim())
      : onAnswer(card.choiceId, optionId);
  const turnout = `${card.votedCount} of ${card.electorateCount} voted`;
  const clock = open && card.closesAt ? `closes ${formatChoiceClock(card.closesAt)}` : undefined;
  const subline =
    card.mode === 'poll'
      ? [clock, turnout].filter(Boolean).join(' · ')
      : open
        ? [card.constraint, clock].filter(Boolean).join(' · ') || undefined
        : undefined;
  const selectedOption = card.options.find((option) => option.optionId === card.selectedOptionId);
  const decision = card.footer ||
    (card.status === 'answered'
      ? `picked ${card.selectedOptionId ?? ''} · @${choiceHandle(card.answeredBy)}`
      : card.status === 'skipped'
        ? 'Skipped'
        : card.mode === 'question' ? 'Closed · no longer waiting for an answer' : undefined);
  const footer = card.mode === 'question' && card.status === 'answered' && selectedOption
    ? `${selectedOption.label} · ${decision}`
    : decision;
  const choices: TranscriptCardChoice[] = (!open && card.mode === 'question' ? [] : card.options).map((option) => ({
    id: option.optionId,
    letter: option.letter,
    label: option.label,
    consequence: option.consequence === option.label ? '' : option.consequence,
    costly: option.costly,
    votes: option.votes,
    share: option.share,
    leader: option.leader,
    selected: viewerVote?.optionId === option.optionId || card.selectedOptionId === option.optionId,
    ...(canAct && card.mode === 'poll'
      ? { onPress: () => answer(option.optionId) }
      : canAct && card.mode === 'question' && !busy
        ? { onPress: () => answer(option.optionId) }
        : {}),
  }));
  const actions: TranscriptCardAction[] =
    canAct && card.mode === 'question'
      ? [
          {
            label: 'Skip',
            dismiss: true,
            disabled: busy,
            onPress: () => onSkip(card.choiceId),
            testID: `choice-${card.choiceId}-skip`,
          },
        ]
      : [];
  return (
    <TranscriptCard
      tier={open ? 'ask' : 'record'}
      testID={`choice-${card.choiceId}`}
      identity={
        <IdentityMark
          kind={card.agent.kind}
          seed={display?.avatarSeed ?? card.agent.pubkey}
          avatarUrl={display?.avatarUrl ?? card.agent.avatar}
          face={display?.face ?? card.agent.face}
          name={agentName}
          size={26}
        />
      }
      title={card.prompt}
      wrapTitle
      subline={subline}
      sublineTestID={`choice-${card.choiceId}-subline`}
      stamp={ledgerStamp(message.timestamp)}
      choices={choices}
      noteInput={
        takesNote
          ? {
              value: note,
              onChangeText: setNote,
              placeholder: 'Add a note (optional)',
              maxLength: CHOICE_NOTE_MAX_LENGTH,
              editable: !busy,
              testID: `choice-${card.choiceId}-note`,
            }
          : undefined
      }
      footerNote={
        open
          ? busy ? 'Sending decision…' : undefined
          : footer
      }
      footerNoteTestID={`choice-${card.choiceId}-footer`}
      actions={actions}
    />
  );
});


/**
 * The @wallet thread's cards: every transaction, the one refusal, and the
 * delegation grant. The @wallet line itself already carries the ledger
 * prose; the card is the structured layer on top (mock §The @wallet thread).
 */
export const WalletCards = React.memo(function WalletCards({
  message,
  stamp,
}: {
  message: ChatDisplayMessage;
  stamp: string;
}) {
  const tx = message.walletTx;
  const refusal = message.walletInsufficient;
  const delegation = message.walletDelegation;
  const walletIdentity = message.authorIdentity;
  const identity = (
    <IdentityMark
      kind="human"
      seed={walletIdentity?.pubkey ?? 'wallet'}
      name={walletIdentity?.name ?? 'Wallet'}
      avatarUrl={walletIdentity?.avatar}
      face={walletIdentity?.face}
      size={26}
    />
  );
  if (tx) {
    const actor = tx.agentName ? `@${tx.agentName.replace(/^@/, '')}` : 'You';
    return (
      <TranscriptCard
        tier="record"
        identity={identity}
        title={
          tx.direction === 'out' ? `${actor} sent ${tx.amountText}` : `Received ${tx.amountText}`
        }
        subline={`${tx.counterparty} · ${tx.chain} · ${tx.balanceAfterUsd} left`}
        sublineTestID="wallet-tx-subline"
        stamp={stamp}
        testID={`wallet-tx-${tx.direction}`}
      />
    );
  }
  if (refusal) {
    const actor = refusal.agentName ? `@${refusal.agentName.replace(/^@/, '')}` : 'You';
    return (
      <TranscriptCard
        tier="record"
        identity={identity}
        title={
          refusal.reason ? `${actor} could not pay · ${refusal.reason}` : `${actor} could not pay`
        }
        subline={`Needed ${refusal.needed} ${refusal.asset} on ${refusal.chain}${
          refusal.available ? ` · ${refusal.available} available` : ''
        }`}
        sublineTestID="wallet-insufficient-subline"
        stamp={stamp}
        testID="wallet-insufficient"
      />
    );
  }
  if (delegation) {
    return (
      <TranscriptCard
        tier="record"
        identity={identity}
        title="Granted agents permission to sign"
        subline={
          'standing' in delegation
            ? 'Stands until revoked'
            : `Until ${new Date(delegation.expiresAt).toLocaleString()} · renews in the app`
        }
        sublineTestID="wallet-delegation-subline"
        stamp={stamp}
        testID="wallet-delegation"
      />
    );
  }
  return null;
});


export { agentCommandTranscriptMessage } from '@/buzz/agent-command-transcript';


export interface TargetBranchProposalCardProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  currentTargetBranch?: string;
  canManageWorkspace: boolean;
  viewerIsAgent: boolean;
  actionId: string | null;
  notice: string | null;
  onConfirm(message: ChatDisplayMessage): void;
  onDeny?(message: ChatDisplayMessage): void;
  viewerPubkey?: string;
  roomName?: string;
}


export const TargetBranchProposalCard = React.memo(function TargetBranchProposalCard({
  message,
  agent,
  currentTargetBranch,
  canManageWorkspace,
  viewerIsAgent,
  actionId,
  notice,
  onConfirm, onDeny, viewerPubkey, roomName,
}: TargetBranchProposalCardProps) {
  const proposal = message.targetBranchProposal!;
  const applied = proposal.status === 'allowed' || currentTargetBranch === proposal.to;
  const settled = applied || proposal.status === 'denied';
  const busy = actionId === proposal.proposalId;
  const canConfirm = !viewerIsAgent && canManageWorkspace;
  const askingAgent = proposal.agentPubkey
    ? resolveAgentDisplayIdentity(proposal.agentPubkey, agent).name.replace(/^@/, '')
    : undefined;
  return (
    <AgentApprovalCard tier={settled ? 'record' : 'ask'} testID="target-branch-proposal" wrapTitle
      askingAgent={{ pubkey: proposal.agentPubkey ?? '', kind: 'agent', name: askingAgent ?? 'Agent' }} agent={agent}
      title={`@${askingAgent ?? 'Agent'} wants to change the target branch`}
      subline={`${roomName ? `#${roomName}` : proposal.repository ?? 'Chat'} · for you`}
      stamp={ledgerStamp(message.timestamp)} body={proposal.purpose}
      facts={[{ label: 'From', value: proposal.from }, { label: 'To', value: proposal.to }]}
      footerNote={settled ? approvalDecisionNote(proposal.status ?? 'allowed', proposal.decidedBy, proposal.decidedAt ?? message.timestamp, viewerPubkey) : canConfirm ? notice ?? undefined : 'waiting for a Workspace manager'}
      decisionNote={settled}
      actions={!settled && canConfirm ? [
        { label: 'Approve', primary: true, loading: busy, disabled: busy, onPress: () => onConfirm(message), testID: 'target-branch-confirm' },
        ...(onDeny ? [{ label: 'Deny', secondary: true, disabled: busy, onPress: () => onDeny(message), testID: 'target-branch-deny' }] : []),
      ] : []} />
  );
});
export { GitHubEventCard, DaemonFactCard } from '@/components/buzz/LifecycleCard';
export { NotificationLifecycleCard };
export { GrantRequestCard, type GrantDecision, type GrantRequestCardProps } from '@/components/buzz/GrantRequestCard';
export type { OrdinaryLedgerMessageProps } from './RoomMessageVariants-attachment-card';
export { ConnectorReceiptCard } from './RoomMessageVariants-attachment-card';
export { OrdinaryLedgerMessage } from './RoomMessageVariants-ordinary-ledger-message';
