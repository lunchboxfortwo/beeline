import { PageLoader } from '@/ui/PageLoader';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ScrollView, Separator, XStack, YStack } from 'tamagui';
import { Btn, Copy, T } from '@/ui/grammar';
import { TabHeader, TabRail, useScrolledUnder } from '@/ui/shell/TabHeader';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { openPlace } from '@/ui/shell/panel';
import { useIsDesktop } from '@/utils/responsive';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { useActiveCommunityId } from '@/buzz/use-active-community';
import { agentRow, personRow, type PeopleRow } from './people-rows';
import { MemberCard, SectionHead } from './PeopleParts';
import { InvitePeopleSheet } from './InvitePeopleSheet';
import { AddAgentSheet } from './AddAgentSheet';
import { useWorkspaceRoster } from './use-workspace-roster';

const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

/**
 * The People tab: the workspace's contact list in two sections. People +
 * invites to the workspace; Agents +
 * invites an external agent or creates one. Rows open profiles (build spec
 * decisions 2, 8 and 9).
 */
export function PeopleTabScreen() {
    useLatencyRouteFrame('/beeline/people');
    const desktop = useIsDesktop();
    const params = useLocalSearchParams<{ communityId?: string | string[]; action?: string | string[] }>();
    const activeWorkspaceId = useActiveCommunityId();
    const workspaceId = first(params.communityId) || activeWorkspaceId || undefined;
    const roster = useWorkspaceRoster(workspaceId);
    const [sheet, setSheet] = useState<'people' | 'agents' | null>(null);
    const workspace = roster.surface?.workspace;
    const workspaceName = workspace?.name ?? '';
    const canManage = roster.surface?.viewer.permissions.manage === true;
    const people = useMemo(() => roster.people.map((member) => personRow(member, roster.viewerPubkey)), [roster.people, roster.viewerPubkey]);
    const agents = useMemo(() => roster.agents.map((agent) => agentRow(agent, roster.viewerPubkey)), [roster.agents, roster.viewerPubkey]);
    // An old Members link (`action=invite|add-agent`) opens its sheet once.
    const action = first(params.action);
    const actionHandled = useRef(false);
    useEffect(() => {
        if (actionHandled.current || !roster.surface || !workspaceId) return;
        actionHandled.current = true;
        if (action === 'add-agent') setSheet('agents');
        else if (action === 'invite' && canManage) setSheet('people');
    }, [action, roster.surface, workspaceId, canManage]);
    const openPerson = (row: PeopleRow) => row.id === roster.viewerPubkey ? undefined
        : () => openPlace({ kind: 'person', memberId: row.id, workspaceId }, desktop);
    const openAgent = (row: PeopleRow) => () => openPlace({ kind: 'agent', agentId: row.id, workspaceId }, desktop);
    const invite = canManage && workspaceId ? () => setSheet('people') : undefined;
    const { scrolled, scrollProps } = useScrolledUnder();

    const screen = (
        <YStack flex={1} minHeight={0} backgroundColor="canvas" testID="people-tab">
            {desktop ? (
                <>
                    <XStack paddingHorizontal="4" paddingTop="4" paddingBottom="3" width="100%" maxWidth={760} alignSelf="center">
                        <T v="title">Team</T>
                    </XStack>
                    <Separator borderColor="stroke" />
                </>
            ) : (
                <TabHeader workspaceName={workspaceName || WORKSPACE_LABEL} scrolled={scrolled} />
            )}
            {!roster.surface && !roster.error ? <PageLoader /> : <ScrollView flex={1} minHeight={0} {...(desktop ? {} : scrollProps)}>
                <YStack padding="4" gap="5" paddingBottom="8" width="100%" maxWidth={760} alignSelf="center">
                    {roster.error ? <Copy small quiet role="alert">{roster.error}</Copy> : null}
                    <YStack gap="2" testID="people-humans">
                        <SectionHead title={`People · ${roster.peopleTotal}`} addLabel={`Invite to ${workspaceName}`} testID="people-invite"
                            onAdd={invite} />
                        <MemberCard rows={people} open={openPerson} roleAtEnd />
                        {roster.morePeople ? <Btn kind="quiet" label="Show more people" disabled={roster.loadingMore} onPress={() => void roster.loadMore('human')}>Show more</Btn> : null}
                    </YStack>
                    <YStack gap="2" testID="people-agents">
                        <SectionHead title={`Agents · ${roster.agentTotal}`} addLabel={`Add an agent to ${workspaceName}`} testID="people-add-agent"
                            onAdd={workspaceId ? () => setSheet('agents') : undefined} />
                        <MemberCard rows={agents} open={openAgent} />
                        {roster.moreAgents ? <Btn kind="quiet" label="Show more agents" disabled={roster.loadingMore} onPress={() => void roster.loadMore('agent')}>Show more</Btn> : null}
                    </YStack>
                </YStack>
            </ScrollView>}
            {workspaceId ? (
                <>
                    <InvitePeopleSheet open={sheet === 'people'} close={() => setSheet(null)} workspaceId={workspaceId} workspaceName={workspaceName} />
                    <AddAgentSheet open={sheet === 'agents'} close={() => setSheet(null)} workspaceId={workspaceId} workspaceName={workspaceName} agents={agents} />
                </>
            ) : null}
        </YStack>
    );
    return desktop ? screen : <TabRail tab="people" workspaceId={workspaceId}>{screen}</TabRail>;
}
