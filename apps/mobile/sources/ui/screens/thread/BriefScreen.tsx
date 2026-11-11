import React, { useEffect, useState } from 'react';
import { ListItem, Separator, Spinner, XStack, YStack } from 'tamagui';
import { isRoomView, type SurfaceCacheAddress } from '@beeline/buzz-client';
import type { Identity } from '@beeline/buzz-client';
import type { RoomView } from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { appReadErrorCopy } from '@/buzz/app-error-copy';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { useSurfaceSnapshot } from '@/buzz/use-shared-surface';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { openExternalUrl } from '@/utils/open-external-url';
import { Copy, Screen, T } from '@/ui/grammar';
import { briefBlocks, briefSpans, type BriefBlock } from './brief-blocks';

type Brief = NonNullable<RoomView['cornerBrief']>;

/**
 * The thread's RoomView from the one surface registry: the open thread has
 * already painted it, so the brief shows at once and follows live updates.
 * Only a cold open (a link) reads it, once, through the live socket.
 */
function useBriefRoomView(roomId: string) {
    const [address, setAddress] = useState<SurfaceCacheAddress | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let cancelled = false;
        setAddress(null);
        setError(null);
        if (!roomId) return;
        void Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]).then(async ([identity, relay]) => {
            if (cancelled || !identity) return;
            const next = surfaceAddress(relay, identity.publicKey, `/room/${roomId}`);
            setAddress(next);
            const held = await mobileSurfaceCache.read(next, isRoomView);
            if (held || cancelled) return;
            await mobileSurfaceCache.fetch(next, isRoomView, () =>
                new RoomViewClient({ baseUrl: relay, identity: identity as Identity }).room(roomId));
        }).catch((reason) => { if (!cancelled) setError(appReadErrorCopy(reason)); });
        return () => { cancelled = true; };
    }, [roomId]);
    const view = useSurfaceSnapshot(address, isRoomView);
    return { view, error };
}

function Spans({ text, v = 'body' }: { text: string; v?: 'body' | 'heading' }) {
    const spans = briefSpans(text);
    if (spans.every((span) => !span.code)) return <T v={v}>{text}</T>;
    return <T v={v}>{spans.map((span, index) => span.code
        ? <T key={index} v="code" color="needsYou">{span.text}</T>
        : <React.Fragment key={index}>{span.text}</React.Fragment>)}</T>;
}

function Block({ block }: { block: BriefBlock }) {
    switch (block.kind) {
        case 'title': return <T v="title">{block.text}</T>;
        case 'heading': return <Spans v="heading" text={block.text} />;
        case 'bullet': return <Spans text={`· ${block.text}`} />;
        case 'code': return (
            <YStack padding="3" borderRadius="md" borderWidth={1} borderColor="stroke" backgroundColor="raised">
                <T v="code">{block.text}</T>
            </YStack>
        );
        default: return <Spans text={block.text} />;
    }
}

function BriefBody({ brief }: { brief: Brief }) {
    const blocks = briefBlocks(brief.spec);
    return (
        <>
            {blocks.length ? <YStack gap="3" testID="brief-spec">{blocks.map((block, index) => <Block key={index} block={block} />)}</YStack> : null}
            {brief.approval ? (
                <>
                    <Separator borderColor="stroke" />
                    <YStack gap="2" testID="brief-approval">
                        <Copy strong>Approval</Copy>
                        <Copy small quiet>{`Approved by ${brief.approval.approverName}, message ${brief.approval.sourceMessageId}:`}</Copy>
                        <YStack paddingLeft="3" borderLeftWidth={2} borderColor="needsYou"><Copy>{brief.approval.text}</Copy></YStack>
                    </YStack>
                </>
            ) : null}
            {brief.attachments.length ? (
                <>
                    <Separator borderColor="stroke" />
                    <YStack gap="2" testID="brief-files">
                        <Copy strong>Files</Copy>
                        {brief.attachments.map((file, index) => {
                            const purpose = file.purpose.trim();
                            const detail = `${purpose ? ` — ${purpose}` : ''}${file.required ? ' · required' : ''}`;
                            return (
                                <ListItem key={`${file.url}:${index}`} padding="0" paddingVertical="1" backgroundColor="transparent" justifyContent="flex-start"
                                    onPress={() => void openExternalUrl(file.url)} aria-label={`Open ${file.title.trim() || file.url}`} accessibilityRole="link">
                                    <XStack flex={1} minWidth={0}>
                                        <T v="meta"><T v="code" color="needsYou">{file.title.trim() || file.url}</T>{detail}</T>
                                    </XStack>
                                </ListItem>
                            );
                        })}
                    </YStack>
                </>
            ) : null}
        </>
    );
}

/** The thread's brief: "Brief · revision N", the spec, the approval quoted exactly, then the files. */
export function BriefScreen({ roomId, close }: { roomId: string; close: () => void }) {
    const { view, error } = useBriefRoomView(roomId);
    const brief = view?.cornerBrief;
    return (
        <Screen title={brief ? `Brief · revision ${brief.revision}` : 'Brief'} back={close} testID="brief">
            {brief ? <BriefBody brief={brief} />
                : error ? <Copy quiet>{error}</Copy>
                    : view ? <Copy quiet>This corner has no brief yet</Copy>
                        : <Spinner size="small" color="secondary" />}
        </Screen>
    );
}
