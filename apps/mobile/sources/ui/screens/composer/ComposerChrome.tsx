import { localizeReportTimes } from '@beeline/api-contract/report-time';
import { useReaderZone } from '@/buzz/report-time';
import React, { useEffect, useRef } from 'react';
import { Card, Image, XStack, YStack } from 'tamagui';
import { CornerUpLeft, FileText } from 'lucide-react-native';
import { CloseButton } from '@/components/buzz/CloseGlyph';
import { VOICE_LONG_PRESS_MS } from '@beeline/api-contract/phone';
import { Waveform } from './Waveform';
import { Btn, Glyph, T } from '@/ui/grammar';

/**
 * The composer's grammar parts (build spec → Composer and suggestions). The
 * native text field and its measurement stay in `ConversationComposer.tsx`;
 * everything drawn around it lives here.
 */

/** The card: raised, large radius, a stroke that turns brass while the field has focus. */
export function ComposerFrame({ focused, pill = false, children }: { focused: boolean; pill?: boolean; children: React.ReactNode }) {
    return (
        <Card
            backgroundColor={pill ? 'transparent' : 'raised'}
            borderRadius="transcript"
            borderWidth={pill ? 0 : 1}
            borderColor={focused ? 'needsYou' : 'stroke'}
            padding={pill ? '0' : '1'}
            overflow="hidden"
            testID="composer-box"
        >
            {children}
        </Card>
    );
}

/** The one row of controls: + , the field, voice, go. A grown paragraph keeps the controls at its foot. */
export function ComposerControls({ multiline, testID, children }: { multiline: boolean; testID: string; children: React.ReactNode }) {
    return <XStack alignItems={multiline ? 'flex-end' : 'center'} gap="1" testID={testID}>{children}</XStack>;
}

/**
 * A round 44 control. `onHold` fires after the voice long-press hold
 * (VOICE_LONG_PRESS_MS) and swallows the tap that follows the release.
 */
export function ComposerButton({ label, hint, onPress, onHold, disabled, busy, selected, primary = false, dimmed = false, testID, children }: {
    label: string; hint?: string; onPress?: () => void; onHold?: () => void; disabled?: boolean; busy?: boolean;
    selected?: boolean; primary?: boolean; dimmed?: boolean; testID: string; children: React.ReactNode;
}) {
    const held = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(timer.current), []);
    return (
        <Btn
            kind="icon"
            label={label}
            accessibilityHint={hint}
            accessibilityState={{ disabled: Boolean(disabled), busy: Boolean(busy), selected }}
            aria-busy={Boolean(busy)}
            disabled={disabled}
            backgroundColor={primary ? 'primaryFill' : 'canvas'}
            opacity={disabled ? 0.5 : dimmed ? 0.4 : 1}
            testID={testID}
            onPressIn={onHold ? () => {
                held.current = false;
                clearTimeout(timer.current);
                timer.current = setTimeout(() => { held.current = true; onHold(); }, VOICE_LONG_PRESS_MS);
            } : undefined}
            onPressOut={onHold ? () => clearTimeout(timer.current) : undefined}
            onPress={() => {
                clearTimeout(timer.current);
                if (held.current) { held.current = false; return; }
                onPress?.();
            }}
        >
            {children}
        </Btn>
    );
}

type IconComponent = React.ComponentProps<typeof Glyph>['icon'];
/** A control's icon: secondary, or primary ink on the round send fill. */
export function ComposerGlyph({ icon, primary = false }: { icon: IconComponent; primary?: boolean }) {
    return primary ? <Glyph icon={icon} color="primaryInk" /> : <Glyph icon={icon} />;
}

