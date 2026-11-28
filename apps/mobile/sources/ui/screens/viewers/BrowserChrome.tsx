import React from 'react';
import { Card, ListItem, XStack, YStack } from 'tamagui';
import { ExternalLink, ChevronRight } from 'lucide-react-native';
import { Btn, Copy, Glyph, SafeBottom, T } from '@/ui/grammar';
import { ViewerAction, ViewerHeader } from './ViewerChrome';

/** Pre-redesign browser card geometry, with Stone grammar surfaces and type. */
export function BrowserCard({ status, title, live, frame, onOpen, onOpenInBrowser, onRecheck, checking = false, testID }: {
    status: 'live' | 'ended' | 'unavailable' | string;
    title: string;
    /** Streaming access exists: the frame and Open are offered. */
    live: boolean;
    /** The live preview stream, or nothing while it is off screen. */
    frame: React.ReactNode;
    onOpen: () => void;
    onOpenInBrowser?: () => void;
    onRecheck?: () => void;
    checking?: boolean;
    testID: string;
}) {
    const ended = status === 'ended';
    const unavailable = status === 'unavailable';
    return (
        <Card backgroundColor="canvas" borderWidth={1} borderColor="strongStroke" borderRadius="transcript" overflow="hidden" width="100%" marginTop="2" testID={testID}>
            <ListItem padding="0" backgroundColor="canvas" onPress={live ? onOpen : undefined} accessibilityRole={live ? "button" : undefined} accessibilityLabel={live ? `Open ${title} browser` : title}>
                <YStack flex={1}>
                    {frame ? <YStack height={live ? 218 : 1} width={live ? "100%" : 1} opacity={live ? 1 : 0} position={live ? "relative" : "absolute"} overflow="hidden" backgroundColor="canvas" pointerEvents="none" testID={live ? "computer-session-preview" : "computer-session-probe"}>{frame}</YStack> : null}
                    <YStack paddingHorizontal="4" paddingVertical="2" gap="1"><Copy strong numberOfLines={1}>{title}</Copy><Copy small quiet>{ended ? 'Session ended' : unavailable ? 'Browser unavailable' : 'Live browser'}</Copy></YStack>
                </YStack>
            </ListItem>
            {live ? <XStack borderTopWidth={1} borderColor="stroke" paddingHorizontal="4" paddingVertical="2" alignItems="center" justifyContent="space-between">
                <Btn kind="quiet" padding={0} label="Open in browser" accessibilityRole="link" role="link" onPress={onOpenInBrowser} testID="computer-session-card-open-browser"><XStack gap="2" alignItems="center"><T v="meta" color="secondary">Open in browser</T><Glyph icon={ExternalLink} size={14}/></XStack></Btn>
                <Btn kind="quiet" label="Open live browser" accessibilityRole="link" role="link" onPress={onOpen} testID="computer-session-open"><XStack gap="2" alignItems="center"><T v="meta" color="needsYou">Open</T><Glyph icon={ChevronRight} size={14}/></XStack></Btn>
            </XStack> : unavailable && onRecheck ? <XStack borderTopWidth={1} borderColor="stroke" paddingHorizontal="4" paddingVertical="2" alignItems="center" justifyContent="flex-end">
                <Btn kind="quiet" padding={0} label="Check browser again" onPress={onRecheck} disabled={checking} testID="computer-session-recheck"><T v="meta" color="needsYou">{checking ? 'Checking…' : 'Check again'}</T></Btn>
            </XStack> : null}
        </Card>
    );
}

/** Unified browser viewer frame: live status dot, session title, Open in browser, Close, and bottom hairline. */
export function BrowserViewerFrame({
    title = 'Browser',
    live = false,
    ended = false,
    unavailable = false,
    onOpenInBrowser,
    onClose,
    stream,
    dock,
    safeArea,
    desktop = false,
}: {
    title?: string;
    live?: boolean;
    ended?: boolean;
    unavailable?: boolean;
    onOpenInBrowser?: () => void;
    onClose: () => void;
    stream: React.ReactNode;
    dock: React.ReactNode;
    /** Phone viewers cover both system bars. */
    safeArea: boolean;
    /** Desktop panes share the 52 px top-bar baseline with PlaceHeader and SidebarView. */
    desktop?: boolean;
}) {
    const detail = ended
        ? 'Session ended'
        : unavailable
            ? 'Browser unavailable'
            : live
                ? 'Live session'
                : 'Connecting…';
    return (
        <YStack flex={1} minHeight={0} backgroundColor="canvas" testID="computer-session-viewer">
            <ViewerHeader
                desktop={desktop}
                safeTop={safeArea}
                title={title}
                detail={detail}
                titleTestID="computer-session-title"
                detailTestID="computer-session-status"
                leading={live ? (
                    <YStack
                        width={8}
                        height={8}
                        borderRadius="full"
                        backgroundColor="added"
                        testID="computer-session-live-dot"
                    />
                ) : null}
                onClose={onClose}
                closeLabel="Close browser"
                closeTestID="computer-session-close"
                testID="computer-session-controls"
            >
                {onOpenInBrowser ? (
                    <ViewerAction
                        label="Open in browser"
                        title="Open in browser"
                        icon={ExternalLink}
                        onPress={onOpenInBrowser}
                        testID="computer-session-open-browser"
                    />
                ) : null}
            </ViewerHeader>
            <YStack flex={1} minHeight={0}>{stream}</YStack>
            {safeArea ? <SafeBottom /> : null}
            {dock}
        </YStack>
    );
}

/** One quiet centred line inside the stream box: connecting, ended, unavailable. */
export function BrowserStreamNote({ text, testID }: { text: string; testID?: string }) {
    return (
        <YStack flex={1} alignItems="center" justifyContent="center" padding="4" testID={testID}>
            <Copy quiet textAlign="center">{text}</Copy>
        </YStack>
    );
}
