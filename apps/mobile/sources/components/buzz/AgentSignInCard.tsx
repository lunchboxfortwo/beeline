import { appErrorCopy } from '@/buzz/app-error-copy';
import { ErrorBanner } from './ErrorBanner';
import React, { useState } from 'react';
import { Linking } from 'react-native';
import { Input, XStack, YStack } from 'tamagui';
import { HEIGHT, T } from '@/ui/grammar';
import type {
  AgentSignInCardView,
  AgentSignInHarness,
  AgentSignInKeyProvider,
} from '@beeline/api-contract/phone';
import { AppMark } from './AppMark';
import { Button } from './Button';
import { StateDot } from './StateDot';
import { TranscriptCard } from './TranscriptCard';
import { WorkflowStepCircle } from './WorkflowRunLine';

/** The company each harness signs in to: its name, logo domain, and site. */
const HARNESS_SERVICE: Record<
  Exclude<AgentSignInHarness, 'opencode' | 'pi' | 'goose'>,
  { name: string; domain: string; site: string; harness: string }
> = {
  claude: { name: 'Claude', domain: 'claude.ai', site: 'claude.ai', harness: 'Claude Code' },
  codex: { name: 'ChatGPT', domain: 'openai.com', site: 'the sign-in page', harness: 'Codex' },
  grok: { name: 'Grok', domain: 'x.ai', site: 'the sign-in page', harness: 'Grok' },
  cursor: { name: 'Cursor', domain: 'cursor.com', site: 'cursor.com', harness: 'Cursor' },
};

const KEY_HARNESS_LABEL: Record<'opencode' | 'pi' | 'goose', string> = {
  opencode: 'OpenCode',
  pi: 'Pi',
  goose: 'Goose',
};

// Mirrors `AGENT_SIGN_IN_PROVIDER_LABELS` (api-contract); kept local so this
// screen never depends on a freshly built package export.
const PROVIDER_LABEL: Record<AgentSignInKeyProvider, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
};

const PROVIDER_DOMAIN: Record<AgentSignInKeyProvider, string> = {
  openrouter: 'openrouter.ai',
  openai: 'openai.com',
  anthropic: 'anthropic.com',
  google: 'ai.google.dev',
  xai: 'x.ai',
};

const CLAUDE_CODE_SHAPE = /^[\w-]{8,}#[\w-]{8,}$/;

function article(label: string): string {
  return /^[AEIOU]/.test(label) || label === 'xAI' ? 'an' : 'a';
}

