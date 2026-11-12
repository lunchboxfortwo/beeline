import React, { useMemo } from 'react';
import { YStack } from 'tamagui';
import { T } from '@/ui/grammar';
import { PillRow, type PillFace, type PillItem } from '@/ui/screens/transcript/PillRow';
import { RequestMedia } from '@/ui/screens/transcript/cards/RequestMedia';
import { AGENT_GRANT_VERBS, grantPresentation } from '@beeline/api-contract/agent-grants';
import type { AgentPresentation, ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { ledgerStamp } from '@/buzz/relative-time';
import { AgentApprovalCard, approvalAudience, approvalDecisionNote } from './AgentApprovalCard';
import { type TranscriptCardAction } from './TranscriptCard';
import { LedgerEntryFrame } from './Ledger';

export type GrantDecision = 'always' | 'once' | 'deny';

export interface GrantRequestCardProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  viewerIsAgent: boolean;
  viewerPubkey: string;
  /** The server's Workspace owner/admin decision (`viewer.permissions.manage`). */
  viewerCanManageWorkspace?: boolean;
  actionId: string | null;
  onDecision(grantId: string, decision: GrantDecision): void;
  onOpenSource?(roomId: string, messageId: string): void;
}

/**
 * Whether this viewer is the request's target: the one person (or, for a
 * repository, a Workspace manager) who can answer it. The server enforces the
 * same rule on every decision (`phoneRequireGrantAuthority`).
 */
export function canDecideGrantRequest(
  request: NonNullable<ChatDisplayMessage['grantRequest']>,
  viewerPubkey: string,
  viewerIsAgent: boolean,
  viewerCanManageWorkspace: boolean,
): boolean {
  if (viewerIsAgent) return false;
  if (request.grants.every((grant) => grant.kind === 'repository')) return viewerCanManageWorkspace;
  if (request.grants.every((grant) => grant.kind === 'shared_asset'))
    return viewerCanManageWorkspace || viewerPubkey === request.owner.pubkey;
  return viewerPubkey === request.owner.pubkey;
}

