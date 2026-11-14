import React, { useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ScrollView, Tabs, YStack } from 'tamagui';
import { Copy, HEIGHT, T } from '@/ui/grammar';
import { TabHeader, TabRail, useScrolledUnder } from '@/ui/shell/TabHeader';
import { useIsDesktop } from '@/utils/responsive';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { useYouSettings } from './useYouSettings';
import { YouSettings } from './YouSettings';
import { WORKSPACE_VISIBILITY_LABELS, WorkspaceSettings } from './WorkspaceSettings';

type Scope = 'you' | 'workspace';
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

/**
 * The Settings tab: You and the current Workspace as two pill tabs, each with
 * its mark, a "@handle · role" line, then that scope's sections.
 */
export function SettingsScreen({ initialScope = 'you' }: { initialScope?: Scope } = {}) {
    const desktop = useIsDesktop();
    useLatencyRouteFrame(initialScope === 'workspace' ? '/beeline/settings/workspace' : '/beeline/settings');
    const params = useLocalSearchParams<{ tab?: string; workspaceId?: string; communityId?: string; githubReconnect?: string; githubConnectionError?: string }>();
    const tab = first(params.tab);
    const linkedWorkspaceId = first(params.workspaceId) ?? first(params.communityId);
    const [scope, setScope] = useState<Scope>(tab === 'workspace' ? 'workspace' : initialScope);
    const you = useYouSettings({ linkedWorkspaceId, showWorkbench: scope === 'you', githubReconnect: first(params.githubReconnect), githubConnectionError: first(params.githubConnectionError) });
    useEffect(() => { if (tab === 'workspace') setScope('workspace'); }, [tab, linkedWorkspaceId]);
    const workspace = you.canManageWorkspace ? you.workspace : undefined;
    const showWorkspace = scope === 'workspace' && workspace;
    const caption = showWorkspace
        ? `${workspace.visibility ? `${WORKSPACE_VISIBILITY_LABELS[workspace.visibility]} ${WORKSPACE_LABEL.toLowerCase()} · ` : ''}you are ${workspace.role}`
        : [you.handle ? `@${you.handle}` : '', you.role ?? ''].filter(Boolean).join(' · ');
    const { scrolled, scrollProps } = useScrolledUnder();
    const pill = (value: Scope, label: string, mark: React.ReactNode, testID: string) => (
        <Tabs.Tab key={value} value={value} flex={1} minHeight={HEIGHT.control} paddingHorizontal="3" gap="2" borderRadius="full" borderWidth={1}
            borderColor={scope === value ? 'needsYou' : 'stroke'} backgroundColor={scope === value ? 'highlight' : 'raised'} aria-label={label} testID={testID}>
            {mark}
            <T v="metaStrong" color={scope === value ? 'needsYou' : 'ink'} numberOfLines={1}>{label}</T>
        </Tabs.Tab>
    );

    const screen = (
        <YStack flex={1} minHeight={0} backgroundColor="canvas" testID="settings">
            {/* The header every tab shares; Settings has no buttons of its own. */}
            {desktop ? null : <TabHeader workspaceName={you.workspace?.name ?? WORKSPACE_LABEL} scrolled={scrolled} />}
            <ScrollView flex={1} minHeight={0} keyboardShouldPersistTaps="handled" {...(desktop ? {} : scrollProps)}>
                <YStack padding="4" gap="5" paddingTop={desktop ? '8' : '2'} paddingBottom="8" width="100%" maxWidth={720} alignSelf="center" testID="identity-settings">
                    {desktop ? <T v="title">Settings</T> : null}
                    <YStack gap="3">
                        {workspace ? (
                            <Tabs value={scope} onValueChange={(next: string) => setScope(next as Scope)} flexDirection="column">
                                <Tabs.List gap="2" backgroundColor="canvas" aria-label="Settings scope">
                                    {pill('you', 'You', <IdentityMark kind="human" seed={you.pubkey ?? 'pending-profile'} name={you.name || undefined} handle={you.handle || undefined} avatarUrl={you.avatar} size={22} />, 'settings-you-tab')}
                                    {pill('workspace', workspace.name, <IdentityMark kind="workspace" seed={workspace.id} avatarUrl={workspace.avatar} name={workspace.name} size={22} />, 'settings-workspace-tab')}
                                </Tabs.List>
                            </Tabs>
                        ) : null}
                        {caption ? <Copy small quiet testID="settings-caption">{caption}</Copy> : null}
                    </YStack>
                    {showWorkspace ? <WorkspaceSettings key={workspace.id} workspaceId={workspace.id} /> : <YouSettings you={you} />}
                </YStack>
            </ScrollView>
        </YStack>
    );
    return desktop ? screen : <TabRail tab="settings" workspaceId={you.workspace?.id}>{screen}</TabRail>;
}
