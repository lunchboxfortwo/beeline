import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { useIsDesktop as useDesktopPageLayout } from '@/utils/responsive';
import * as Clipboard from 'expo-clipboard';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { workflowDisplayName } from '@/buzz/workflow-graph';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { Button } from '@/components/buzz/Button';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useState, useEffect } from 'react';
import { ScrollView, YStack } from 'tamagui';
import { router, useLocalSearchParams } from 'expo-router';
import {
  stopSubscription,
  subscriptionRuns,
  subscriptionTitle,
  subscriptionWhere,
  useScheduledWork,
} from '@/buzz/scheduled-work';
import { PageHeader } from '@/components/buzz/PageHeader';
import { DetailSection, ScheduledWorkDoes, ScheduledWorkFacts, StopScheduledWork } from '@/components/buzz/ScheduledWorkDetail';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { Copy, SafeBottom, SafeTop } from '@/ui/grammar';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The event and source that wake one agent, with the same stop control as a schedule. */
export default function Subscription() {
  useLatencyRouteFrame('/beeline/settings/subscription');
  const desktopPageLayout = useDesktopPageLayout();
  const params = useLocalSearchParams<{ roomId?: string | string[]; subscriptionId?: string | string[] }>();
  const roomId = first(params.roomId);
  const subscriptionId = first(params.subscriptionId);
  const { work, loading, error, retry } = useScheduledWork(roomId);
  useLatencyRouteFrame('/beeline/settings/subscription', !loading, true);
  const [working, setWorking] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const [token, setToken] = useState<string>();
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [webhookError, setWebhookError] = useState<string>();
  const [copied, setCopied] = useState<string>();
  useEffect(() => { setToken(undefined); setConfirmRotate(false); setCopied(undefined); }, [subscriptionId]);
  const subscription = work?.subscriptions.find((candidate) => candidate.id === subscriptionId);
  const creatorName = subscription ? (work?.agentNames.get(subscription.agentId) ?? 'Agent' )
    : 'Agent';

  const copy = async (kind: string, value: string) => {
    setWebhookError(undefined);
    try { await Clipboard.setStringAsync(value); setCopied(kind); }
    catch { setWebhookError('Could not copy. Try again.'); }
  };
  const showToken = async (rotate = false) => {
    if (!roomId || !subscription) return;
    setWebhookBusy(true); setWebhookError(undefined); setCopied(undefined);
    try {
      const result = await monolithPhoneOperation(rotate ? 'rotateWebhookToken' : 'revealWebhookToken',
        { roomId, subscriptionId: subscription.id });
      setToken(result.token); setConfirmRotate(false);
      if (rotate) retry();
    } catch { setWebhookError(rotate ? 'Could not rotate the token. Try again.' : 'Could not show the token. Try again.'); }
    finally { setWebhookBusy(false); }
  };
  const time = (at: number) => new Intl.DateTimeFormat(undefined,
    { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at * 1000));

  const stop = async () => {
    if (!roomId || !subscription) return;
    setWorking(true);
    setStopFailed(false);
    try {
      // Already gone on the server: the page shows it stopped and rereads the list.
      if ((await stopSubscription(roomId, subscription.id)) === 'already-stopped') retry();
      else router.back();
    } catch {
      setStopFailed(true);
    } finally {
      setWorking(false);
    }
  };

  return (
    <YStack flex={1} backgroundColor="canvas"
      width={desktopPageLayout ? '100%' : undefined} maxWidth={desktopPageLayout ? desktopColumnWidths.detail : undefined}
      alignSelf={desktopPageLayout ? 'center' : undefined}>
      <SafeTop />
      <PageHeader
        backAccessibilityLabel="Back to Schedules and subscriptions"
        eyebrow="Schedules and subscriptions"
        onBack={() => router.back()}
        testID="subscription-header"
        title={subscription ? subscriptionTitle(subscription) : 'Subscription'}
      />
      {stopFailed ? (
        <SettingsRow
          title="Could not stop this subscription."
          action="Retry"
          onPress={() => void stop()}
          testID="subscription-stop-error"
        />
      ) : error ? (
        <SettingsRow title={error}
          />
      ) : null}
      {loading && !work ? (
        <YStack padding="8" alignItems="center" justifyContent="center"><SurfaceGlyphLoader testID="subscription-loader" /></YStack>
      ) : subscription ? (
        <ScrollView testID="subscription-page">
          <ScheduledWorkFacts
            agents={[creatorName]}
            runs={subscriptionRuns(subscription, work?.isDirectMessage)}
            where={subscriptionWhere(subscription, work?.roomName, work?.isDirectMessage)}
            whereCorner={subscription.corner}
          />
          {subscription.source === 'webhook' && subscription.webhook ? (
            <>
              <DetailSection title="Link" />
              <YStack paddingHorizontal="2">
                <SettingsRow title="Webhook link" description={subscription.webhook.url}
                  descriptionContent={<Copy small quiet userSelect="text" flex={1} minWidth={0}>{subscription.webhook.url}</Copy>}
                  action={copied === 'link' ? 'Copied' : 'Copy'}
                  onPress={() => void copy('link', subscription.webhook!.url)} testID="webhook-link" />
                {!confirmRotate ? <SettingsRow title="Token"
                  description={token ?? `Ends in ${subscription.webhook.tokenSuffix} · made by @${creatorName}, ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(subscription.webhook.tokenCreatedAt * 1000))}`}
                  descriptionContent={token ? <Copy small quiet userSelect="text" flex={1} minWidth={0}>{token}</Copy> : undefined}
                  action={token ? (copied === 'token' ? 'Copied' : 'Copy') : 'Show'}
                  disabled={webhookBusy} onPress={() => token ? void copy('token', token) : void showToken()}
                  testID="webhook-token" /> : null}
                {confirmRotate ? (
                  <SettingsRow title="Rotate token" description="The old token stops working at once."
                    tone="destructive" action="Cancel" disabled={webhookBusy}
                    onPress={() => void showToken(true)} testID="webhook-rotate-confirm"
                    trailingPress={{ accessibilityLabel: 'Cancel', disabled: webhookBusy,
                      onPress: () => setConfirmRotate(false), testID: 'webhook-rotate-cancel' }} />
                ) : (
                  <SettingsRow title="Rotate token" tone="action" disabled={webhookBusy}
                    onPress={() => setConfirmRotate(true)} testID="webhook-rotate" />
                )}
                {webhookError ? <SettingsRow title="Token unavailable" description={webhookError} descriptionTone="danger" /> : null}
              </YStack>
            </>
          ) : null}
          <ScheduledWorkDoes roomId={subscription.roomId}
            prompt={subscription.prompt ?? 'React to this event.'}
            workflowSlug={subscription.workflowSlug} />
          {subscription.source === 'webhook' && subscription.recentCalls ? (
            <>
              <DetailSection title="Recent calls" />
              <YStack paddingHorizontal="2">
                {subscription.recentCalls.length ? subscription.recentCalls.map((call) => (
                  <SettingsRow key={call.id}
                    title={call.outcome === 'woke' ? `Woke @${creatorName}` : call.outcome === 'refused' ? 'Refused' : 'Skipped'}
                    description={`${time(call.at)} · ${call.outcome === 'woke'
                      ? `${subscription.workflowSlug ? workflowDisplayName(subscription.workflowSlug) : subscriptionTitle(subscription)} ran`
                      : call.outcome === 'refused' ? call.reason
                        : `Same call as ${time(call.repeatAt ?? call.at)}`}`}
                    descriptionTone={call.outcome === 'refused' ? 'danger' : undefined}
                    tone={call.outcome === 'skipped' ? 'quiet' : undefined}
                    chevron={call.runId || call.messageId ? 'right' : undefined}
                    onPress={call.runId ? () => router.push({ pathname: '/beeline/workflow-run',
                      params: { roomId: subscription.roomId, runId: call.runId } })
                      : call.messageId ? () => router.push({ pathname: '/beeline/chat/[channelId]',
                        params: { channelId: subscription.roomId, jumpTo: call.messageId } }) : undefined}
                  />
                )) : <SettingsRow title="No calls yet" tone="quiet" />}
              </YStack>
            </>
          ) : null}
          <YStack marginTop="4">
            <StopScheduledWork
              label="Stop subscription"
              onStop={() => void stop()}
              testID="stop-subscription"
              working={working}
            />
          </YStack>
          <YStack paddingBottom="6" />
          <SafeBottom />
        </ScrollView>
      ) : work ? (
        <Copy small quiet padding="4" testID="subscription-gone">This subscription has stopped.</Copy>
      ) : null}
    </YStack>
  );
}