/** One grant request across DMs, Rooms, System, web and desktop. */
export const GrantRequestCard = React.memo(function GrantRequestCard({
  message,
  agent,
  viewerIsAgent,
  viewerPubkey,
  viewerCanManageWorkspace = false,
  actionId,
  onDecision,
  onOpenSource,
}: GrantRequestCardProps) {
  const request = message.grantRequest!;
  const display = resolveAgentDisplayIdentity(request.agent.pubkey, agent);
  // The server names the asking agent on the card; a loaded roster presentation
  // (soul name) wins once it exists, never a fallback placeholder.
  const agentName = agent ? display.name : request.agent.name;
  const repositoryRequest = request.grants.every((grant) => grant.kind === 'repository');
  const sharedAssetRequest = request.grants.every((grant) => grant.kind === 'shared_asset');
  const canDecide = canDecideGrantRequest(request, viewerPubkey, viewerIsAgent, viewerCanManageWorkspace);
  const anyPending = request.grants.some((grant) => grant.status === 'pending');
  return (
    <YStack testID={`grant-request-${anyPending ? 'pending' : 'settled'}`}>
      {request.grants.map((grant) => {
        const script = grant.script?.contents ?? (grant.kind === 'command' ? grant.target : undefined);
        const { purpose, facts } = grantPresentation(grant);
        const scope = grant.status === 'once' ? 'Once' : grant.status === 'approved' ? 'Always' : undefined;
        const busy = actionId === grant.grantId;
        const pendingGrant = grant.status === 'pending';
        const actions: TranscriptCardAction[] =
          pendingGrant && canDecide
            ? [
                {
                  label: grant.kind === 'command' ? 'Always' : 'Approve',
                  primary: true,
                  disabled: actionId !== null,
                  loading: busy,
                  onPress: () => onDecision(grant.grantId, 'always'),
                  testID: `grant-${grant.grantId}-always`,
                },
                ...(!sharedAssetRequest ? [{
                  label: 'Once',
                  secondary: true,
                  disabled: actionId !== null,
                  onPress: () => onDecision(grant.grantId, 'once'),
                  testID: `grant-${grant.grantId}-once`,
                }] : []),
                {
                  label: 'Deny',
                  secondary: true,
                  disabled: actionId !== null,
                  onPress: () => onDecision(grant.grantId, 'deny'),
                  testID: `grant-${grant.grantId}-deny`,
                },
              ]
            : [];
        if (request.sourceRoomId && request.sourceMessageId && onOpenSource) {
          actions.push({
            label: 'View request',
            accessibilityRole: 'link',
            onPress: () => onOpenSource(request.sourceRoomId!, request.sourceMessageId!),
            testID: `grant-${grant.grantId}-source`,
          });
        }
        return (
          <AgentApprovalCard
            key={grant.grantId}
            tier={pendingGrant ? 'ask' : 'record'}
            testID={`grant-${grant.grantId}`}
            askingAgent={request.agent}
            agent={agent}
            wrapTitle
            title={
              <T v="heading" testID={`grant-${grant.grantId}-ask`}>
                {`@${agentName.replace(/^@/, '')} wants to ${grant.kind === 'command' ? grant.purpose || grant.script ? 'run a script' : 'run a command' : `${grant.kind === 'mcp' && grant.target.startsWith('connection-install:') ? 'connect' : AGENT_GRANT_VERBS[grant.kind]} ${grant.appName ?? grant.target}`}`}
              </T>
            }
            stamp={ledgerStamp(message.timestamp)}
            subline={`${grant.machine ? `${grant.machine} · ` : ''}${approvalAudience(request.owner, viewerPubkey)}`}
            body={purpose}
            media={pendingGrant ? <RequestMedia message={message} /> : undefined}
            facts={facts}
            foldCode
            code={script}
            codeLabel={!grant.purpose && !grant.script && grant.kind === 'command' ? 'command' : undefined}
            codeTestID={script !== undefined ? `grant-${grant.grantId}-script` : undefined}
            codePath={grant.script?.path}
            footerNote={
              pendingGrant
                ? busy
                  ? 'Sending decision…'
                  : canDecide
                  ? undefined
                  : repositoryRequest
                    ? 'waiting for a Workspace admin'
                    : sharedAssetRequest
                      ? 'waiting for a Workspace manager or the agent owner'
                    : `waiting for @${request.owner.name.replace(/^@/, '')}`
                : approvalDecisionNote(grant.status, grant.decidedBy, grant.decidedAt ?? message.timestamp, viewerPubkey)
            }
            decisionNote={!pendingGrant}
            decisionScope={scope}
            footerNoteTone={
              grant.status === 'denied' || grant.status === 'revoked' ? 'failed' : 'quiet'
            }
            footerNoteTestID={!pendingGrant ? `grant-${grant.grantId}-outcome` : undefined}
            actions={actions}
          />
        );
      })}
    </YStack>
  );
});

/**
 * A permission request seen by someone who cannot answer it: a collapsed
 * system pill (asking agent → the person who decides) whose card opens
 * read-only. Only the request's target sees the card with its controls.
 */
export function GrantRequestPill({ message, resolve, card }: {
  message: ChatDisplayMessage;
  resolve: (id: string, name: string, kind: 'agent' | 'human') => PillFace;
  card: React.ReactNode;
}) {
  const request = message.grantRequest!;
  const items = useMemo<PillItem[]>(() => [{
    id: message.id,
    system: true,
    from: resolve(request.agent.pubkey, request.agent.name, 'agent'),
    to: resolve(request.owner.pubkey, request.owner.name, 'human'),
    time: ledgerStamp(message.timestamp),
    body: card,
  }], [message.id, message.timestamp, request.agent.pubkey, request.agent.name, request.owner.pubkey, request.owner.name, resolve, card]);
  return (
    <LedgerEntryFrame hasByline testID={`chat-message-${message.id}`}>
      <PillRow items={items} testID={`grant-request-pill-${message.id}`} />
    </LedgerEntryFrame>
  );
}
