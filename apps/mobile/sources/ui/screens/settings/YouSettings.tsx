import React, { useState } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { Label, RadioGroup, Separator, Spinner, Switch, ToggleGroup, XStack, YStack } from 'tamagui';
import { PUSH_LEVELS, type PushLevel } from '@beeline/api-contract/phone';
import { Btn, Copy, HEIGHT, Row, Section, T } from '@/ui/grammar';
import { IdentityMark, isPersonPictureUrl } from '@/components/buzz/IdentityMark';
import { ServiceMark } from '@/components/buzz/ServiceMark';
import { BeelineMark } from '@/components/buzz/BeelineMark';
import { useLocalSettingMutable } from '@/sync/storage';
import { applyAppearanceChoice } from '@/display';
import { APP_UI_SIZE_LABELS, APP_UI_SIZE_OPTIONS } from '@/ui-size';
import { roomOpenTraceEnabled } from '@/buzz/room-open-trace';
import { openExternalUrl } from '@/utils/open-external-url';
import { ChoiceSheet } from './ChoiceSheet';
import type { YouSettings as You } from './useYouSettings';

const PRIVACY_URL = 'https://usebeeline.app/privacy/';
const TERMS_URL = 'https://usebeeline.app/terms/';
const FEEDBACK_MAILTO = 'mailto:hello@usebeeline.app';
const PUSH_LEVEL_LABELS: Readonly<Record<PushLevel, string>> = { off: 'Off', attention: 'Attention (default)', full: 'Full' };
const PUSH_LEVEL_DETAILS: Readonly<Record<PushLevel, string>> = {
    off: 'No push notifications.',
    attention: 'Tags, DMs and replies to you, from people or agents.',
    full: 'Everything in Attention, plus every human message and every final agent reply in all your chats and threads.',
};
const SPEAKING_SPEED_LABELS = { 1.15: 'Normal', 1.3: 'Medium', 1.5: 'Fast' } as const;
const APPEARANCES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as const;
const PALETTES = [['brass', 'Brass', 'Aubergine, Bone and brass. Default.'], ['stone', 'Stone', 'Neutral Stone on the same components.']] as const;
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const open = (url: string) => () => void openExternalUrl(url).catch(() => undefined);

/** A destructive row: the label in removed ink, nothing else. */
function DangerRow({ label, onPress, testID, last }: { label: string; onPress: () => void; testID?: string; last?: boolean }) {
    return <Row label={label} tone="removed" onPress={onPress} testID={testID} last={last} />;
}

