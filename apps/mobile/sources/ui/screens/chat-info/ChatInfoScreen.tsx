import { IdentityMark } from '@/components/buzz/IdentityMark';
import { RepositoryMark } from '@/components/buzz/RepositoryMark';
import React, { useEffect, useMemo, useState } from 'react';
import { router, type Href } from 'expo-router';
import { Card, Input, ListItem, Separator, Switch, XStack, YStack } from 'tamagui';
import { Check } from 'lucide-react-native';
import { cornerShortTitle, roomTitle } from '@beeline/api-contract/phone';
import { Btn, ChatName, Copy, Glyph, HEIGHT, PlaceHeader, Row, Screen, Section, SheetFrame, SheetRow, T } from '@/ui/grammar';
import { openPlace } from '@/ui/shell/panel';
import { useIsDesktop } from '@/utils/responsive';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { useScheduledWork } from '@/buzz/scheduled-work';
import { useRoomCorners } from '@/buzz/use-room-corners';
import { cornerHref } from '@/buzz/corner-navigation';
import { leaveRoomWithConfirmation } from '@/buzz/room-leave';
import { ROOM_SLUG_HINT, roomNameEntry, validRoomSlug } from '@/buzz/room-name';
import { CORNER_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { Modal } from '@/modal';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { handleOf } from '@/ui/screens/people/people-rows';
import { useWorkspaceRoster } from '@/ui/screens/people/use-workspace-roster';
import { useRoomView } from '@/ui/screens/members/use-room-view';
import { ChatRepositoryEditor } from './ChatRepositoryEditor';
import { chatKindLine, finishedWhen, scheduledRows } from './chat-info-lines';

/**
 * Chat info (⚙ or the chat's name): public or private, the chat's settings,
 * Members, schedules and subscriptions (each names its workflow), finished
 * threads (done threads live only here), then Leave and Delete. The Workflows
 * section is cut (build spec decision 28).
 */
export function ChatInfoScreen({ roomId, close }: { roomId: string; close: () => void }) {
    useLatencyRouteFrame('/beeline/chat-info');
    const desktop = useIsDesktop();
    const { room, error: roomError, refresh } = useRoomView(roomId);
    const workspaceId = room?.room.workspaceId;
    const roster = useWorkspaceRoster(workspaceId);
    const scheduled = useScheduledWork(roomId);
    const corners = useRoomCorners(roomId);
    const [muted, setMuted] = useState<boolean | null>(null);
    const [reviewerOpen, setReviewerOpen] = useState(false);
    const [busy, setBusy] = useState<'mute' | 'reviewer' | 'leave' | 'delete' | 'name' | 'repository' | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editor, setEditor] = useState<'name' | null>(null);
    const [nameDraft, setNameDraft] = useState('');
    const [editError, setEditError] = useState<string | null>(null);
    const loadArchived = corners.loadArchived;

    useEffect(() => { setEditor(null); }, [roomId]);
    useEffect(() => { void loadArchived(false).catch(() => undefined); }, [loadArchived]);

    const name = room?.room.name ?? '';
    const tag = roomTitle(name) ?? '';
    const direct = Boolean(room?.directMessage);
    const canManage = room?.viewer.permissions.manage === true;
    const canEditRepository = canManage && !direct;
    const canRename = canEditRepository && room?.viewer.identity.kind === 'human';
    const workspaceName = roster.surface?.workspace.name ?? '';
    const pushMuted = muted ?? room?.viewer.pushMuted === true;
    const agents = (room?.members ?? []).filter((member) => member.identity.kind === 'agent');
    const reviewer = agents.find((member) => member.identity.pubkey === room?.room.reviewerAgentId);
    const rows = useMemo(() => scheduled.work ? scheduledRows(scheduled.work) : [], [scheduled.work]);
    const finished = corners.record?.archived?.corners ?? [];

    const openRename = () => {
        if (!canRename || busy) return;
        setNameDraft(name); setEditError(null); setEditor('name');
    };
    const saveName = async () => {
        const next = nameDraft.trim();
        if (!canRename || busy || !validRoomSlug(next) || next === name) return;
        setBusy('name'); setEditError(null);
        try {
            await monolithPhoneOperation('updateRoom', { roomId, name: next });
            await refresh();
            setEditor(null);
        } catch (reason) { setEditError(appErrorCopy(reason, 'Could not rename chat.')); }
        finally { setBusy(null); }
    };
    const leaveToChats = () => {
        router.replace({ pathname: '/beeline/channels', ...(workspaceId ? { params: { communityId: workspaceId } } : {}) } as Href);
    };
    const toggleMute = async (next: boolean) => {
        if (busy) return;
        setBusy('mute');
        setMuted(next);
        try {
            const result = await monolithPhoneOperation('updateRoomPushState', { roomId, muted: next });
            setMuted(result.muted);
        } catch (reason) {
            setMuted(null);
            setError(appErrorCopy(reason, 'Could not update notifications.'));
        } finally {
            setBusy(null);
        }
    };
    const chooseReviewer = async (reviewerAgentId: string | null) => {
        setReviewerOpen(false);
        if (busy || reviewerAgentId === (room?.room.reviewerAgentId ?? null)) return;
        setBusy('reviewer');
        try {
            await monolithPhoneOperation('updateRoom', { roomId, reviewerAgentId });
            await refresh();
        } catch (reason) {
            setError(appErrorCopy(reason, `Could not change ${ROOM_LABEL} reviewer.`));
        } finally {
            setBusy(null);
        }
    };
    const leave = async () => {
        if (busy) return;
        setBusy('leave');
        setError(null);
        try {
            const left = await leaveRoomWithConfirmation(tag || name, room?.leaveDeletesRoom === true,
                (confirmDelete) => monolithPhoneOperation('leaveRoom', { roomId, ...(confirmDelete ? { confirmDelete: true as const } : {}) }));
            if (left) leaveToChats();
        } catch (reason) {
            setError(appErrorCopy(reason, `Could not leave ${ROOM_LABEL}.`));
        } finally {
            setBusy(null);
        }
    };
    const remove = async () => {
        if (busy || !canManage) return;
        setBusy('delete');
        setError(null);
        try {
            const confirmed = await Modal.confirm(`Delete ${tag || name}?`,
                `This ${ROOM_LABEL} and its workspace data will be permanently deleted.`,
                { cancelText: 'Cancel', confirmText: `Delete ${ROOM_LABEL}`, destructive: true });
            if (!confirmed) return;
            await monolithPhoneOperation('deleteRoom', { roomId });
            leaveToChats();
        } catch (reason) {
            setError(appErrorCopy(reason, `Could not delete ${ROOM_LABEL}.`));
        } finally {
            setBusy(null);
        }
    };
    const openScheduled = (row: { id: string; kind: 'schedule' | 'subscription' }) => () => router.push({
        pathname: row.kind === 'schedule' ? '/beeline/settings/schedule' : '/beeline/settings/subscription',
        params: row.kind === 'schedule' ? { roomId, scheduleId: row.id } : { roomId, subscriptionId: row.id },
    } as unknown as Href);

    return (
        <Screen title="Chat info" back={close} testID="chat-info" header={(
            // The chat's own header frame, so entering chat info keeps the name in place.
            <PlaceHeader back={close} testID="chat-info-header"
                mark={direct ? null : <RepositoryMark avatarUrl={room?.room.avatar} faviconUrl={room?.room.favicon} size={36} />}
                title={<ChatName name={tag || name} />}
                meta={room && !direct ? <Copy small quiet testID="chat-kind">{chatKindLine(room.room.visibility, workspaceName, room.members.length)}</Copy> : null} />
        )}>
            {roomError || error ? <Copy small quiet role="alert">{error ?? roomError}</Copy> : null}

            <Section title="Chat">
                {!direct ? <>
                    <Row label="Name" value={tag || name} onPress={canRename ? openRename : undefined} testID="chat-name" />
                    {editor === 'name' && canRename ? (
                        <YStack paddingVertical="3" gap="2" testID="chat-name-editor">
                            <Input minHeight={HEIGHT.control} value={nameDraft} onChangeText={value => setNameDraft(roomNameEntry(value))}
                                onSubmitEditing={() => void saveName()} autoFocus maxLength={48} selectTextOnFocus autoCapitalize="none" autoCorrect={false}
                                aria-label="New chat name" disabled={busy !== null} testID="chat-name-input" />
                            {!validRoomSlug(nameDraft.trim()) ? <Copy small quiet>{ROOM_SLUG_HINT}</Copy> : null}
                            {editError ? <Copy small quiet role="alert">{editError}</Copy> : null}
                            <XStack gap="2" justifyContent="flex-end">
                                <Btn kind="quiet" label="Cancel" disabled={busy !== null} onPress={() => setEditor(null)}>Cancel</Btn>
                                <Btn kind="primary" label="Save" disabled={busy !== null || !validRoomSlug(nameDraft.trim()) || nameDraft.trim() === name}
                                    onPress={() => void saveName()} testID="chat-name-save">{busy === 'name' ? 'Saving…' : 'Save'}</Btn>
                            </XStack>
                        </YStack>
                    ) : null}
                    <ChatRepositoryEditor roomId={roomId} current={room?.repository ?? null} canEditRepository={canEditRepository}
                        disabled={busy !== null} openCorners={corners.record?.summary?.cornerCount ?? 0} refresh={refresh}
                        onBusyChange={saving => setBusy(saving ? 'repository' : null)} onOpen={() => { if (editor) setEditor(null); }} />
                </> : null}
                {room?.repository && !direct ? (
                    <Row label="Reviewer" value={reviewer ? handleOf(reviewer.identity) : 'None'}
                        detail="This agent reviews every pull request opened from the chat."
                        onPress={canManage ? () => setReviewerOpen(true) : undefined} testID="chat-reviewer" />
                ) : null}
                <Row label="Mute notifications" detail="Tags and replies still notify you." last testID="chat-mute"
                    right={<Switch checked={pushMuted} disabled={busy === 'mute'} onCheckedChange={(next: boolean) => void toggleMute(next)} aria-label="Mute notifications"><Switch.Thumb /></Switch>} />
            </Section>

            {direct ? null : (
                <Section title="People and agents">
                    <Row label="Members" value={room ? String(room.members.length) : undefined} detail="People, agents and their roles · Add agent"
                        onPress={() => openPlace({ kind: 'members', roomId }, desktop)} last testID="chat-members" />
                </Section>
            )}

            {rows.length ? (
                <Section title="Routines" testID="chat-schedules">
                    {rows.map((row, index) => (
                        <Row key={row.id} label={row.label} detail={row.detail} onPress={openScheduled(row)} last={index === rows.length - 1} testID={`scheduled-${row.id}`} />
                    ))}
                </Section>
            ) : null}

            <Section title={`Finished threads · ${corners.record?.archived?.total ?? finished.length}`} note="moved here from the chat list" testID="finished">
                {finished.length ? finished.map((item, index) => {
                    const title = cornerShortTitle(name, item.corner.name, item.corner.id);
                    return (
                        <Row leading={item.corner.avatar || item.corner.favicon ? <RepositoryMark avatarUrl={item.corner.avatar} faviconUrl={item.corner.favicon} size={28} /> : undefined} key={item.corner.id} label={title} detail={finishedWhen(item.closedAt)}
                            onPress={() => router.push(cornerHref(item.corner.id, roomId, title))}
                            last={index === finished.length - 1 && !corners.record?.archived?.next} testID={`finished-${item.corner.id}`} />
                    );
                }) : <Row label="None yet" last />}
                {corners.record?.archived?.next ? (
                    <Btn kind="quiet" label="Show more finished threads" onPress={() => void loadArchived(true).catch(() => undefined)}>Show more</Btn>
                ) : null}
            </Section>

            {direct ? null : (
                <Card backgroundColor="raised" borderWidth={1} borderColor="stroke" paddingHorizontal="3" paddingVertical="1">
                    <ListItem padding="0" minHeight={HEIGHT.control} backgroundColor="raised" disabled={busy !== null} onPress={() => void leave()}
                        aria-label="Leave chat" accessibilityRole="button" testID="leave-chat">
                        <YStack paddingVertical="3"><T v="heading" color="removed">{busy === 'leave' ? 'Leaving…' : 'Leave chat'}</T></YStack>
                    </ListItem>
                    {canManage ? (
                        <>
                            <Separator borderColor="stroke" />
                            <ListItem padding="0" minHeight={HEIGHT.control} backgroundColor="raised" disabled={busy !== null} onPress={() => void remove()}
                                aria-label="Delete chat" accessibilityRole="button" testID="delete-chat">
                                <YStack paddingVertical="3"><T v="heading" color="removed">{busy === 'delete' ? 'Deleting…' : 'Delete chat'}</T></YStack>
                            </ListItem>
                        </>
                    ) : null}
                </Card>
            )}

            <SheetFrame open={reviewerOpen} close={() => setReviewerOpen(false)} title="Reviewer" testID="sheet-reviewer" scrollable>
                <SheetRow icon={null} right={reviewer ? null : <Glyph icon={Check} accent />} selected={!reviewer} label="None" onPress={() => void chooseReviewer(null)} testID="reviewer-none" />
                {agents.map((agent) => (
                    <SheetRow key={agent.identity.pubkey}
                        icon={<IdentityMark kind="agent" seed={agent.identity.pubkey} face={agent.identity.face} name={agent.identity.name} handle={agent.identity.handle} avatarUrl={agent.identity.avatar} size={28} />}
                        selected={agent === reviewer} right={agent === reviewer ? <Glyph icon={Check} accent /> : null}
                        label={agent.identity.name || handleOf(agent.identity)} detail={handleOf(agent.identity)} onPress={() => void chooseReviewer(agent.identity.pubkey)} testID={`reviewer-${agent.identity.pubkey}`} />
                ))}
            </SheetFrame>
        </Screen>
    );
}
