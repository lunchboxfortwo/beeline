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
export function ViewerAction({ label, title, icon, onPress, testID, disabled, compact = false }: {
    /** The accessible name. */
    label: string;
    /** The visible word. */
    title: string;
    icon?: IconComponent;
    onPress: () => void;
    testID?: string;
    disabled?: boolean;
    /** Icon only: a paged viewer's header also carries “2 of 5”, so the title keeps its room. */
    compact?: boolean;
}) {
    if (compact && icon) {
        return <Btn kind="icon" label={label} onPress={onPress} testID={testID} disabled={disabled}><Glyph icon={icon} color="ink" /></Btn>;
    }
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

/**
 * Paging through a message's files (approved stacked mock): the file the
 * viewer shows, its place, and a step that wraps at both ends. One file, or
 * no group, never pages.
 */
export function useFilePaging<F extends { url: string }>(initial: F | undefined, group: readonly F[] | undefined) {
    const files = initial && group && group.length > 1 ? group : undefined;
    const start = () => Math.max(0, files?.findIndex((file) => file.url === initial?.url) ?? 0);
    const [paging, setPaging] = React.useState(() => ({ initial, files, index: start() }));
    // A new selection (the desktop pane keeps its instance) starts on its own file.
    const current = paging.initial === initial && paging.files === files;
    if (!current) setPaging({ initial, files, index: start() });
    const index = current ? paging.index : start();
    const file = files?.[index] ?? initial;
    const step = React.useCallback((direction: -1 | 1) => {
        if (files) setPaging((state) => ({ ...state, index: (state.index + direction + files.length) % files.length }));
    }, [files]);
    return { file, index, count: files?.length ?? 1, paged: Boolean(files), step };
}

/** “2 of 5” at the header's end: where this file sits in its message. */
export function ViewerPosition({ index, count, noun }: { index: number; count: number; noun: 'photo' | 'file' }) {
    const label = `${noun === 'photo' ? 'Photo' : 'File'} ${index + 1} of ${count}`;
    return (
        <T v="code" aria-label={label} accessibilityLabel={label} accessibilityLiveRegion="polite" testID="artifact-viewer-photo-position">
            {`${index + 1} of ${count}`}
        </T>
    );
}

/** The pager under the body: previous, one dot per file, next. */
export function ViewerPager({ index, count, noun, onPrevious, onNext }: {
    index: number; count: number; noun: 'photo' | 'file'; onPrevious: () => void; onNext: () => void;
}) {
    return (
        <>
            <Separator borderColor="stroke" />
            <XStack paddingHorizontal="3" paddingVertical="1" alignItems="center" justifyContent="space-between" backgroundColor="canvas" testID="artifact-viewer-pager">
                <Btn kind="icon" label={`Previous ${noun}`} onPress={onPrevious} testID="artifact-viewer-photo-previous"><Glyph icon={ChevronLeft} color="ink" /></Btn>
                <XStack flexShrink={1} flexWrap="wrap" justifyContent="center" gap="2" importantForAccessibility="no-hide-descendants" aria-hidden>
                    {Array.from({ length: count }, (_, dot) => (
                        <YStack key={dot} width={6} height={6} borderRadius="full"
                            // The accent, as the stacked mock: brass in Brass, neutral in Stone.
                            backgroundColor={dot === index ? 'needsYou' : 'strongStroke'}
                            testID={dot === index ? 'artifact-viewer-dot-current' : 'artifact-viewer-dot'} />
                    ))}
                </XStack>
                <Btn kind="icon" label={`Next ${noun}`} onPress={onNext} testID="artifact-viewer-photo-next"><Glyph icon={ChevronRight} color="ink" /></Btn>
            </XStack>
        </>
    );
}
