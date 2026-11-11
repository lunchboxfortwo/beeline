import React from 'react';
import { Card, ScrollView, Separator, XStack, YStack } from 'tamagui';
import { ChevronLeft, ChevronRight, ExternalLink, Minus, Plus, X } from 'lucide-react-native';
import { Btn, Copy, Glyph, HEIGHT, SafeBottom, SafeTop, T } from '@/ui/grammar';

type IconComponent = React.ComponentProps<typeof Glyph>['icon'];

/**
 * The viewers' one frame (build spec → Viewers): a title, the actions this
 * file supports, a close X, then the body. Phone viewers fill the screen;
 * desktop viewers fill the right panel. Byte loading stays in the mechanics
 * files that render these pieces.
 */
export function ViewerScreen({ children, testID }: { children: React.ReactNode; testID: string }) {
    return <YStack flex={1} minHeight={0} backgroundColor="canvas" testID={testID}>{children}</YStack>;
}

export function ViewerHeader({ title, detail, leading, children, onClose, closeLabel, closeTestID, safeTop = false, testID, titleTestID = 'viewer-title', detailTestID = 'viewer-detail' }: {
    title: string;
    detail?: string;
    titleTestID?: string;
    detailTestID?: string;
    leading?: React.ReactNode;
    children?: React.ReactNode;
    onClose: () => void;
    closeLabel: string;
    closeTestID: string;
    /** Phone viewers cover the status bar, so the header clears it. */
    safeTop?: boolean;
    testID?: string;
}) {
    return (
        <>
            {safeTop ? <SafeTop /> : null}
            <XStack paddingHorizontal="3" paddingTop="3" paddingBottom="2" gap="2" alignItems="center" backgroundColor="canvas" testID={testID}>
                {leading}
                <YStack flex={1} minWidth={0}>
                    <Copy strong numberOfLines={1} testID={titleTestID}>{title}</Copy>
                    {detail ? <Copy small quiet numberOfLines={1} testID={detailTestID}>{detail}</Copy> : null}
                </YStack>
                {children}
                <Btn kind="icon" label={closeLabel} onPress={onClose} testID={closeTestID}><Glyph icon={X} /></Btn>
            </XStack>
            <Separator borderColor="stroke" />
        </>
    );
}

/** A small secondary header action: Copy, Share, Reopen, Open in browser. */
export function ViewerAction({ label, title, icon, onPress, testID, disabled }: {
    /** The accessible name. */
    label: string;
    /** The visible word. */
    title: string;
    icon?: IconComponent;
    onPress: () => void;
    testID?: string;
    disabled?: boolean;
}) {
    return (
        <Btn kind="secondary" label={label} onPress={onPress} testID={testID} disabled={disabled} paddingHorizontal="3">
            <XStack gap="2" alignItems="center">
                {icon ? <Glyph icon={icon} size={16} color="ink" /> : null}
                <T v="metaStrong">{title}</T>
            </XStack>
        </Btn>
    );
}

export function ViewerBody({ children }: { children: React.ReactNode }) {
    return <YStack flex={1} minHeight={0}>{children}</YStack>;
}

/** A scrolling reading column (code, Markdown, the brief) that clears the home indicator. */
export function ViewerScroll({ children, testID }: { children: React.ReactNode; testID: string }) {
    return (
        <ScrollView flex={1} minHeight={0} testID={testID}>
            <YStack padding="4" gap="3" paddingBottom="8" width="100%" maxWidth={760} alignSelf="center">{children}</YStack>
            <SafeBottom />
        </ScrollView>
    );
}

/** The quiet line over code: the file path or language. */
export function ViewerInscription({ children }: { children: string }) {
    return <T v="code" color="secondary">{children}</T>;
}

/** Loading, centred and quiet. */
export function ViewerPlaceholder({ text, testID }: { text: string; testID: string }) {
    return (
        <YStack flex={1} alignItems="center" justifyContent="center" padding="4" testID={testID}>
            <Copy small quiet textAlign="center">{text}</Copy>
        </YStack>
    );
}

/** A file the viewer cannot paint, or a read the server refused: say so, offer the browser. */
export function ViewerNotice({ title, message, onOpenInBrowser, testID }: {
    title: string;
    message?: string;
    onOpenInBrowser?: () => void;
    testID: string;
}) {
    return (
        <YStack padding="4" testID={testID}>
            <Card backgroundColor="raised" borderWidth={1} borderColor="stroke" padding="4" gap="2" alignItems="flex-start">
                <Copy strong>{title}</Copy>
                {message ? <Copy small quiet testID={`${testID}-message`}>{message}</Copy> : null}
                {onOpenInBrowser ? (
                    <ViewerAction label="Open in browser" title="Open in browser" icon={ExternalLink} onPress={onOpenInBrowser} testID={`${testID}-open-browser`} />
                ) : null}
            </Card>
        </YStack>
    );
}

/** Image zoom: −, the percentage, +, Reset. */
export function ZoomBar({ scale, canZoomIn, onZoomOut, onZoomIn, onReset, testIDPrefix }: {
    scale: number;
    canZoomIn: boolean;
    onZoomOut: () => void;
    onZoomIn: () => void;
    onReset: () => void;
    testIDPrefix: string;
}) {
    const percent = Math.round(scale * 100);
    return (
        <YStack backgroundColor="canvas">
            <XStack gap="2" alignItems="center" justifyContent="center" paddingVertical="2" testID={`${testIDPrefix}-zoom`}>
                <Btn kind="icon" label="Zoom out" accessibilityState={{ disabled: scale <= 1 }} disabled={scale <= 1} onPress={onZoomOut} testID={`${testIDPrefix}-zoom-out`}>
                    <Glyph icon={Minus} size={16} />
                </Btn>
                <Copy small quiet aria-label={`Image zoom ${percent} percent`} accessibilityLabel={`Image zoom ${percent} percent`}>{`${percent}%`}</Copy>
                <Btn kind="icon" label="Zoom in" accessibilityState={{ disabled: !canZoomIn }} disabled={!canZoomIn} onPress={onZoomIn} testID={`${testIDPrefix}-zoom-in`}>
                    <Glyph icon={Plus} size={16} />
                </Btn>
                <Btn kind="secondary" label="Reset image zoom" accessibilityState={{ disabled: scale === 1 }} disabled={scale === 1} onPress={onReset} testID={`${testIDPrefix}-zoom-reset`}>
                    <T v="metaStrong">Reset</T>
                </Btn>
            </XStack>
            <SafeBottom />
        </YStack>
    );
}

/** Previous / position / next for a message's group of photos. */
export function PhotoStepper({ index, count, onPrevious, onNext }: { index: number; count: number; onPrevious: () => void; onNext: () => void }) {
    return (
        <XStack gap="2" alignItems="center" justifyContent="center" minHeight={HEIGHT.control}>
            <Btn kind="icon" label="Previous photo" onPress={onPrevious} testID="artifact-viewer-photo-previous"><Glyph icon={ChevronLeft} /></Btn>
            <Copy small quiet aria-label={`Photo ${index + 1} of ${count}`} accessibilityLabel={`Photo ${index + 1} of ${count}`} accessibilityLiveRegion="polite" testID="artifact-viewer-photo-position">
                {`${index + 1} of ${count}`}
            </Copy>
            <Btn kind="icon" label="Next photo" onPress={onNext} testID="artifact-viewer-photo-next"><Glyph icon={ChevronRight} /></Btn>
        </XStack>
    );
}
