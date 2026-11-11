import React from 'react';
import { Card, ListItem, Separator, XStack, YStack } from 'tamagui';
import { ExternalLink, Globe, Keyboard, X as XIcon } from 'lucide-react-native';
import { Btn, Copy, Glyph, SafeBottom, SafeTop } from '@/ui/grammar';
import { ViewerAction } from './ViewerChrome';

/**
 * The shared browser (build spec → decision 19, frames r5-browser-card,
 * r5-browser, r12-browser-keys): a card in the transcript and a viewer with a
 * key bar. The live stream itself is drawn by `ComputerSession.tsx`.
 */
export function BrowserCard({ status, title, live, frame, onOpen, testID }: {
    status: 'live' | 'ended' | string;
    title: string;
    /** Streaming access exists: the frame and Open are offered. */
    live: boolean;
    /** The live preview stream, or nothing while it is off screen. */
    frame: React.ReactNode;
    onOpen: () => void;
    testID: string;
}) {
    const ended = status === 'ended';
    return (
        <Card backgroundColor="raised" borderWidth={1} borderColor="stroke" padding="3" gap="3" marginTop="2" testID={testID}>
            {live ? (
                <ListItem padding="0" backgroundColor="canvas" onPress={onOpen} accessibilityRole="button" aria-label={`Open ${title} browser`} accessibilityLabel={`Open ${title} browser`}>
                    <YStack height={170} width="100%" borderRadius="md" borderWidth={1} borderColor="stroke" backgroundColor="canvas" overflow="hidden" pointerEvents="none" testID="computer-session-preview">
                        {frame}
                    </YStack>
                </ListItem>
            ) : null}
            <YStack gap="1">
                <Copy strong numberOfLines={1}>{title}</Copy>
                <XStack gap="2" alignItems="center">
                    {ended ? null : <YStack width={8} height={8} borderRadius="full" backgroundColor="added" />}
                    <Copy small quiet>{ended ? 'Session ended' : 'Live browser'}</Copy>
                </XStack>
            </YStack>
            {live ? (
                <XStack justifyContent="flex-end">
                    <Btn kind="secondary" label="Open shared browser" onPress={onOpen} testID="computer-session-open">Open</Btn>
                </XStack>
            ) : null}
        </Card>
    );
}

/** The viewer: globe, “Shared browser”, keyboard toggle, Open in browser, close; then the page. */
export function BrowserViewerFrame({ keysOpen, onToggleKeys, onOpenInBrowser, onClose, stream, keyBar, dock, safeArea }: {
    keysOpen: boolean;
    /** Absent where the page takes the device keyboard directly (desktop web). */
    onToggleKeys?: () => void;
    onOpenInBrowser?: () => void;
    onClose: () => void;
    stream: React.ReactNode;
    keyBar: React.ReactNode;
    dock: React.ReactNode;
    /** Phone viewers cover both system bars. */
    safeArea: boolean;
}) {
    return (
        <YStack flex={1} minHeight={0} backgroundColor="canvas" testID="computer-session-viewer">
            {safeArea ? <SafeTop /> : null}
            <XStack paddingHorizontal="3" paddingTop="3" paddingBottom="2" gap="2" alignItems="center" testID="computer-session-controls">
                <Glyph icon={Globe} />
                <YStack flex={1} minWidth={0}><Copy strong numberOfLines={1}>Shared browser</Copy></YStack>
                {onToggleKeys ? (
                    <Btn kind="icon" label="Keyboard controls" aria-pressed={keysOpen} borderWidth={1} borderColor={keysOpen ? 'needsYou' : 'strongStroke'}
                        onPress={onToggleKeys} testID="computer-session-keyboard-toggle">
                        <Glyph icon={Keyboard} size={16} accent={keysOpen} />
                    </Btn>
                ) : null}
                {onOpenInBrowser ? (
                    <ViewerAction label="Open in browser" title="Open in browser" icon={ExternalLink} onPress={onOpenInBrowser} testID="computer-session-open-browser" />
                ) : null}
                <Btn kind="icon" label="Close browser" onPress={onClose} testID="computer-session-close"><Glyph icon={XIcon} /></Btn>
            </XStack>
            <Separator borderColor="stroke" />
            <YStack flex={1} minHeight={0} padding="3">
                <YStack flex={1} minHeight={0} borderRadius="md" borderWidth={1} borderColor="stroke" overflow="hidden" backgroundColor="canvas">{stream}</YStack>
            </YStack>
            {keyBar}
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
