import React, { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { Label, RadioGroup, Separator, Switch, ToggleGroup, XStack, YStack } from 'tamagui';
import { PUSH_LEVELS, type PushLevel } from '@beeline/api-contract/phone';
import { Btn, Copy, HEIGHT, Row, Section, T, Spinner } from '@/ui/grammar';
import { IdentityMark, isPersonPictureUrl } from '@/components/buzz/IdentityMark';
import { ServiceMark } from '@/components/buzz/ServiceMark';
import { BeelineMark } from '@/components/buzz/BeelineMark';
import { useLocalSettingMutable } from '@/sync/storage';
import { applyAppearanceChoice } from '@/display';
import { APP_UI_SIZE_LABELS, APP_UI_SIZE_OPTIONS } from '@/ui-size';
import { roomOpenTraceEnabled } from '@/buzz/room-open-trace';
import { openExternalUrl } from '@/utils/open-external-url';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import type { CompanyLogo } from '@beeline/api-contract/workbench';
import { ChoiceSheet } from './ChoiceSheet';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';
import type { YouSettings as You } from './useYouSettings';

const PRIVACY_URL = 'https://usebeeline.app/privacy/';
const TERMS_URL = 'https://usebeeline.app/terms/';
const FEEDBACK_MAILTO = 'mailto:hello@usebeeline.app';
const PUSH_LEVEL_LABELS: Readonly<Record<PushLevel, string>> = {
  off: 'Off',
  attention: 'Attention (default)',
  full: 'Full',
};
const PUSH_LEVEL_DETAILS: Readonly<Record<PushLevel, string>> = {
  off: 'No push notifications.',
  attention: 'Tags, DMs and replies to you, from people or agents.',
  full: 'Everything in Attention, plus every human message and every final agent reply in all your chats and threads.',
};
const SPEAKING_SPEED_LABELS = { 1.15: 'Normal', 1.3: 'Medium', 1.5: 'Fast' } as const;
const APPEARANCES = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
] as const;
const PALETTES = [
  ['brass', 'Brass', 'Aubergine, Bone and brass.'],
  ['stone', 'Stone', 'Neutral Stone on the same components. Default.'],
] as const;
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const open = (url: string) => () => void openExternalUrl(url).catch(() => undefined);
/** The server's own brand mark for a sign-in provider, the same one its Connectors rows use. */
const providerMark = (provider: 'github' | 'google'): CompanyLogo => ({
  kind: 'image',
  uri: `${getBuzzRuntimeConfig().monolithUrl}/v1/company-logos/${provider}`,
  plate: 'dark',
});

/** A destructive row: the label in removed ink, nothing else. */
function DangerRow({
  label,
  onPress,
  testID,
  last,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
  last?: boolean;
}) {
  return <Row label={label} tone="removed" onPress={onPress} testID={testID} last={last} />;
}

type YouActions = {
  retryPush(): void;
  changePushLevel(level: PushLevel): void;
  changeSpeakingSpeed(speed: 1.15 | 1.3 | 1.5): void;
  leaveWorkspace(): void;
  connectGitHub(): void;
  connectGoogle(): void;
  signOut(): void;
  deleteAccount(): void;
  checkUpdate(): void;
};