/** Show a URL host-first and let the middle give way. */
function displayUrl(url: string): string {
  return url.replace(/^https:\/\//, '');
}

function maskMiddle(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 5)}…${value.slice(-4)}`;
}

async function copyText(value: string): Promise<void> {
  await (await import('expo-clipboard')).setStringAsync(value);
}

async function pasteText(): Promise<string> {
  return (await import('expo-clipboard')).getStringAsync();
}

type Props = {
  card: AgentSignInCardView;
  agentName: string;
  /** The viewer owns this agent: only they see the link, the code, and the field. */
  isOwner: boolean;
  stamp?: string;
  /** Relay a pasted code or key to the agent's machine. Rejects with the reason. */
  onSubmit: (value: string) => Promise<void>;
  testID?: string;
};

/**
 * `@agent /login`: the harness's own login, at the call site (docs/DESIGN.md →
 * Transcript cards). The head carries the company's logo; steps use the
 * workflow circles; waiting pulses the one instrument dot (`StateDot`); a code or key is sent once, never
 * posted, drafted, or shown back.
 */
export function AgentSignInCard({
  card,
  agentName,
  isOwner,
  stamp,
  onSubmit,
  testID = 'agent-sign-in',
}: Props) {
  const [value, setValue] = useState('');
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keyHarness = card.harness in KEY_HARNESS_LABEL;
  const service = keyHarness
    ? undefined
    : HARNESS_SERVICE[card.harness as keyof typeof HARNESS_SERVICE];
  const provider = card.provider ? PROVIDER_LABEL[card.provider] : undefined;
  const harnessLabel =
    service?.harness ?? KEY_HARNESS_LABEL[card.harness as keyof typeof KEY_HARNESS_LABEL];
  const logo = service
    ? { name: service.name, domain: service.domain }
    : card.provider
      ? { name: provider!, domain: PROVIDER_DOMAIN[card.provider] }
      : undefined;

  const signedIn = card.status === 'signed-in';
  const title = signedIn
    ? service
      ? `Signed in to ${service.name}`
      : provider
        ? `Saved a new ${provider} key`
        : 'Saved a new key'
    : service
      ? `Sign in to ${service.name}`
      : provider
        ? `Add ${article(provider)} ${provider} key`
        : 'Add a new key';
  const subline = signedIn
    ? `${agentName} uses it next turn`
    : isOwner
      ? `${agentName} · ${harnessLabel}`
      : `${agentName} · waiting for its owner`;
  const ask = isOwner && !signedIn;

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      setValue('');
    } catch (reason) {
      setError(appErrorCopy(reason));
    } finally {
      setBusy(false);
    }
  };
  const open = (url: string) => {
    setOpened(true);
    void Linking.openURL(url);
  };
  const paste = async () => {
    const text = (await pasteText().catch(() => '')).trim();
    if (text) setValue(text);
  };

  const failure =
    error ?? (card.status === 'failed' ? (card.errorMessage ?? 'Sign-in failed.') : null);
  const waitingForLink = card.status === 'starting';
  const canAct =
    card.status === 'pending' || card.status === 'failed' || card.status === 'signing-in';
  const sending = busy || card.status === 'signing-in';

  const failureLine = failure ? (
    <ErrorBanner inline title={failure} testID={`${testID}-error`} />
  ) : null;

  const linkStep = (
    index: number,
    label: { ahead: string; done: string },
    url: string,
    button: string,
    last: boolean,
  ) => (
    <Step last={last}>
      <WorkflowStepCircle status={opened ? 'done' : 'current'} />
      <StepBody>
        <T>{opened ? label.done : label.ahead}</T>
        <XStack alignItems="center" gap="2">
          <T
            v="code"
            color="secondary"
            flex={1}
            minWidth={0}
            ellipsizeMode="middle"
            numberOfLines={1}
            testID={`${testID}-url`}
          >
            {displayUrl(url)}
          </T>
          <Button
            label={card.kind === 'device-code' ? 'Open' : button}
            accessibilityLabel={button}
            onPress={() => open(url)}
            testID={`${testID}-open`}
            size="inline"
            variant="secondary"
          />
        </XStack>
        {index === 1 && card.kind === 'paste-code' ? (
          <T v="meta" color="secondary">{`Made by ${agentName}'s machine · holds no password or token`}</T>
        ) : null}
      </StepBody>
    </Step>
  );

  const waitLine = (text: string) => (
    <XStack alignItems="center" gap="2">
      <StateDot kind="pulse" />
      <T v="meta" color="secondary" flex={1} minWidth={0}>{text}</T>
    </XStack>
  );

  const field = (placeholder: string, secure: boolean) => (
    <XStack flexWrap="wrap" gap="2">
      <Input
        flex={1}
        flexBasis={120}
        minWidth={0}
        minHeight={HEIGHT.control}
        paddingHorizontal="2"
        borderWidth={1}
        borderColor="strongStroke"
        borderRadius="sm"
        backgroundColor="canvas"
        color="ink"
        accessibilityLabel={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        disabled={sending}
        onChangeText={setValue}
        onSubmitEditing={() => void submit()}
        placeholder={placeholder}
        placeholderTextColor="secondary"
        secureTextEntry={secure}
        testID={`${testID}-input`}
        value={value}
      />
      <Button
        label={value ? 'Clear' : 'Paste'}
        onPress={() => (value ? setValue('') : void paste())}
        testID={`${testID}-paste`}
        size="inline"
        variant="secondary"
      />
    </XStack>
  );

  let steps: React.ReactNode = null;
  if (ask && waitingForLink) {
    steps = waitLine(`Asking ${agentName}'s machine to start its sign-in…`);
  } else if (ask && canAct && card.kind === 'paste-code' && card.authorizeUrl && service) {
    steps = (
      <>
        {linkStep(
          1,
          { ahead: `Approve on ${service.site}`, done: `Approved on ${service.site}` },
          card.authorizeUrl,
          `Open ${service.site}`,
          false,
        )}
        <Step last>
          <WorkflowStepCircle status={opened || value ? 'current' : 'pending'} />
          <StepBody>
            <T color={opened || value ? 'ink' : 'secondary'}>
              {`Paste the code ${service.site} shows`}
            </T>
            {field(`Code from ${service.site}`, false)}
            {value && CLAUDE_CODE_SHAPE.test(value) ? (
              <T v="meta" color="secondary" testID={`${testID}-shape`}>
                {`✓ Looks like a ${service.name} login code · ${maskMiddle(value)}`}
              </T>
            ) : null}
            {failureLine}
            <Button
              disabled={!value.trim()}
              label={sending ? 'Signing in' : 'Sign in'}
              loading={sending}
              onPress={() => void submit()}
              testID={`${testID}-submit`}
            />
          </StepBody>
        </Step>
      </>
    );
  } else if (
    ask &&
    canAct &&
    card.kind === 'device-code' &&
    card.authorizeUrl &&
    card.userCode &&
    service
  ) {
    const minutes = card.expiresAt
      ? Math.max(1, Math.round((card.expiresAt - Date.now()) / 60_000))
      : undefined;
    steps = (
      <>
        {linkStep(
          1,
          { ahead: 'Open the sign-in page', done: 'Opened the sign-in page' },
          card.authorizeUrl,
          'Open sign-in page',
          false,
        )}
        <Step last>
          <WorkflowStepCircle status={opened ? 'current' : 'pending'} />
          <StepBody>
            <T>Enter this code there</T>
            <XStack flexWrap="wrap" alignItems="center" gap="2">
              <T v="code" userSelect="text" flex={1} flexBasis={120} minWidth={0} testID={`${testID}-code`}>
                {card.userCode}
              </T>
              <Button
                label="Copy code"
                onPress={() => void copyText(card.userCode!)}
                testID={`${testID}-copy`}
                size="inline"
                variant="secondary"
              />
            </XStack>
            {card.status === 'failed'
              ? failureLine
              : waitLine(
                  minutes
                    ? `Waiting for approval · expires in ${minutes} min`
                    : 'Waiting for approval',
                )}
            {card.harness === 'codex' ? (
              <T v="meta" color="secondary">
                Device-code sign-in must be on in ChatGPT → Settings → Security.
              </T>
            ) : null}
          </StepBody>
        </Step>
      </>
    );
  } else if (ask && canAct && card.kind === 'approve-wait' && card.authorizeUrl && service) {
    steps = (
      <>
        {linkStep(
          1,
          { ahead: `Approve on ${service.site}`, done: `Opened ${service.site}` },
          card.authorizeUrl,
          `Open ${service.site}`,
          true,
        )}
        {card.status === 'failed' ? failureLine : waitLine('Waiting for approval')}
      </>
    );
  } else if (ask && canAct && card.kind === 'api-key' && provider) {
    steps = (
      <Step last>
        <WorkflowStepCircle status="current" />
        <StepBody>
          <T>{`Paste your ${provider} API key`}</T>
          {field(`${provider} API key`, true)}
          <T v="meta" color="secondary">
            {`Checked with ${provider}, then saved on ${agentName}'s machine only. Never posted here.`}
          </T>
          {failureLine}
          <Button
            disabled={!value.trim()}
            label={sending ? 'Saving key' : 'Save key'}
            loading={sending}
            onPress={() => void submit()}
            testID={`${testID}-submit`}
          />
        </StepBody>
      </Step>
    );
  } else if (ask) {
    steps = failureLine;
  }

  return (
    <TranscriptCard
      identity={
        logo ? (
          <AppMark
            domain={logo.domain}
            name={logo.name}
            size={26}
          />
        ) : undefined
      }
      stamp={stamp}
      subline={subline}
      testID={testID}
      tier={ask ? 'ask' : 'record'}
      title={title}
    >
      {steps ? (
        <YStack paddingHorizontal="4" paddingTop="2" paddingBottom="4" minWidth={0} testID={`${testID}-body`}>
          {steps}
        </YStack>
      ) : null}
    </TranscriptCard>
  );
}

/** One numbered step: circle, then its body; a stroke divides it from the next. */
function Step({ last = false, children }: { last?: boolean; children: React.ReactNode }) {
  return (
    <XStack gap="4" paddingTop="4" paddingBottom={last ? 0 : '4'} borderBottomWidth={last ? 0 : 1} borderBottomColor="stroke">
      {children}
    </XStack>
  );
}

function StepBody({ children }: { children: React.ReactNode }) {
  return <YStack flex={1} minWidth={0} gap="2">{children}</YStack>;
}
