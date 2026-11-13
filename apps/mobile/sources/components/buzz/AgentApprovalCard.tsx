import React from 'react';
import type { RoomViewIdentity } from '@beeline/api-contract/phone';
import type { AgentPresentation } from '@/buzz/room-view-presentation';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
export { approvalDecisionNote } from './approval-decision-copy';
import { T } from '@/ui/grammar';
import { YStack } from 'tamagui';
import { TranscriptLine, type TranscriptSender } from '@/ui/screens/transcript/TranscriptLine';
import { TranscriptCard, type TranscriptCardProps } from './TranscriptCard';

export function approvalAudience(owner: RoomViewIdentity | undefined, viewerPubkey?: string): string {
  return !owner || owner.pubkey === viewerPubkey ? 'for you' : `for @${(owner.handle ?? owner.name).replace(/^@/, '')}`;
}

/**
 * The host-permission anatomy shared by every agent approval (build spec,
 * chat-milo-cards): the asking agent's transcript line carries the reason as
 * its message, and the card under it holds the ask, its facts and Approve / Deny.
 */
export function AgentApprovalCard({ askingAgent, agent, body, stamp, ...card }: Omit<TranscriptCardProps, 'identity'> & {
  askingAgent: RoomViewIdentity;
  agent?: AgentPresentation;
}) {
  const display = resolveAgentDisplayIdentity(askingAgent.pubkey, agent);
  return (
    <AgentCardLine sender={{
      name: agent ? display.name : askingAgent.name,
      stamp: stamp ?? '',
      mark: { kind: 'agent', seed: display.avatarSeed ?? askingAgent.pubkey,
        avatarUrl: display.avatarUrl ?? askingAgent.avatar, face: display.face ?? askingAgent.face },
    }}>
      {body ? <T v="body">{body}</T> : null}
      <TranscriptCard {...card} />
    </AgentCardLine>
  );
}

/** A card in its asking agent's transcript line, spaced like a message that opens a sender group. */
export function AgentCardLine({ sender, children }: { sender: TranscriptSender; children: React.ReactNode }) {
  return (
    <YStack width="100%" minWidth={0} paddingTop="6" paddingBottom="2">
      <TranscriptLine sender={sender}>{children}</TranscriptLine>
    </YStack>
  );
}