/** Settings → You: picture, connectors, this device, and the account. */
export function YouSettings({ you }: { you: You }) {
  const hasPhoto = isPersonPictureUrl(you.avatar);
  const connectors = you.workbench
    ? [you.workbench.value, you.workbench.attention].filter(Boolean).join(' · ')
    : undefined;
  // Settings re-renders as each of its reads lands. The sections below the
  // profile take stable actions and only their own values, so a read that
  // does not change them does not rebuild them.
  const latest = useRef(you);
  useLayoutEffect(() => {
    latest.current = you;
  });
  const actions = useMemo<YouActions>(
    () => ({
      retryPush: () => latest.current.push.retry(),
      changePushLevel: (level) => void latest.current.push.change(level),
      changeSpeakingSpeed: (speed) => latest.current.changeSpeakingSpeed(speed),
      leaveWorkspace: () => void latest.current.leaveWorkspace(),
      connectGitHub: () => void latest.current.connectGitHub(),
      connectGoogle: () => void latest.current.connectGoogle(),
      signOut: () => void latest.current.signOut(),
      deleteAccount: () => void latest.current.deleteAccount(),
      checkUpdate: () => latest.current.update.check(),
    }),
    [],
  );

  return (
    <YStack gap="5">
      <Section title="Profile picture">
        <XStack paddingVertical="3" gap="3" alignItems="center" testID="profile-picture">
          <IdentityMark
            kind="human"
            seed={you.pubkey ?? 'pending-profile'}
            name={you.name || undefined}
            handle={you.handle || undefined}
            avatarUrl={you.avatar}
            size={56}
            testID="profile-picture-mark"
          />
          <YStack flex={1} minWidth={0} gap="2">
            <Copy small quiet>
              {hasPhoto ? 'Your photo' : 'Your generated mark'}
            </Copy>
            <XStack gap="2" flexWrap="wrap">
              <Btn
                label="Upload photo"
                disabled={!you.pubkey || you.busy === 'picture'}
                onPress={() => void you.changePicture()}
                testID="profile-picture-upload"
              >
                Upload photo
              </Btn>
              {hasPhoto ? (
                <Btn
                  label="Remove photo"
                  disabled={you.busy === 'picture'}
                  onPress={() => void you.changePicture(true)}
                  testID="profile-picture-remove"
                >
                  Remove
                </Btn>
              ) : null}
            </XStack>
          </YStack>
        </XStack>
      </Section>

      <Section title="Connectors" testID="workbench-section">
        <Row
          label="Your connections"
          detail={connectors}
          onPress={() =>
            router.push({
              pathname: '/beeline/settings/workbench',
              params: { workspaceId: you.workspace?.id ?? '', viewerId: you.pubkey ?? '' },
            } as never)
          }
          testID="settings-workbench-row"
          last
        />
      </Section>

      <DeviceSection
        pushSupported={you.push.supported}
        pushLevel={you.push.level}
        pushDisabled={you.push.disabled}
        pushFailure={you.push.failure}
        pushRetryable={you.push.retryable}
        pushWorking={you.push.working}
        speakingSpeed={you.speakingSpeed}
        actions={actions}
      />

      <AccountSections
        workspaceName={you.workspace?.name}
        busy={you.busy}
        providers={you.providers}
        notice={you.notice}
        error={you.error}
        updateEnabled={you.update.enabled}
        updateBusy={you.update.busy}
        updateLabel={you.update.label}
        updateMessage={you.update.message}
        version={you.update.version}
        actions={actions}
      />
    </YStack>
  );
}