/** While dictating, the field reads "Listening"; leading tags stay in view as text. */
export function ComposerListening({ tags, level, live, testID, tagsTestID }: { tags?: string; level: number; live: boolean; testID: string; tagsTestID: string }) {
    return (
        <XStack flex={1} minWidth={0} gap="2" alignItems="center" aria-label="Listening" testID={testID}>
            {tags ? <T v="body" color="secondary" numberOfLines={1} testID={tagsTestID}>{tags}</T> : null}
            <Waveform level={level} live={live} testID={`${testID}-level`} />
        </XStack>
    );
}

/** A quiet line under the field, tappable only when it leads somewhere. */
export function ComposerStatus({ text, onPress, testID }: { text: string; onPress?: () => void; testID: string }) {
    if (onPress)
        return (
            <Btn kind="quiet" label={text} onPress={onPress} justifyContent="flex-start" aria-live="polite" testID={testID}>
                <T v="meta" color="secondary">{text}</T>
            </Btn>
        );
    return (
        <YStack paddingHorizontal="3" paddingTop="1" paddingBottom="2" aria-label={text} aria-live="polite" testID={testID}>
            <T v="meta" color="secondary">{text}</T>
        </YStack>
    );
}

/** Inset for shared feedback inside the card. */
export function ComposerNote({ children }: { children: React.ReactNode }) {
    return <YStack paddingHorizontal="3" paddingTop="1" paddingBottom="2">{children}</YStack>;
}

/** Reply and file tray share the existing composer frame. */
export function ComposerAdjuncts({ testID, children }: { testID: string; children: React.ReactNode }) {
    return <YStack testID={testID}>{children}</YStack>;
}

export function ComposerReply({ handle, preview, onCancel }: { handle: string; preview: string; onCancel?: () => void }) {
    const zone = useReaderZone();
    return (
        <XStack gap="2" alignItems="center" paddingLeft="2" borderBottomWidth={1} borderColor="stroke" testID="reply-composer-banner">
            <Glyph icon={CornerUpLeft} size={16} />
            <T flex={1} minWidth={0} v="meta" color="secondary" numberOfLines={1}>
                <T v="metaStrong" color="needsYou">@{handle}</T> {localizeReportTimes(preview, zone)}
            </T>
            <CloseButton accessibilityLabel="Cancel reply" onPress={onCancel} testID="reply-composer-cancel" />
        </XStack>
    );
}

export function ComposerAttachment({ index, uri, name, mimeType, uploadState, busy, onRetry, onRemove }: {
    index: number; uri: string; name: string; sizeLabel: string; mimeType: string;
    uploadState?: 'uploading' | 'uploaded' | 'failed'; busy: boolean; onRetry: () => void; onRemove: () => void;
}) {
    const failed = uploadState === 'failed';
    const uploading = uploadState !== 'uploaded' && !failed;
    return (
        <XStack gap="2" height={48} flexShrink={0} testID={`pending-chat-attachment-${index}`}>
        <YStack position="relative" width={48} height={48}>
            <YStack width={48} height={48} borderRadius="house" backgroundColor={mimeType.startsWith('image/') ? 'transparent' : 'raised'} overflow="hidden" opacity={uploading ? 0.4 : 1}
                accessible accessibilityLiveRegion="polite" accessibilityState={{ busy: uploading }}
                alignItems="center" justifyContent="center" aria-label={`${name}, ${failed ? 'upload failed' : uploading ? 'uploading' : 'ready'}`}>
                {mimeType.startsWith('image/')
                    ? <Image src={uri} width={48} height={48} resizeMode="cover" />
                    : <Glyph icon={FileText} />}
            </YStack>
            <CloseButton control position="absolute" top={2} right={2} accessibilityLabel={`Remove ${name}`} disabled={busy} onPress={onRemove} testID={`pending-chat-attachment-remove-${index}`} />
        </YStack>
            {failed && <Btn kind="quiet" label={`Retry uploading ${name}`} disabled={busy} onPress={onRetry} testID={`pending-chat-attachment-retry-${index}`}><T v="meta">Retry</T></Btn>}
        </XStack>
    );
}
