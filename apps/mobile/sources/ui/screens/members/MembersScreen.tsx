import React, { useMemo, useState } from 'react';
import { YStack } from 'tamagui';
import { roomTitle } from '@beeline/api-contract/phone';
import { Copy, Screen } from '@/ui/grammar';
import { openPlace } from '@/ui/shell/panel';
import { useIsDesktop } from '@/utils/responsive';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { workspaceRecord } from '@/buzz/workspace-records';
import { agentRow, personRow, type PeopleRow } from '@/ui/screens/people/people-rows';
import { MemberCard, SectionHead } from '@/ui/screens/people/PeopleParts';
import { InvitePeopleSheet } from '@/ui/screens/people/InvitePeopleSheet';
import { useWorkspaceRoster } from '@/ui/screens/people/use-workspace-roster';
import { AddChatAgentsSheet } from './AddChatAgentsSheet';
import { useRoomView } from './use-room-view';
import { visibilityLine } from './members-lines';

/**
 * A chat's Members: exactly two sections, People and Agents, each with its own
 * + (build spec decision 5). Reached from the header's “N members” or from
 * Chat info; a phone route or the desktop right panel.
 */
export function MembersScreen({ roomId, close }: { roomId: string; close: () => void }) {
    useLatencyRouteFrame('/beeline/members');
    const desktop = useIsDesktop();
    const { room, viewerPubkey, error, refresh } = useRoomView(roomId);
    const workspaceId = room?.room.workspaceId;
    const roster = useWorkspaceRoster(workspaceId);
    const [sheet, setSheet] = useState<'people' | 'agents' | null>(null);
    const workspaceName = roster.surface?.workspace.name ?? '';
    const tag = roomTitle(room?.room.name) ?? '';
    const scope = roster.scope;

    const people = useMemo(() => (room?.members ?? [])
        .filter((member) => member.identity.kind === 'human')
        .map((member) => personRow(member, viewerPubkey)), [room, viewerPubkey]);
    const agents = useMemo(() => (room?.members ?? [])
        .filter((member) => member.identity.kind === 'agent')
        .map((member) => {
            // Owner and usage live on the workspace roster row.
            const held = workspaceRecord(scope, member.identity.pubkey) as Parameters<typeof agentRow>[0] | null | undefined;
            const reviewer = room?.room.reviewerAgentId === member.identity.pubkey ? 'Reviewer' : undefined;
            return agentRow({ ...member, owner: held?.owner, usage: held?.usage, model: member.model ?? held?.model }, viewerPubkey, reviewer);
        }), [room, viewerPubkey, scope, roster.agents]);
    const candidates = useMemo(() => {
        const inChat = new Set(agents.map((row) => row.id));
        return roster.agents.filter((agent) => !inChat.has(agent.identity.pubkey)).map((agent) => agentRow(agent, viewerPubkey));
    }, [agents, roster.agents, viewerPubkey]);

    const openPerson = (row: PeopleRow) => row.id === viewerPubkey ? undefined
        : () => openPlace({ kind: 'person', memberId: row.id, workspaceId }, desktop);
    const openAgent = (row: PeopleRow) => () => openPlace({ kind: 'agent', agentId: row.id, workspaceId }, desktop);
    const canInvite = roster.surface?.viewer.permissions.manage === true;
    const canAddAgents = room?.viewer.permissions.manage === true;
    const line = room ? visibilityLine(tag, room.room.visibility, workspaceName) : undefined;

    return (
        <Screen title="Members" back={close} testID="members">
            {line ? <Copy small quiet testID="members-visibility">{line}</Copy> : null}
            {error ? <Copy small quiet role="alert">{error}</Copy> : null}
            <YStack gap="2" testID="members-people">
                <SectionHead title={`People · ${people.length}`} addLabel="Add people" testID="add-people"
                    onAdd={canInvite && workspaceId ? () => setSheet('people') : undefined} />
                <MemberCard rows={people} open={openPerson} />
            </YStack>
            <YStack gap="2" testID="members-agents">
                <SectionHead title={`Agents · ${agents.length}`} addLabel="Add agents" testID="add-agents"
                    onAdd={canAddAgents ? () => setSheet('agents') : undefined} />
                <MemberCard rows={agents} open={openAgent} />
            </YStack>
            {workspaceId ? (
                <>
                    <InvitePeopleSheet open={sheet === 'people'} close={() => setSheet(null)} workspaceId={workspaceId}
                        workspaceName={workspaceName} roomId={roomId} roomTag={tag} />
                    <AddChatAgentsSheet open={sheet === 'agents'} close={() => setSheet(null)} roomId={roomId} roomTag={tag}
                        workspaceName={workspaceName} candidates={candidates} onAdded={() => void refresh()} />
                </>
            ) : null}
        </Screen>
    );
}