const DeviceSection = memo(function DeviceSection({
  pushSupported,
  pushLevel,
  pushDisabled,
  pushFailure,
  pushRetryable,
  pushWorking,
  speakingSpeed,
  actions,
}: {
  pushSupported: boolean;
  pushLevel: PushLevel;
  pushDisabled: boolean;
  pushFailure: string | null;
  pushRetryable: boolean;
  pushWorking: boolean;
  speakingSpeed: 1.15 | 1.3 | 1.5;
  actions: YouActions;
}) {
  const [appearance, setAppearance] = useLocalSettingMutable('appearance');
  const [uiSize, setUiSize] = useLocalSettingMutable('uiSize');
  const [palette, setPalette] = useLocalSettingMutable('palette');
  const [roomOpenTrace, setRoomOpenTrace] = useLocalSettingMutable('roomOpenTraceOverlay');
  const [sheet, setSheet] = useState<'push' | 'size' | 'speed' | null>(null);
  const sizeLabel = Platform.OS === 'web' ? 'Interface size' : 'Text size';
  return (
    <>
      <Section title="Device" testID="appearance-section">
        {pushSupported ? (
          <Row
            label="Notifications"
            value={PUSH_LEVEL_LABELS[pushLevel]}
            onPress={pushDisabled ? undefined : () => setSheet('push')}
            testID="push-notifications-setting"
          />
        ) : null}
        {pushFailure ? (
          <Row
            label="Push not working"
            detail={capitalize(pushFailure)}
            right={
              pushRetryable ? (
                <Btn
                  label="Retry notifications"
                  disabled={pushWorking}
                  onPress={actions.retryPush}
                  testID="push-retry-registration"
                >
                  {pushWorking ? 'Retrying notifications…' : 'Retry notifications'}
                </Btn>
              ) : undefined
            }
          />
        ) : null}
        <YStack paddingVertical="3" gap="2">
          <Copy>Appearance</Copy>
          <ToggleGroup
            type="single"
            value={appearance}
            onValueChange={(next: string) => {
              if (!next) return;
              const choice = next as typeof appearance;
              setAppearance(choice);
              applyAppearanceChoice(choice);
            }}
            flexDirection="row"
            alignSelf="flex-start"
            gap="2"
            backgroundColor="raised"
            aria-label="Appearance"
          >
            {APPEARANCES.map(([value, label]) => (
              <ToggleGroup.Item
                key={value}
                value={value}
                aria-label={label}
                width="auto"
                height={HEIGHT.control}
                minHeight={HEIGHT.control}
                paddingHorizontal="3"
                borderRadius="full"
                borderWidth={1}
                borderColor={appearance === value ? 'needsYou' : 'strongStroke'}
                backgroundColor={appearance === value ? 'highlight' : 'raised'}
                testID={`appearance-${value}`}
              >
                <T v="meta" color={appearance === value ? 'needsYou' : 'secondary'}>
                  {label}
                </T>
              </ToggleGroup.Item>
            ))}
          </ToggleGroup>
        </YStack>
        <Separator borderColor="stroke" />
        <YStack paddingVertical="3" gap="2">
          <Copy>Color set</Copy>
          <RadioGroup
            aria-label="Color set"
            value={palette}
            onValueChange={(next: string) => setPalette(next as typeof palette)}
            gap="2"
          >
            {PALETTES.map(([value, label, detail]) => (
              <XStack key={value} gap="3" alignItems="center" minHeight={HEIGHT.control}>
                {/* activeTheme is applied under the item, after its fill is resolved, so the
                                    dot takes brand ink on the canvas and vanishes. The brand theme has to
                                    sit on the item that paints the circle. */}
                <RadioGroup.Item
                  value={value}
                  id={`palette-${value}`}
                  aria-label={label}
                  testID={`palette-${value}`}
                  theme={palette === value ? 'brand' : undefined}
                  {...(palette === value ? {} : { borderColor: 'strongStroke' as const })}
                >
                  <RadioGroup.Indicator />
                </RadioGroup.Item>
                <YStack flex={1}>
                  <Label htmlFor={`palette-${value}`}>
                    <Copy>{label}</Copy>
                  </Label>
                  <Copy small quiet>
                    {detail}
                  </Copy>
                </YStack>
              </XStack>
            ))}
          </RadioGroup>
        </YStack>
        <Separator borderColor="stroke" />
        <Row
          label={sizeLabel}
          value={APP_UI_SIZE_LABELS[uiSize]}
          onPress={() => setSheet('size')}
          testID="ui-size-setting"
        />
        <Row
          label="Speaking speed"
          value={SPEAKING_SPEED_LABELS[speakingSpeed]}
          onPress={() => setSheet('speed')}
          testID="speaking-speed-setting"
          last={!roomOpenTraceEnabled()}
        />
        {roomOpenTraceEnabled() ? (
          <Row
            label="Chat open trace"
            detail="Show open timings on screen"
            testID="debug-room-open-trace"
            last
            right={
              <Switch
                checked={roomOpenTrace}
                onCheckedChange={setRoomOpenTrace}
                aria-label="Chat open trace"
              >
                <Switch.Thumb />
              </Switch>
            }
          />
        ) : null}
      </Section>
      <ChoiceSheet
        open={sheet === 'push'}
        close={() => setSheet(null)}
        title="Push notifications"
        testID="push-notifications-sheet"
        value={pushLevel}
        onChoose={actions.changePushLevel}
        choices={PUSH_LEVELS.map((level) => ({
          value: level,
          label: PUSH_LEVEL_LABELS[level],
          detail: PUSH_LEVEL_DETAILS[level],
        }))}
      />
      <ChoiceSheet
        open={sheet === 'size'}
        close={() => setSheet(null)}
        title={sizeLabel}
        testID="ui-size-sheet"
        value={uiSize}
        onChoose={(next) => setUiSize(next)}
        choices={APP_UI_SIZE_OPTIONS.map((size) => ({
          value: size,
          label: APP_UI_SIZE_LABELS[size],
        }))}
      />
      <ChoiceSheet
        open={sheet === 'speed'}
        close={() => setSheet(null)}
        title="Speaking speed"
        testID="speaking-speed-sheet"
        value={speakingSpeed}
        onChoose={actions.changeSpeakingSpeed}
        choices={([1.15, 1.3, 1.5] as const).map((speed) => ({
          value: speed,
          label: SPEAKING_SPEED_LABELS[speed],
        }))}
      />
    </>
  );
});

