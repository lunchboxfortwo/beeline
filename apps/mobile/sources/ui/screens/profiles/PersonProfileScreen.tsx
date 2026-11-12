import React, { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { router, useNavigation } from 'expo-router';
import { ListItem, Spinner, XStack, YStack } from 'tamagui';
import { MessagesSquare, Pencil, UserPlus } from 'lucide-react-native';
import { roomTitle, type RoomViewMember, type WorkspaceMemberListView } from '@beeline/api-contract/phone';
import { isWorkspaceMemberListView } from '@beeline/buzz-client';
import { useSurfaceFocus } from '@/buzz/use-surface-focus';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { loadBuzzIdentity, getEffectiveRelayUrl } from '@/auth/buzz-identity-storage';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { Modal } from '@/modal/ModalManager';
import { navigateToRoom } from '@/buzz/corner-navigation';
import { displayModel } from '@/buzz/model-display';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { useChatList, type ChatListKey } from '@/buzz/chat-list-store';
import { useActiveCommunityId } from '@/buzz/use-active-community';
import {
    recordWorkspacePage, recordWorkspaceRemoval, recordWorkspaceRole, useWorkspaceRecords, workspaceOwnedAgents, workspaceRecord, workspaceRecordScope,
} from '@/buzz/workspace-records';
import { watchWorkspace } from '@/buzz/workspace-watch';
import { currentSurfaceStamp } from '@/buzz/surface-clock';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { openPlace } from '@/ui/shell/panel';
import { useIsDesktop } from '@/utils/responsive';
import { Btn, Copy, Glyph, HEIGHT, Row, Screen, Section, SheetFrame, SheetRow, T } from '@/ui/grammar';
import { ProfileHead } from './ProfileParts';

type Role = RoomViewMember['role'];

/** A person's profile: mark, @handle and role; Message, Invite to chat, Edit (role, removal); their agents. */
export function PersonProfileScreen({ memberId, workspaceId, close }: { memberId: string; workspaceId?: string; close: () => void }) {
    const active = useActiveCommunityId();
    const resolved = workspaceId ?? active ?? undefined;
    if (!resolved) return <Screen title="Profile" back={close} testID="human-profile"><SurfaceGlyphLoader /></Screen>;
    return <PersonProfile key={`${resolved}:${memberId}`} workspaceId={resolved} memberId={memberId} close={close} />;
}

function PersonProfile({ workspaceId, memberId, close }: { workspaceId: string; memberId: string; close: () => void }) {
    const focused = useSurfaceFocus();
    const desktop = useIsDesktop();
    const navigation = useNavigation();
    const allowNavigation = useRef(false);
    const live = useRef(true);
    useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
    const [recordScope, setRecordScope] = useState<string | null>(null);
    const [chatListKey, setChatListKey] = useState<ChatListKey | null>(null);
    const [profile, setProfile] = useState<WorkspaceMemberListView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    useLatencyRouteFrame('/beeline/human-profile', !loading, true);
    const [busy, setBusy] = useState(false);
    const [agentsHasMore, setAgentsHasMore] = useState(false);
    const [editing, setEditing] = useState(false);
    const [inviting, setInviting] = useState(false);
    const [role, setRole] = useState<Role>('member');
    const [retry, setRetry] = useState(0);
    const mutation = useRef(false);
    // Member, role and owned agents select the shared Workspace records, so a
    // change from People, another device or a live identity event lands here.
    useWorkspaceRecords(recordScope);
    const record = workspaceRecord(recordScope, memberId);
    const member = record ? (record as RoomViewMember) : null;
    const removed = record === null;
    const agents = workspaceOwnedAgents(recordScope, memberId);
    const chatList = useChatList(inviting ? chatListKey : null);
    const viewer = profile?.viewer;
    useEffect(() => { if (!editing && member) setRole(member.role); }, [editing, member?.role]);
    useEffect(() => { setEditing(false); }, [focused, workspaceId, memberId, retry]);
    useEffect(() => {
        if (!focused) return;
        let cancelled = false;
        let stopProfile: (() => void) | undefined;
        let stopWatch: (() => void) | undefined;
        setLoading(true);
        void (async () => {
            const [identity, baseUrl] = await Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]);
            if (!identity) throw new Error('Sign in to view this profile.');
            if (cancelled) return;
            setRecordScope(workspaceRecordScope(baseUrl, identity.publicKey, workspaceId));
            setChatListKey({ relayUrl: baseUrl, viewerPubkey: identity.publicKey, workspaceId });
            const address = surfaceAddress(baseUrl, identity.publicKey, '/workspace/:id/members/:memberId', { workspaceId, memberId });
            // One read names the person and the agents they own.
            const http = new RoomViewClient({ identity, baseUrl });
            const read = () => cancelled ? Promise.resolve(null)
                : mobileSurfaceCache.fetch(address, isWorkspaceMemberListView, () => http.workspaceMembers(workspaceId, { memberId }));
            const watch = watchWorkspace(identity, baseUrl, workspaceId, () => void read().catch(() => undefined));
            stopWatch = watch.release;
            stopProfile = mobileSurfaceCache.subscribe(address, () => {
                const next = mobileSurfaceCache.peek(address, isWorkspaceMemberListView);
                if (!cancelled && next) setProfile(next);
            });
            const cached = await mobileSurfaceCache.read(address, isWorkspaceMemberListView);
            if (cancelled) return;
            if (cached) { setProfile(cached); setLoading(false); }
            await watch.ready;
            if (cancelled) return;
            const fresh = await read();
            if (cancelled || !fresh) return;
            setProfile(fresh);
            setAgentsHasMore(fresh.agentsTruncated);
        })()
            .catch((reason) => { if (!cancelled) setError(appErrorCopy(reason)); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; stopProfile?.(); stopWatch?.(); };
    }, [focused, workspaceId, memberId, retry]);

    const self = viewer?.identity.pubkey === memberId;
    const canEditRole = !self && Boolean(viewer?.permissions.manage) && Boolean(member) &&
        ((viewer?.role === 'owner' && member?.role !== 'owner') ||
            (viewer?.role === 'admin' && (member?.role === 'member' || member?.role === 'spectator')));
    const perform = async (action: () => Promise<void>) => {
        if (mutation.current) return;
        mutation.current = true;
        setBusy(true);
        setError(null);
        try { await action(); } catch (reason) {
            if (live.current) { setError(appErrorCopy(reason)); setRetry((value) => value + 1); }
        } finally {
            mutation.current = false;
            if (live.current) setBusy(false);
        }
    };
    const dirty = editing && member !== null && role !== member.role;
    const confirmDiscard = async () => !dirty ||
        (await Modal.confirm('Discard role change?', 'The new role has not been saved.', { cancelText: 'Keep editing', confirmText: 'Discard', destructive: true }));
    const leave = async () => {
        if (!(await confirmDiscard())) return;
        live.current = false;
        allowNavigation.current = true;
        close();
    };
    useEffect(() => {
        if (!dirty) return;
        return navigation.addListener('beforeRemove', (event) => {
            if (allowNavigation.current) return;
            event.preventDefault();
            void confirmDiscard().then((confirmed) => {
                if (confirmed) { allowNavigation.current = true; navigation.dispatch(event.data.action); }
            });
        });
    }, [navigation, dirty]);
    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        const escape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopImmediatePropagation();
            void leave();
        };
        window.addEventListener('keydown', escape, true);
        return () => window.removeEventListener('keydown', escape, true);
    }, [dirty, busy, close]);

    const message = () => void perform(async () => {
        if (!(await confirmDiscard())) return;
        setEditing(false);
        const room = await monolithPhoneOperation('resolveDirectMessage', { workspaceId, participantId: memberId });
        if (!live.current) return;
        allowNavigation.current = true;
        navigateToRoom(router, room.id);
    });
    const saveRole = () => void perform(async () => {
        await monolithPhoneOperation('addWorkspaceMember', { workspaceId, memberId, role });
        if (recordScope) recordWorkspaceRole(recordScope, memberId, role);
        setEditing(false);
    });
    const removeMember = async () => {
        if (!canEditRole || !member) return;
        const confirmed = await Modal.confirm(`Remove ${member.identity.name}?`,
            'This removes them from every chat and the Workspace. They can rejoin only with a new invite.',
            { cancelText: 'Cancel', confirmText: 'Remove', destructive: true });
        if (confirmed) await perform(async () => {
            await monolithPhoneOperation('removeWorkspaceMember', { workspaceId, memberId });
            if (recordScope) recordWorkspaceRemoval(recordScope, memberId);
            close();
        });
    };
    const inviteTo = (roomId: string) => void perform(async () => {
        await monolithPhoneOperation('addRoomMember', { roomId, memberId });
        setInviting(false);
    });
    const moreAgents = () => void perform(async () => {
        const identity = await loadBuzzIdentity();
        if (!identity) throw new Error('Sign in to continue.');
        const stamp = currentSurfaceStamp();
        const page = await new RoomViewClient({ identity, baseUrl: await getEffectiveRelayUrl() })
            .workspaceMembers(workspaceId, { kind: 'agent', ownerId: memberId, offset: agents.length });
        if (recordScope) recordWorkspacePage(recordScope, page, { kind: 'agent', append: true, stamp });
        setAgentsHasMore(page.agentsTruncated);
    });
    const displayedError = error ?? (removed ? 'This person is no longer a member of this Workspace.' : null);
    const chats = (chatList?.chats ?? []).filter((item) => !item.room.archived && !item.directMessage);

    return (
        <Screen title="Profile" back={() => void leave()} testID="human-profile">
            {loading && !member ? <SurfaceGlyphLoader /> : null}
            {displayedError ? <T v="meta" color="removed">{displayedError}</T> : null}
            {member ? (
                <>
                    <ProfileHead
                        mark={<IdentityMark kind="human" seed={member.identity.pubkey} name={member.identity.name} handle={member.identity.handle} avatarUrl={member.identity.avatar} size={72} />}
                        title={member.identity.handle ? `@${member.identity.handle}` : member.identity.name}
                        line={member.role}
                        testID="human-profile-head"
                    />
                    {self ? (
                        <Section title="You"><Row label="Edit your profile" onPress={() => router.push('/beeline/settings')} last /></Section>
                    ) : (
                        <XStack gap="2" flexWrap="wrap">
                            <Btn kind="primary" minHeight={HEIGHT.control} label="Message" disabled={busy} onPress={message} testID="human-profile-message">
                                <XStack gap="2" alignItems="center"><Glyph icon={MessagesSquare} size={16} color="primaryInk" /><T v="heading" color="primaryInk">Message</T></XStack>
                            </Btn>
                            <Btn label="Invite to chat" disabled={busy} onPress={() => setInviting(true)} testID="human-profile-invite">
                                <XStack gap="2" alignItems="center"><Glyph icon={UserPlus} size={16} color="ink" /><T v="heading">Invite to chat</T></XStack>
                            </Btn>
                            {canEditRole && !editing ? (
                                <Btn label="Edit" disabled={busy} onPress={() => setEditing(true)} testID="edit-person-role">
                                    <XStack gap="2" alignItems="center"><Glyph icon={Pencil} size={16} color="ink" /><T v="heading">Edit</T></XStack>
                                </Btn>
                            ) : null}
                        </XStack>
                    )}
                    {editing && canEditRole ? (
                        <YStack gap="3" testID="person-role-editor">
                            <Section title="Access level">
                                <YStack role="radiogroup" testID="person-role-selector">
                                    {(['member', 'admin'] as const).map((choice, index) => (
                                        <ListItem key={choice} role="radio" aria-checked={role === choice} padding="0" minHeight={HEIGHT.control} backgroundColor="raised"
                                            disabled={busy} onPress={() => setRole(choice)} aria-label={choice === 'admin' ? 'Admin' : 'Member'} testID={`person-role-${choice}`}
                                            borderBottomWidth={index === 0 ? 1 : 0} borderColor="stroke" gap="3">
                                            <YStack width={18} height={18} borderRadius="full" borderWidth={2} borderColor={role === choice ? 'needsYou' : 'strongStroke'} alignItems="center" justifyContent="center">
                                                {role === choice ? <YStack width={8} height={8} borderRadius="full" backgroundColor="needsYou" /> : null}
                                            </YStack>
                                            <Copy>{choice === 'admin' ? 'Admin' : 'Member'}</Copy>
                                        </ListItem>
                                    ))}
                                </YStack>
                            </Section>
                            <XStack gap="2">
                                <Btn label="Cancel" disabled={busy} onPress={() => { setRole(member.role); setEditing(false); }} testID="cancel-person-role">Cancel</Btn>
                                <Btn kind="primary" minHeight={HEIGHT.control} label="Save" disabled={busy} onPress={saveRole} testID="save-person-role">{busy ? 'Saving…' : 'Save'}</Btn>
                            </XStack>
                            <Btn kind="destructive" label="Remove from Workspace" disabled={busy} onPress={() => void removeMember()} testID="remove-person">
                                {busy ? 'Removing…' : 'Remove from Workspace'}
                            </Btn>
                        </YStack>
                    ) : null}
                    <Section title="Connected agents" testID="person-connected-agents">
                        {agents.length ? agents.map((agent, index) => (
                            <Row key={agent.identity.pubkey}
                                leading={<IdentityMark kind="agent" seed={agent.identity.pubkey} name={agent.identity.name} face={agent.identity.face} avatarUrl={agent.identity.avatar} size={28} />}
                                label={agent.identity.handle ? `@${agent.identity.handle}` : 'Handle unavailable'}
                                detail={agent.model ? displayModel(agent.model) : undefined}
                                onPress={() => openPlace({ kind: 'agent', agentId: agent.identity.pubkey, workspaceId }, desktop)}
                                testID={`person-agent-${agent.identity.pubkey}`} last={index === agents.length - 1 && !agentsHasMore} />
                        )) : <Row label="No connected agents in this Workspace." last />}
                        {agentsHasMore ? <Btn kind="quiet" label="More" disabled={busy} onPress={moreAgents} testID="more-connected-agents">More</Btn> : null}
                    </Section>
                </>
            ) : null}
            <SheetFrame open={inviting} close={() => setInviting(false)} title="Invite to chat" testID="person-invite-chat">
                {!chatList ? <Spinner /> : chats.map((item) => (
                    <SheetRow key={item.room.id} icon={null} label={roomTitle(item.room.name) ?? item.room.name} onPress={() => inviteTo(item.room.id)} testID={`person-invite-${item.room.id}`} />
                ))}
            </SheetFrame>
        </Screen>
    );
}