/** Settings → You: picture, connectors, this device, and the account. */
export function YouSettings({ you }: { you: You }) {
    const [appearance, setAppearance] = useLocalSettingMutable('appearance');
    const [uiSize, setUiSize] = useLocalSettingMutable('uiSize');
    const [palette, setPalette] = useLocalSettingMutable('palette');
    const [roomOpenTrace, setRoomOpenTrace] = useLocalSettingMutable('roomOpenTraceOverlay');
    const [sheet, setSheet] = useState<'push' | 'size' | 'speed' | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const hasPhoto = isPersonPictureUrl(you.avatar);
    const sizeLabel = Platform.OS === 'web' ? 'Interface size' : 'Text size';
    const providers = you.providers;
    const connectors = you.workbench ? [you.workbench.value, you.workbench.attention].filter(Boolean).join(' · ') : undefined;

    return (
        <YStack gap="5">
            <Section title="Profile picture">
                <XStack paddingVertical="3" gap="3" alignItems="center" testID="profile-picture">
                    <IdentityMark kind="human" seed={you.pubkey ?? 'pending-profile'} name={you.name || undefined} handle={you.handle || undefined} avatarUrl={you.avatar} size={56} testID="profile-picture-mark" />
                    <YStack flex={1} minWidth={0} gap="2">
                        <Copy small quiet>{hasPhoto ? 'Your photo' : 'Your generated mark'}</Copy>
                        <XStack gap="2" flexWrap="wrap">
                            <Btn label="Upload photo" disabled={!you.pubkey || you.busy === 'picture'} onPress={() => void you.changePicture()} testID="profile-picture-upload">Upload photo</Btn>
                            {hasPhoto ? <Btn label="Remove photo" disabled={you.busy === 'picture'} onPress={() => void you.changePicture(true)} testID="profile-picture-remove">Remove</Btn> : null}
                        </XStack>
                    </YStack>
                </XStack>
            </Section>

            <Section title="Connectors" testID="workbench-section">
                <Row
                    label="Your connections"
                    detail={connectors}
                    onPress={() => router.push({ pathname: '/beeline/settings/workbench', params: { workspaceId: you.workspace?.id ?? '', viewerId: you.pubkey ?? '' } } as never)}
                    testID="settings-workbench-row"
                    last
                />
            </Section>

            <Section title="Device" testID="appearance-section">
                {you.push.supported ? (
                    <Row label="Notifications" value={PUSH_LEVEL_LABELS[you.push.level]} onPress={you.push.disabled ? undefined : () => setSheet('push')} testID="push-notifications-setting" />
                ) : null}
                {you.push.failure ? (
                    <Row
                        label="Push not working"
                        detail={capitalize(you.push.failure)}
                        right={<Btn label="Retry notifications" disabled={you.push.working} onPress={you.push.retry} testID="push-retry-registration">{you.push.working ? 'Retrying notifications…' : 'Retry notifications'}</Btn>}
                    />
                ) : null}
                <YStack paddingVertical="3" gap="2">
                    <Copy>Appearance</Copy>
                    <ToggleGroup type="single" value={appearance} onValueChange={(next: string) => {
                        if (!next) return;
                        const choice = next as typeof appearance;
                        setAppearance(choice);
                        applyAppearanceChoice(choice);
                    }} flexDirection="row" alignSelf="flex-start" gap="2" backgroundColor="raised" aria-label="Appearance">
                        {APPEARANCES.map(([value, label]) => (
                            <ToggleGroup.Item key={value} value={value} aria-label={label} width="auto" height={HEIGHT.control} minHeight={HEIGHT.control} paddingHorizontal="3" borderRadius="full" borderWidth={1}
                                borderColor={appearance === value ? 'needsYou' : 'strongStroke'} backgroundColor={appearance === value ? 'highlight' : 'raised'} testID={`appearance-${value}`}>
                                <T v="meta" color={appearance === value ? 'needsYou' : 'secondary'}>{label}</T>
                            </ToggleGroup.Item>
                        ))}
                    </ToggleGroup>
                </YStack>
                <Separator borderColor="stroke" />
                <YStack paddingVertical="3" gap="2">
                    <Copy>Color set</Copy>
                    <RadioGroup aria-label="Color set" value={palette} onValueChange={(next: string) => setPalette(next as typeof palette)} gap="2">
                        {PALETTES.map(([value, label, detail]) => (
                            <XStack key={value} gap="3" alignItems="center" minHeight={HEIGHT.control}>
                                <RadioGroup.Item value={value} id={`palette-${value}`} aria-label={label} testID={`palette-${value}`}>
                                    <RadioGroup.Indicator />
                                </RadioGroup.Item>
                                <YStack flex={1}>
                                    <Label htmlFor={`palette-${value}`}><Copy>{label}</Copy></Label>
                                    <Copy small quiet>{detail}</Copy>
                                </YStack>
                            </XStack>
                        ))}
                    </RadioGroup>
                </YStack>
                <Separator borderColor="stroke" />
                <Row label={sizeLabel} value={APP_UI_SIZE_LABELS[uiSize]} onPress={() => setSheet('size')} testID="ui-size-setting" />
                <Row label="Speaking speed" value={SPEAKING_SPEED_LABELS[you.speakingSpeed]} onPress={() => setSheet('speed')} testID="speaking-speed-setting" last={!roomOpenTraceEnabled()} />
                {roomOpenTraceEnabled() ? (
                    <Row label="Chat open trace" detail="Show open timings on screen" testID="debug-room-open-trace" last
                        right={<Switch checked={roomOpenTrace} onCheckedChange={setRoomOpenTrace} aria-label="Chat open trace"><Switch.Thumb /></Switch>} />
                ) : null}
            </Section>

            <Section title="Account" testID="account-settings">
                {providers?.map((link) => (
                    <Row
                        key={link.provider}
                        leading={<ServiceMark company={link.provider === 'google' ? 'Google' : 'GitHub'} domain={link.provider === 'google' ? 'google.com' : 'github.com'} />}
                        label={link.provider === 'google' ? 'Google' : 'GitHub'}
                        detail={link.login}
                        value={link.reconnect ? 'Reconnect' : providers.length === 1 ? 'Signed in' : 'Linked'}
                        onPress={link.provider === 'github' && you.busy !== 'github' ? () => void you.connectGitHub() : undefined}
                        testID={`settings-provider-${link.provider}`}
                    />
                ))}
                {providers && !providers.some((link) => link.provider === 'github') ? (
                    <Row leading={<ServiceMark company="GitHub" domain="github.com" />} label="GitHub" detail="Needed to link repositories" value="Connect"
                        onPress={you.busy === 'github' ? undefined : () => void you.connectGitHub()} testID="settings-provider-github" />
                ) : null}
                {providers && !providers.some((link) => link.provider === 'google') ? (
                    <Row leading={<ServiceMark company="Google" domain="google.com" />} label="Google" value="Connect"
                        onPress={you.busy === 'google' ? undefined : () => void you.connectGoogle()} testID="settings-provider-google" />
                ) : null}
                <Row label="Privacy Policy" onPress={open(PRIVACY_URL)} testID="settings-privacy-row" />
                <Row label="Terms of Service" onPress={open(TERMS_URL)} testID="settings-terms-row" />
                <Row label="Send feedback" onPress={open(FEEDBACK_MAILTO)} testID="settings-feedback-row" />
                <DangerRow label="Sign out" onPress={() => void you.signOut()} testID="sign-out-setting" />
                {confirmDelete ? (
                    <YStack paddingVertical="3" gap="2" testID="confirm-delete-account">
                        <Copy small>deleting your account will delete all your data. this action is irrevocable. confirm?</Copy>
                        <XStack gap="2">
                            <Btn label="Cancel account deletion" disabled={you.busy === 'delete'} onPress={() => setConfirmDelete(false)} testID="delete-account-cancel">Cancel</Btn>
                            <Btn kind="destructive" label="Yes, delete account" disabled={you.busy === 'delete'} onPress={() => void you.deleteAccount()} testID="delete-account-yes">
                                {you.busy === 'delete' ? 'Deleting…' : 'Delete account'}
                            </Btn>
                        </XStack>
                    </YStack>
                ) : (
                    <DangerRow label="Delete account" onPress={() => setConfirmDelete(true)} testID="delete-account-setting" last />
                )}
            </Section>

            {you.notice ? <Copy small quiet testID="settings-notice">{you.notice}</Copy> : null}
            {you.error ? <T v="meta" color="removed" testID="settings-error">{you.error}</T> : null}

            <YStack gap="2" alignItems="center" testID="ota-update-info">
                <XStack gap="3" alignItems="center" justifyContent="center" flexWrap="wrap">
                    <BeelineMark size={20} />
                    <Copy small quiet>Beeline version {you.update.version}</Copy>
                    {you.update.busy ? <Spinner testID="ota-update-progress" />
                        : <Btn label={you.update.label} disabled={!you.update.enabled} onPress={you.update.check} testID="ota-update-check">Check</Btn>}
                </XStack>
                {you.update.message ? <Copy small quiet>{you.update.message}</Copy> : null}
            </YStack>

            <ChoiceSheet open={sheet === 'push'} close={() => setSheet(null)} title="Push notifications" testID="push-notifications-sheet"
                value={you.push.level} onChoose={(level) => void you.push.change(level)}
                choices={PUSH_LEVELS.map((level) => ({ value: level, label: PUSH_LEVEL_LABELS[level], detail: PUSH_LEVEL_DETAILS[level] }))} />
            <ChoiceSheet open={sheet === 'size'} close={() => setSheet(null)} title={sizeLabel} testID="ui-size-sheet" value={uiSize}
                onChoose={(next) => setUiSize(next)}
                choices={APP_UI_SIZE_OPTIONS.map((size) => ({ value: size, label: APP_UI_SIZE_LABELS[size] }))} />
            <ChoiceSheet open={sheet === 'speed'} close={() => setSheet(null)} title="Speaking speed" testID="speaking-speed-sheet" value={you.speakingSpeed}
                onChoose={you.changeSpeakingSpeed}
                choices={([1.15, 1.3, 1.5] as const).map((speed) => ({ value: speed, label: SPEAKING_SPEED_LABELS[speed] }))} />
        </YStack>
    );
}