const AccountSections = memo(function AccountSections({
  workspaceName,
  busy,
  providers,
  notice,
  error,
  updateEnabled,
  updateBusy,
  updateLabel,
  updateMessage,
  version,
  actions,
}: {
  workspaceName: string | undefined;
  busy: You['busy'];
  providers: You['providers'];
  notice: string | null;
  error: string | null;
  updateEnabled: boolean;
  updateBusy: boolean;
  updateLabel: string;
  updateMessage: string | null;
  version: string;
  actions: YouActions;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <>
      {workspaceName !== undefined ? (
        <Section title={WORKSPACE_LABEL} testID="workspace-membership-settings">
          <DangerRow
            label={busy === 'leave' ? 'Leaving…' : `Leave ${workspaceName}`}
            onPress={actions.leaveWorkspace}
            testID="leave-workspace-setting"
            last
          />
        </Section>
      ) : null}
      <Section title="Account" testID="account-settings">
        {providers?.map((link) => (
          <Row
            key={link.provider}
            leading={
              <ServiceMark
                company={link.provider === 'google' ? 'Google' : 'GitHub'}
                mark={providerMark(link.provider)}
              />
            }
            label={link.provider === 'google' ? 'Google' : 'GitHub'}
            detail={link.login}
            value={link.reconnect ? 'Reconnect' : providers.length === 1 ? 'Signed in' : 'Linked'}
            onPress={
              link.provider === 'github' && busy !== 'github' ? actions.connectGitHub : undefined
            }
            testID={`settings-provider-${link.provider}`}
          />
        ))}
        {providers && !providers.some((link) => link.provider === 'github') ? (
          <Row
            leading={<ServiceMark company="GitHub" mark={providerMark('github')} />}
            label="GitHub"
            detail="Needed to link repositories"
            value="Connect"
            onPress={busy === 'github' ? undefined : actions.connectGitHub}
            testID="settings-provider-github"
          />
        ) : null}
        {providers && !providers.some((link) => link.provider === 'google') ? (
          <Row
            leading={<ServiceMark company="Google" mark={providerMark('google')} />}
            label="Google"
            value="Connect"
            onPress={busy === 'google' ? undefined : actions.connectGoogle}
            testID="settings-provider-google"
          />
        ) : null}
        <Row label="Privacy Policy" onPress={open(PRIVACY_URL)} testID="settings-privacy-row" />
        <Row label="Terms of Service" onPress={open(TERMS_URL)} testID="settings-terms-row" />
        <Row label="Send feedback" onPress={open(FEEDBACK_MAILTO)} testID="settings-feedback-row" />
        <Row label="Sign out" onPress={actions.signOut} testID="sign-out-setting" />
        {confirmDelete ? (
          <YStack paddingVertical="3" gap="2" testID="confirm-delete-account">
            <Copy small>
              deleting your account will delete all your data. this action is irrevocable. confirm?
            </Copy>
            <XStack gap="2">
              <Btn
                label="Cancel account deletion"
                disabled={busy === 'delete'}
                onPress={() => setConfirmDelete(false)}
                testID="delete-account-cancel"
              >
                Cancel
              </Btn>
              <Btn
                kind="destructive"
                label="Yes, delete account"
                disabled={busy === 'delete'}
                onPress={actions.deleteAccount}
                testID="delete-account-yes"
              >
                {busy === 'delete' ? 'Deleting…' : 'Delete account'}
              </Btn>
            </XStack>
          </YStack>
        ) : (
          <DangerRow
            label="Delete account"
            onPress={() => setConfirmDelete(true)}
            testID="delete-account-setting"
            last
          />
        )}
      </Section>

      {notice ? (
        <Copy small quiet testID="settings-notice">
          {notice}
        </Copy>
      ) : null}
      {error ? (
        <T v="meta" color="removed" testID="settings-error">
          {error}
        </T>
      ) : null}

      <YStack gap="2" alignItems="center" testID="ota-update-info">
        <XStack gap="3" alignItems="center" justifyContent="center" flexWrap="wrap">
          <BeelineMark size={20} />
          <Copy small quiet>
            Beeline version {version}
          </Copy>
          {updateBusy ? (
            <Spinner testID="ota-update-progress" />
          ) : (
            <Btn
              label={updateLabel}
              disabled={!updateEnabled}
              onPress={actions.checkUpdate}
              testID="ota-update-check"
            >
              Check
            </Btn>
          )}
        </XStack>
        {updateMessage ? (
          <Copy small quiet>
            {updateMessage}
          </Copy>
        ) : null}
      </YStack>
    </>
  );
});
