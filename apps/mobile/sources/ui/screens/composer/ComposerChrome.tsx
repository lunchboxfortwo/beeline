import React, { useEffect, useRef } from 'react';
import { Card, XStack, YStack } from 'tamagui';
import { CornerUpLeft, FileText, X } from 'lucide-react-native';
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
            borderRadius="lg"
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

/** The reply and the staged files sit above the card, each in its own raised card. */
export function ComposerAdjuncts({ testID, children }: { testID: string; children: React.ReactNode }) {
    return <YStack gap="2" marginBottom="2" testID={testID}>{children}</YStack>;
}

export function ComposerReply({ handle, preview, onCancel }: { handle: string; preview: string; onCancel?: () => void }) {
    return (
        <Card backgroundColor="raised" borderWidth={1} borderColor="stroke" borderRadius="md" padding="2" paddingLeft="3" testID="reply-composer-banner">
            <XStack gap="2" alignItems="center">
                <Glyph icon={CornerUpLeft} size={16} accent />
                <YStack flex={1} minWidth={0}>
                    <T v="meta" color="secondary" numberOfLines={1}>Replying to <T v="metaStrong" color="needsYou">@{handle}</T></T>
                    <T v="meta" color="ink" numberOfLines={1}>{preview}</T>
                </YStack>
                <Btn kind="icon" label="Cancel reply" onPress={onCancel} testID="reply-composer-cancel"><Glyph icon={X} size={18} /></Btn>
            </XStack>
        </Card>
    );
}

export function ComposerAttachment({ index, name, sizeLabel, mimeType, uploadState, busy, onRetry, onRemove }: {
    index: number; name: string; sizeLabel: string; mimeType: string;
    uploadState?: 'uploading' | 'uploaded' | 'failed'; busy: boolean; onRetry: () => void; onRemove: () => void;
}) {
    const failed = uploadState === 'failed';
    return (
        <Card backgroundColor="raised" borderWidth={1} borderColor="stroke" borderRadius="md" padding="2" paddingLeft="3" testID={`pending-chat-attachment-${index}`}>
            <XStack gap="2" alignItems="center">
                <Glyph icon={FileText} />
                <YStack flex={1} minWidth={0}>
                    <T v="meta" color="ink" numberOfLines={1}>{name}</T>
                    <T v="meta" color="secondary" numberOfLines={1} testID={`pending-chat-attachment-meta-${index}`}>
                        <T v="meta" color={failed ? 'removed' : 'secondary'} testID={`pending-chat-attachment-state-${index}`}>
                            {uploadState === 'uploaded' ? 'Ready' : failed ? 'Upload failed' : 'Uploading…'}
                        </T>{' '}
                        · {sizeLabel} · {mimeType.toUpperCase()}
                    </T>
                </YStack>
                {failed ? (
                    <Btn kind="secondary" label={`Retry uploading ${name}`} disabled={busy} onPress={onRetry} testID={`pending-chat-attachment-retry-${index}`}>
                        <T v="metaStrong">Retry</T>
                    </Btn>
                ) : null}
                <Btn kind="icon" label={`Remove ${name}`} disabled={busy} onPress={onRemove} testID={`pending-chat-attachment-remove-${index}`}>
                    <Glyph icon={X} size={18} />
                </Btn>
            </XStack>
        </Card>
    );
}

export function ComposerMoreAttachments({ count }: { count: number }) {
    return <YStack paddingHorizontal="3" testID="pending-chat-attachments-more"><T v="meta" color="needsYou">{count} more</T></YStack>;
}
