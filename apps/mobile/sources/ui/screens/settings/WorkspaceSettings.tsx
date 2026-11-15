import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect } from 'expo-router';
import { Input, Switch, XStack, YStack } from 'tamagui';
import { Check, Copy as CopyIcon } from 'lucide-react-native';
import { isWorkspaceView, type BuzzClient } from '@beeline/buzz-client';
import { roomTitle } from '@beeline/api-contract/phone';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { appErrorCopy, appReadErrorCopy } from '@/buzz/app-error-copy';
import { useTextDraft } from '@/buzz/use-text-draft';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { useSurfaceSnapshot } from '@/buzz/use-shared-surface';
import { refreshChatList, useChatList, type ChatListKey } from '@/buzz/chat-list-store';
import { pickAndUploadAvatar } from '@/buzz/avatar-upload';
import { buildCommunityInviteUrl } from '@/buzz/community-invite';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { isWorkspaceOwnerRole } from '@/buzz/workspace-role';
import { ROOM_LABEL, WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { BuzzRigTransport } from '@/sync/transport';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { roomHref } from '@/buzz/corner-navigation';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { Btn, Copy, Glyph, HEIGHT, Row, Section, SheetFrame, SheetRow, T } from '@/ui/grammar';

export const WORKSPACE_VISIBILITY_LABELS = { public: 'Public', 'invite-only': 'Invite-only' } as const;
// Chats are public to the whole workspace or private (spec decision 4).
const CHAT_VISIBILITY_LABELS = { public: 'Public', 'invite-only': 'Private' } as const;

type ChatSetting = { id: string; name: string; visibility: 'public' | 'invite-only'; joined?: boolean };

/**
 * Settings → <Workspace>: picture, General, Chats and Danger. Owners and
 * admins reach this tab; invites and roles live on the People tab.
 */
export function WorkspaceSettings({ workspaceId }: { workspaceId: string }) {
    const [client, setClient] = useState<BuzzClient | null>(null);
    const [address, setAddress] = useState<ReturnType<typeof surfaceAddress> | null>(null);
    const view = useSurfaceSnapshot(address, isWorkspaceView);
    const [chatListKey, setChatListKey] = useState<ChatListKey | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [working, setWorking] = useState<string | null>(null);
    const readRef = useRef<(() => Promise<void>) | null>(null);
    const chatList = useChatList(chatListKey, { onError: (reason) => setError(appReadErrorCopy(reason)) });
    const workspace = view?.workspace;
    const canManage = view?.viewer.permissions.manage === true;
    const [name, setName, nameDraft] = useTextDraft(`workspace-name:${workspaceId}`, '');
    const [renaming, setRenaming] = useState(false);
    const [sheet, setSheet] = useState<'visibility' | 'delete' | { room: string } | null>(null);
    const [deleteText, setDeleteText, deleteDraft] = useTextDraft(`workspace-delete:${workspaceId}`, '');
    const [joinUrl, setJoinUrl] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const joinGeneration = useRef(0);

    useEffect(() => { if (workspace) nameDraft.initialize(workspace.name); }, [workspace?.name, nameDraft]);

    useFocusEffect(useCallback(() => {
        let cancelled = false;
        let stopReconnect: (() => void) | undefined;
        setError(null);
        void (async () => {
            try {
                const [identity, relay] = await Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]);
                if (cancelled) return;
                if (!identity) { router.replace('/beeline/onboarding'); return; }
                const next = surfaceAddress(relay, identity.publicKey, '/workspace/:id', { workspaceId });
                setAddress(next);
                setChatListKey({ relayUrl: relay, viewerPubkey: identity.publicKey, workspaceId });
                await mobileSurfaceCache.read(next, isWorkspaceView);
                const currentClient = await new BuzzRigTransport(identity).ensureClient();
                if (cancelled) return;
                setClient(currentClient);
                const http = new RoomViewClient({ baseUrl: relay, identity });
                const read = async () => {
                    if (cancelled) return;
                    try {
                        await mobileSurfaceCache.fetch(next, isWorkspaceView, () => http.workspace(workspaceId));
                        if (!cancelled) setError(null);
                    } catch (reason) {
                        if (!cancelled) setError(appReadErrorCopy(reason));
                    }
                };
                readRef.current = read;
                const release = await sharedLiveConnection().register([], (event) => {
                    if (!cancelled && 'monolithLive' in event && event.monolithLive.type === 'invalidate' &&
                        event.monolithLive.roomId === '' && event.monolithLive.reason === 'reconnect') void read();
                });
                if (cancelled) { release(); return; }
                stopReconnect = release;
                await read();
            } catch (caught) {
                if (!cancelled) setError(appErrorCopy(caught, ''));
            }
        })();
        return () => { cancelled = true; stopReconnect?.(); readRef.current = null; };
    }, [workspaceId]));

    const loadJoinLink = useCallback(async () => {
        if (workspace?.visibility !== 'public') return;
        const generation = ++joinGeneration.current;
        try {
            const invite = await monolithPhoneOperation('createInvite', { workspaceId });
            if (generation === joinGeneration.current) setJoinUrl(buildCommunityInviteUrl(invite.token, getBuzzRuntimeConfig().relayUrl));
        } catch (caught) {
            if (generation === joinGeneration.current) setError(appErrorCopy(caught, ''));
        }
    }, [workspaceId, workspace?.visibility]);
    useEffect(() => {
        setJoinUrl(null);
        void loadJoinLink();
        return () => { joinGeneration.current += 1; };
    }, [loadJoinLink]);

    const chats = useMemo<ChatSetting[]>(() => {
        const joined = new Map((chatList?.chats ?? []).filter((item) => !item.room.archived && !item.directMessage).map((item) => [item.room.id, item.room]));
        const listed = view?.managerSettings?.rooms ??
            [...joined.values()].map((room) => ({ id: room.id, name: room.name, visibility: room.visibility ?? 'public' as const }));
        return listed.map((room) => ({ id: room.id, name: room.name, visibility: room.visibility, joined: chatList ? joined.has(room.id) : undefined }))
            .sort((left, right) => left.name.localeCompare(right.name));
    }, [chatList, view?.managerSettings?.rooms]);

    const run = async (key: string, action: () => Promise<unknown>, failure: string) => {
        setWorking(key);
        setError(null);
        try { await action(); void readRef.current?.(); } catch (caught) { setError(appErrorCopy(caught, failure)); } finally { setWorking(null); }
    };
    const saveName = () => {
        if (!client || !name.trim()) return;
        const clear = nameDraft.capture(false);
        void run('name', async () => { await client.renameCommunity(workspaceId, name); clear(); setRenaming(false); }, `Could not rename ${WORKSPACE_LABEL}.`);
    };
    const changePicture = (reset: boolean) => {
        if (!client || !canManage) return;
        void run('picture', async () => {
            const avatar = reset ? '' : await pickAndUploadAvatar(client);
            if (avatar === null) return;
            await client.setCommunityAvatar(workspaceId, avatar);
        }, reset ? `Could not reset ${WORKSPACE_LABEL} picture.` : `Could not set ${WORKSPACE_LABEL} picture.`);
    };
    const changeVisibility = (visibility: 'public' | 'invite-only') => {
        setSheet(null);
        if (!client || workspace?.visibility === visibility) return;
        void run('visibility', () => client.setCommunityVisibility(workspaceId, visibility), `Could not change ${WORKSPACE_LABEL} visibility.`);
    };
    const changeChatVisibility = (chat: ChatSetting) => {
        setSheet(null);
        void run(`room-${chat.id}`, async () => {
            await monolithPhoneOperation('updateRoom', { roomId: chat.id, visibility: chat.visibility === 'public' ? 'invite-only' : 'public' });
            if (chatListKey) refreshChatList(chatListKey);
        }, `Could not change ${ROOM_LABEL} visibility.`);
    };
    const joinChat = (chat: ChatSetting) => {
        const viewerId = chatListKey?.viewerPubkey;
        if (!viewerId) return;
        setSheet(null);
        void run(`room-${chat.id}`, async () => {
            await monolithPhoneOperation('addRoomMember', { roomId: chat.id, memberId: viewerId });
            if (chatListKey) refreshChatList(chatListKey);
            router.push(roomHref(chat.id, workspaceId));
        }, `Could not join ${roomTitle(chat.name) ?? chat.name}.`);
    };
    const deleteWorkspace = () => {
        if (!workspace || deleteText.trim() !== workspace.name || working === 'delete') return;
        const clear = deleteDraft.capture();
        setWorking('delete');
        setError(null);
        // Above the server's own transaction deadline (30 s): only a request that never answers times out.
        void monolithPhoneOperation('deleteWorkspace', { workspaceId }, { timeoutMs: 40_000 })
            .then(() => { clear(); setSheet(null); router.replace('/beeline/channels'); })
            .catch((caught) => { setError(appErrorCopy(caught, `Could not delete ${WORKSPACE_LABEL}.`)); setWorking(null); });
    };
    const copyJoinLink = () => {
        if (!joinUrl) { void loadJoinLink(); return; }
        void Clipboard.setStringAsync(joinUrl).then(() => setCopied(true));
    };

    if (!view || !workspace) return error ? <T v="meta" color="removed" testID="workspace-settings-retry">{error}</T>
        : <SurfaceGlyphLoader testID="workspace-settings-loader" />;
    const sheetChat = typeof sheet === 'object' && sheet ? chats.find((chat) => chat.id === sheet.room) : undefined;

    return (
        <YStack gap="5" testID={canManage ? 'workspace-settings-manage' : 'workspace-settings-read-only'}>
            {error ? <T v="meta" color="removed" testID="workspace-settings-error">{error}</T> : null}
            <Section title="Workspace picture">
                <XStack paddingVertical="3" gap="3" alignItems="center" testID="workspace-picture">
                    <IdentityMark kind="workspace" seed={workspace.id} avatarUrl={workspace.avatar} name={workspace.name} size={56} testID="workspace-picture-mark" />
                    <YStack flex={1} minWidth={0} gap="2">
                        <Copy small quiet>{workspace.avatar ? 'Uploaded picture' : 'Generated mark'}</Copy>
                        {canManage ? (
                            <XStack gap="2" flexWrap="wrap">
                                <Btn label="Upload picture" disabled={working === 'picture'} onPress={() => changePicture(false)} testID="workspace-picture-change">Upload picture</Btn>
                                {workspace.avatar ? <Btn label="Use generated mark" disabled={working === 'picture'} onPress={() => changePicture(true)} testID="workspace-picture-clear">Use generated mark</Btn> : null}
                            </XStack>
                        ) : null}
                    </YStack>
                </XStack>
            </Section>

            <Section title="General" testID="workspace-overview-settings">
                <Row label="Name" value={renaming ? undefined : workspace.name} testID="workspace-name-row"
                    onPress={canManage ? () => { nameDraft.initialize(workspace.name); setRenaming((value) => !value); } : undefined} />
                {renaming && canManage ? (
                    <YStack paddingVertical="3" gap="2" testID="workspace-name-editor">
                        <Input minHeight={HEIGHT.control} value={name} onChangeText={setName} onSubmitEditing={saveName} autoFocus maxLength={80} selectTextOnFocus
                            placeholder={`${WORKSPACE_LABEL} name`} aria-label={`New ${WORKSPACE_LABEL} name`} disabled={working === 'name'} testID="workspace-name-input" />
                        <XStack gap="2" justifyContent="flex-end">
                            <Btn kind="quiet" label="Cancel" disabled={working === 'name'} onPress={() => setRenaming(false)}>Cancel</Btn>
                            <Btn kind="primary" label="Save" disabled={!name.trim() || name.trim() === workspace.name || working === 'name'} onPress={saveName} testID="workspace-name-save">
                                {working === 'name' ? 'Saving…' : 'Save'}
                            </Btn>
                        </XStack>
                    </YStack>
                ) : null}
                <Row label="Visibility" value={workspace.visibility ? WORKSPACE_VISIBILITY_LABELS[workspace.visibility] : undefined}
                    detail="Invite-only keeps discovery closed. Existing members keep their access."
                    onPress={canManage && working !== 'visibility' ? () => setSheet('visibility') : undefined} testID="workspace-visibility-row"
                    last={workspace.visibility !== 'public' && !canManage} />
                {workspace.visibility === 'public' ? (
                    <Row label="Public join link" detail="Anyone with the link can join" testID="workspace-public-join-setting" last={!canManage}
                        right={<Btn label="Copy public join link" onPress={copyJoinLink} testID="workspace-public-join-copy">
                            <XStack gap="2" alignItems="center"><Glyph icon={copied ? Check : CopyIcon} size={16} accent={copied} /><T v="heading">{copied ? 'Copied' : 'Copy'}</T></XStack>
                        </Btn>} />
                ) : null}
                {canManage ? (
                    <Row label="Allow fix sweep" detail="Helps Beeline improve" testID="workspace-fix-sweep" last
                        right={<Switch checked={view.managerSettings?.allowFixSweep === true} aria-label="Allow fix sweep"
                            disabled={working !== null || typeof view.managerSettings?.allowFixSweep !== 'boolean'}
                            onCheckedChange={(allowFixSweep: boolean) => void run('fix-sweep', () => monolithPhoneOperation('updateWorkspace', { workspaceId, allowFixSweep }), `Could not update Allow fix sweep.`)}>
                            <Switch.Thumb />
                        </Switch>} />
                ) : null}
            </Section>

            {canManage && chats.length ? (
                <Section title="Chats" note={view.managerSettings?.roomsTruncated ? `Showing the first 200 ${ROOM_LABEL}s.` : undefined} testID="channel-visibility-settings">
                    {chats.map((chat, index) => (
                        <Row key={chat.id}
                            label={roomTitle(chat.name) ?? chat.name} detail={chat.joined === undefined ? undefined : chat.joined ? 'Joined' : 'Not joined'}
                            value={CHAT_VISIBILITY_LABELS[chat.visibility]} onPress={working === `room-${chat.id}` ? undefined : () => setSheet({ room: chat.id })}
                            testID={`room-visibility-${chat.id}`} last={index === chats.length - 1} />
                    ))}
                </Section>
            ) : null}

            {isWorkspaceOwnerRole(view.viewer.role) ? (
                <Section title="Danger">
                    <Row label={`Delete ${WORKSPACE_LABEL}`} tone="removed" onPress={() => setSheet('delete')} testID="workspace-delete-row" last />
                </Section>
            ) : null}

            <SheetFrame open={sheet === 'visibility'} close={() => setSheet(null)} title={`Who can find this ${WORKSPACE_LABEL}?`} testID="workspace-visibility-sheet">
                <Copy small quiet>Invite-only keeps discovery closed. Existing members keep their access.</Copy>
                {(['public', 'invite-only'] as const).map((visibility) => (
                    <SheetRow key={visibility} icon={workspace.visibility === visibility ? <Glyph icon={Check} accent /> : null}
                        label={WORKSPACE_VISIBILITY_LABELS[visibility]} onPress={() => changeVisibility(visibility)} testID={`workspace-visibility-${visibility}`} />
                ))}
            </SheetFrame>

            <SheetFrame open={Boolean(sheetChat)} close={() => setSheet(null)} title={sheetChat ? roomTitle(sheetChat.name) ?? sheetChat.name : ''} testID="room-sheet">
                {sheetChat ? (
                    <>
                        {sheetChat.joined === false ? <SheetRow icon={null} label={`Join ${ROOM_LABEL.toLowerCase()}`} detail="Adds you as a member and opens it." onPress={() => joinChat(sheetChat)} testID="room-sheet-join" /> : null}
                        {sheetChat.joined === true ? <SheetRow icon={null} chevron label={`Open ${ROOM_LABEL.toLowerCase()}`} onPress={() => { setSheet(null); router.push(roomHref(sheetChat.id, workspaceId)); }} testID="room-sheet-open" /> : null}
                        <SheetRow icon={null} label={`Make ${CHAT_VISIBILITY_LABELS[sheetChat.visibility === 'public' ? 'invite-only' : 'public']}`}
                            detail={sheetChat.visibility === 'public' ? 'Existing members keep their access.' : `Anyone in the ${WORKSPACE_LABEL} can find and join.`}
                            onPress={() => changeChatVisibility(sheetChat)} testID="room-sheet-visibility" />
                        <SheetRow icon={null} label={`Copy ${ROOM_LABEL} ID`} detail={sheetChat.id} onPress={() => { setSheet(null); void Clipboard.setStringAsync(sheetChat.id); }} testID="room-sheet-copy-id" />
                    </>
                ) : null}
            </SheetFrame>

            <SheetFrame open={sheet === 'delete'} close={() => { if (working !== 'delete') setSheet(null); }} title={`Delete ${WORKSPACE_LABEL}?`} testID="workspace-delete-sheet">
                <Copy small>{`This permanently deletes every ${ROOM_LABEL}, message, and member of "${workspace.name}". This cannot be undone. Type its name to confirm.`}</Copy>
                <Input minHeight={HEIGHT.control} value={deleteText} onChangeText={setDeleteText} autoCapitalize="none" autoCorrect={false} placeholder={workspace.name}
                    aria-label={`Type ${workspace.name} to confirm`} disabled={working === 'delete'} testID="workspace-delete-confirm-input" />
                <XStack gap="2" justifyContent="flex-end">
                    <Btn label="Cancel" disabled={working === 'delete'} onPress={() => setSheet(null)} testID="workspace-delete-cancel">Cancel</Btn>
                    <Btn kind="destructive" label={`Delete ${WORKSPACE_LABEL}`} disabled={working === 'delete' || deleteText.trim() !== workspace.name}
                        onPress={deleteWorkspace} testID="workspace-delete-confirm">{working === 'delete' ? 'Deleting…' : `Delete ${WORKSPACE_LABEL}`}</Btn>
                </XStack>
            </SheetFrame>
        </YStack>
    );
}
