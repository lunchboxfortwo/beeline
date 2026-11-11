import React, { useMemo } from 'react';
import { roomTitle } from '@beeline/api-contract/phone';
import { agentRow } from '@/ui/screens/people/people-rows';
import { AddAgentSheet } from '@/ui/screens/people/AddAgentSheet';
import { InvitePeopleSheet } from '@/ui/screens/people/InvitePeopleSheet';
import { useWorkspaceRoster } from '@/ui/screens/people/use-workspace-roster';
import { AddChatAgentsSheet } from './AddChatAgentsSheet';
import { useRoomView } from './use-room-view';

/**
 * People + or Agents + for one chat, opened from the chat itself (a slash
 * command or a starter prompt) rather than from its Members page. Mount it
 * only while open: it reads the chat and its workspace roster like Members.
 */
export function ChatAddSheet({ roomId, sheet, close }: { roomId: string; sheet: 'people' | 'agents'; close: () => void }) {
    const { room, viewerPubkey, refresh } = useRoomView(roomId);
    const workspaceId = room?.room.workspaceId;
    const roster = useWorkspaceRoster(workspaceId);
    const workspaceName = roster.surface?.workspace.name ?? '';
    const tag = roomTitle(room?.room.name) ?? '';
    const candidates = useMemo(() => {
        const inChat = new Set((room?.members ?? []).map((member) => member.identity.pubkey));
        return roster.agents.filter((agent) => !inChat.has(agent.identity.pubkey)).map((agent) => agentRow(agent, viewerPubkey));
    }, [room, roster.agents, viewerPubkey]);
    if (!workspaceId) return null;
    return sheet === 'people' ? (
        <InvitePeopleSheet open close={close} workspaceId={workspaceId} workspaceName={workspaceName} roomId={roomId} roomTag={tag} />
    ) : (
        <AddChatAgentsSheet open close={close} roomId={roomId} roomTag={tag} workspaceName={workspaceName}
            candidates={candidates} onAdded={() => void refresh()} />
    );
}

/** Add an agent to a workspace (the People tab's Agents +), opened from a chat or the empty Chats list. */
export function WorkspaceAddAgentSheet({ workspaceId, close }: { workspaceId: string; close: () => void }) {
    const roster = useWorkspaceRoster(workspaceId);
    const agents = useMemo(() => roster.agents.map((agent) => agentRow(agent, roster.viewerPubkey)), [roster.agents, roster.viewerPubkey]);
    return (
        <AddAgentSheet open close={close} workspaceId={workspaceId} workspaceName={roster.surface?.workspace.name ?? ''} agents={agents} />
    );
}
