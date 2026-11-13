import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useEffect, useState } from 'react';
import { XStack, YStack } from 'tamagui';
import { RefreshCw, Unplug } from 'lucide-react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { AppMark } from '@/components/buzz/AppMark';
import { Copy, Glyph, Section, SheetFrame, SheetRow } from '@/ui/grammar';
import { ConnectorCard, ConnectorFrame, ConnectorNote, ConnectorRow } from '@/ui/screens/settings/connectors/ConnectorParts';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { useSharedWorkbench } from '@/buzz/workbench-surface';
import { appNeedsSquire, reconnectWorkbenchApp } from '@/buzz/app-reconnect';
import type { WorkbenchApp } from '@/buzz/workbench';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { INSTAGRAM_SIGN_IN_REQUIREMENT } from '@/buzz/app-sign-in-copy';

function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }

export default function AppDetailScreen() {
  useLatencyRouteFrame('/beeline/settings/workbench/app');
  const params = useLocalSearchParams<{ workspaceId?: string | string[]; viewerId?: string | string[]; appId?: string | string[] }>();
  const workspaceId = first(params.workspaceId) ?? '';
  const viewerId = first(params.viewerId) ?? '';
  const appId = first(params.appId) ?? '';
  const { value: view, error: loadError } = useSharedWorkbench({ workspaceId, viewerId });
  const [appOverride, setAppOverride] = useState<WorkbenchApp | null>(null);
  const app = appOverride ?? view?.apps.find(item => item.id === appId) ?? null;
  useEffect(() => { setAppOverride(null); }, [view]);
  useLatencyRouteFrame('/beeline/settings/workbench/app', app !== null, true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const needsSquire = app ? appNeedsSquire(app) : false;

  const disconnect = async () => {
    if (!app || working) return;
    setWorking(true);
    setError(null);
    try { await getWorkbenchSource().disconnectApp({ workspaceId, appId: app.id }); router.back(); }
    catch (cause) { setError(appErrorCopy(cause, 'Could not disconnect app')); }
    finally { setWorking(false); }
  };

  const reconnect = async () => {
    if (!app || working) return;
    if (needsSquire) {
      router.push({ pathname: '/beeline/settings/workbench/connect',
        params: { workspaceId, viewerId, connectorId: 'trusty-squire' } });
      return;
    }
    setWorking(true);
    setError(null);
    setConnectionNotice(null);
    try { setConnectionNotice(await reconnectWorkbenchApp(app, { workspaceId, viewerId })); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not connect app';
      setError(appErrorCopy(message));
      setAppOverride(app ? { ...app, status: 'error', errorMessage: message } : null);
    }
    finally { setWorking(false); }
  };

  const lastUsed = app?.lastUse
    ? `Last used by ${app.lastUse.agentName} in ${app.lastUse.roomName.startsWith('#') ? '' : '#'}${app.lastUse.roomName}, ${new Date(app.lastUse.usedAt * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}.`
    : app?.lastUsedAt
      ? `Last used ${new Date(app.lastUsedAt * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}.`
      : 'Not used yet.';
  const providerDescription = app?.description?.trim();
  const description = providerDescription && !/^use\s+.+\s+tools\.?$/i.test(providerDescription)
    ? providerDescription
    : app?.key === 'neon'
      ? 'Neon provides serverless Postgres databases for applications.'
      : null;

  const statusLabel = app?.status === 'connected' ? 'Connected' : app?.status === 'connecting' ? 'Connecting' : 'Offline';
  const failure = error ?? (loadError ? 'App unavailable right now' : null) ?? (app?.status === 'error' && app.errorMessage ? (needsSquire
    ? `${app.name} connects through Trusty Squire. Connect Trusty Squire, then return here to connect ${app.name}.`
    : app.transport !== 'composio' && app.errorMessage === 'App sign-in is unavailable for this person'
      ? `${app.name} connects through your helper. Retry to ask your helper to finish connecting it.`
      : appErrorCopy(app.errorMessage)) : null);

  return (
    <>
      <ConnectorFrame title={app?.name ?? 'App'} back={() => router.back()} backLabel="Back to Connectors" testID="app-detail-screen" scrollTestID="app-detail-scroll">
        {app ? (
          <>
            <XStack gap="3" alignItems="center">
              <AppMark name={app.name} domain={app.domain} logo={app.logo} size={36} />
              <Copy small quiet>{app.status === 'connected' ? app.key === 'gmail' ? 'Signed in · Google' : 'Signed in' : app.status === 'connecting' ? 'Connecting' : 'Offline'}</Copy>
            </XStack>
            <ConnectorCard>
              <ConnectorRow title="Status" value={statusLabel} valueTone={app.status === 'error' ? 'danger' : undefined}
                chevron="right" onPress={() => setStatusOpen(true)} last={!(app.status === 'error' && app.transport !== 'composio')} testID="app-detail-status" />
              {app.status === 'error' && app.transport !== 'composio' ? (
                // The computer that will retry, with the retry one tap away.
                <ConnectorRow title={needsSquire ? 'Trusty Squire' : app.helperName ?? 'Your computer'}
                  description={needsSquire ? 'Connect Trusty Squire first' : `Retries ${app.name} on this computer`}
                  action={working ? undefined : needsSquire ? 'Connect' : 'Reconnect'} disabled={working}
                  onPress={() => void reconnect()} last testID="app-detail-reconnect" />
              ) : null}
            </ConnectorCard>
            <Section title="What your agents can do">
              <YStack paddingVertical="3" gap="3">
                <Copy small quiet>{app.key === 'gmail' ? 'Let agents work with your mail when you ask them to.' :
                  `Let agents use ${app.name} when you ask them to.`}</Copy>
                {(app.key === 'gmail' ? ['Find the latest invoice', 'Draft a reply to Alex', 'Send the reply I approved'] :
                  [`Use ${app.name} for this task`]).map((example) => (
                  <YStack key={example} borderLeftWidth={2} borderLeftColor="needsYou" paddingLeft="3" paddingVertical="2">
                    <Copy>“{example}”</Copy>
                  </YStack>
                ))}
              </YStack>
            </Section>
            <YStack gap="2">
              {description ? <ConnectorNote>{description}</ConnectorNote> : null}
              {app.key === 'instagram' && app.status !== 'connected' ? <ConnectorNote>{INSTAGRAM_SIGN_IN_REQUIREMENT}</ConnectorNote> : null}
              <ConnectorNote testID="app-detail-last-used">{lastUsed}</ConnectorNote>
              {connectionNotice ? <ConnectorNote testID="app-detail-connection-notice">{connectionNotice}</ConnectorNote> : null}
            </YStack>
          </>
        ) : null}
        {failure ? <ConnectorNote tone="danger" testID="app-detail-error">{failure}</ConnectorNote> : null}
      </ConnectorFrame>
      <SheetFrame open={statusOpen} title={app?.name ?? ''} close={() => setStatusOpen(false)} testID="app-detail-status-sheet">
        {app?.status !== 'connected' ? (
          <SheetRow icon={<Glyph icon={RefreshCw} />} label={needsSquire ? 'Reconnect Trusty Squire' : 'Reconnect'} onPress={() => { setStatusOpen(false); void reconnect(); }} />
        ) : null}
        <SheetRow icon={<Glyph icon={Unplug} color="removed" />} label="Disconnect" onPress={() => { setStatusOpen(false); void disconnect(); }} />
      </SheetFrame>
    </>
  );
}
