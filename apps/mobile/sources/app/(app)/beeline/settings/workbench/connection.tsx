import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useCallback, useMemo, useState } from 'react';
import { XStack, YStack } from 'tamagui';
import { router, useLocalSearchParams } from 'expo-router';
import { ServiceMark } from '@/components/buzz/ServiceMark';
import { Btn, Section, T } from '@/ui/grammar';
import { ConfirmCard, ConnectorFrame, ConnectorLoading, ConnectorNote, ConnectorRow } from '@/ui/screens/settings/connectors/ConnectorParts';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { publishConnectionDetail, useSharedConnectionDetail } from '@/buzz/workbench-surface';
import {
  connectionCompany,
  connectionCreatedByLine,
  connectionDetailLabel,
  connectionDetailState,
  connectionFactDate,
  connectionGrantLimits,
  connectionGrantPending,
  connectionHostsLine,
  connectionRevokeOffered,
  connectionTitle,
} from '@/buzz/workbench';

function singleParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Key detail (report §5, story 3): what a tool's vault holds for one key —
 * hosts, who created it, the grants with their kinds, the spend cap — plus
 * its ledger rows, read from the tool's audit. Revoke all grants is a tool
 * command available only to the human who provisioned the key, behind an
 * explicit confirmation. Captain ruling 2026-09-15: user-visible copy says
 * Key; the data model (`WorkbenchConnection`, `ref`) keeps its names.
 */
export default function ConnectionDetailScreen() {
  useLatencyRouteFrame('/beeline/settings/workbench/connection');
  const params = useLocalSearchParams<{
    workspaceId?: string | string[];
    viewerId?: string | string[];
    connectionId?: string | string[];
  }>();
  const workspaceId = singleParam(params.workspaceId) ?? '';
  const viewerId = singleParam(params.viewerId) ?? '';
  const connectionId = singleParam(params.connectionId) ?? '';
  const { value: detail, address: detailAddress, error: loadError } =
    useSharedConnectionDetail({ workspaceId, viewerId }, connectionId);
  useLatencyRouteFrame('/beeline/settings/workbench/connection', detail !== null, true);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokedLine, setRevokedLine] = useState<string | null>(null);

  const revoke = useCallback(async () => {
    if (!detail) return;
    setError(null);
    setRevoking(true);
    try {
      const { revoked, pending } = await getWorkbenchSource().revokeAllGrants({ workspaceId, connectionId });
      if (pending) {
        await publishConnectionDetail(detailAddress, {
          ...detail,
          grants: detail.grants.map((grant) =>
            grant.revokingAt ? grant : { ...grant, revokingAt: Math.floor(Date.now() / 1000) },
          ),
        });
        setRevokedLine(`Revoking ${pending} ${pending === 1 ? 'grant' : 'grants'} — waiting for the helper`);
      } else {
        await publishConnectionDetail(detailAddress, {
          ...detail,
          grants: [],
          connection: { ...detail.connection, grantCount: 0 },
        });
        setRevokedLine(`Revoked ${revoked} ${revoked === 1 ? 'grant' : 'grants'}`);
      }
      setConfirmRevoke(false);
    } catch {
      setError('Some grants could not be revoked — try again');
    } finally {
      setRevoking(false);
    }
  }, [detail, connectionId, workspaceId]);

  const company = detail ? connectionCompany(detail.connection) : '';
  const headerTitle = detail
    ? connectionTitle(detail.connection, [detail.connection])
    : 'Key';
  const label = detail ? connectionDetailLabel(detail.connection) : undefined;
  const state = detail ? connectionDetailState(detail.connection) : undefined;
  const fieldNames = detail?.connection.fieldNames ?? [];
  const liveGrants = detail?.grants.filter((grant) => !connectionGrantPending(grant)) ?? [];
  const pendingGrants = detail?.grants.filter(connectionGrantPending) ?? [];
  const grantCount = liveGrants.length;
  const revokeOffered = connectionRevokeOffered();
  const pendingLine =
    pendingGrants.length > 0
      ? `Revoking ${pendingGrants.length} ${pendingGrants.length === 1 ? 'grant' : 'grants'} — waiting for the helper`
      : null;
  const revokeQuestion = useMemo(
    () =>
      `Revoke ${grantCount === 1 ? 'this grant' : `all ${grantCount} grants`}? Agents using ` +
      'them will lose access after the helper confirms the revoke.',
    [grantCount],
  );

  const ledgerMeta = (row: NonNullable<typeof detail>['ledger'][number]) =>
    [row.grant ? `grant ${row.grant}` : undefined, row.status, row.bytes].filter(Boolean).join(' · ') || undefined;

  return (
    <ConnectorFrame title={headerTitle} back={() => router.back()} backLabel="Back to Connectors"
      testID="connection-detail-screen" scrollTestID="connection-detail-scroll">
      {!detail && !error && !loadError ? <ConnectorLoading testID="connection-loading"><SurfaceGlyphLoader testID="connection-loader" /></ConnectorLoading> : null}
      {detail ? (
        <XStack gap="3" alignItems="center" testID="connection-detail-identity">
          <ServiceMark company={company} domain={detail.connection.faviconDomain} testID="connection-service-mark" />
          <YStack flex={1} minWidth={0}>
            {label ? <T v="code" color="secondary" numberOfLines={1} testID="connection-key-label">{label}</T> : null}
          </YStack>
          {state ? (
            <XStack gap="2" alignItems="center" testID="connection-detail-state">
              <YStack width={8} height={8} borderRadius="full"
                backgroundColor={state.tone === 'danger' ? 'removed' : state.tone === 'accent' ? 'needsYou' : 'added'} />
              <T v="meta" color={state.tone === 'danger' ? 'removed' : state.tone === 'accent' ? 'needsYou' : 'secondary'}>{state.label}</T>
            </XStack>
          ) : null}
        </XStack>
      ) : null}
      {detail ? (
        <Section title="Vault" testID="connection-detail-metadata">
          <ConnectorRow title="Reference" value={detail.connection.ref} />
          <ConnectorRow title="Hosts" value={connectionHostsLine(detail.connection)} />
          <ConnectorRow title="Fields" value={fieldNames.length ? fieldNames.join(', ') : 'none reported'} testID="connection-detail-fields" />
          <ConnectorRow title="Created" value={connectionFactDate(detail.connection.createdAt)} />
          <ConnectorRow title="Last synced" value={connectionFactDate(detail.connection.lastSyncedAt)} last={!detail.createdBy} />
          {detail.createdBy ? <ConnectorRow title="Provisioned by" value={connectionCreatedByLine(detail)} last /> : null}
        </Section>
      ) : null}
      {detail ? (
        <Section title="Grants" testID="connection-detail-grants">
          {detail.grants.length ? detail.grants.map((grant, n) => (
            <ConnectorRow key={grant.grantId} title={grant.grantId}
              description={connectionGrantPending(grant) ? 'Revoking — waiting for the helper' : `Granted ${connectionFactDate(grant.createdAt)}`}
              value={connectionGrantLimits(grant)} valueTone={connectionGrantPending(grant) ? 'accent' : undefined}
              last={n === detail.grants.length - 1} testID={`connection-grant-${grant.grantId}`} />
          )) : <ConnectorRow title="None" tone="quiet" last testID="connection-grants-empty" />}
        </Section>
      ) : null}
      {detail ? (
        <Section title="Activity" testID="connection-detail-ledger">
          {detail.ledger.length ? detail.ledger.map((row, index) => (
            <ConnectorRow key={`${row.at}-${index}`} title={[row.actor, row.action].filter(Boolean).join(' ') || 'Key used'}
              description={ledgerMeta(row)} value={row.at} last={index === detail.ledger.length - 1} testID={`connection-ledger-${index}`} />
          )) : <ConnectorRow title="No activity yet" tone="quiet" last testID="connection-activity-empty" />}
        </Section>
      ) : null}
      {detail && ((revokeOffered && grantCount > 0) || confirmRevoke) ? (
        <Section title="Manage" testID="connection-management">
          {!confirmRevoke ? (
            <ConnectorRow title={grantCount === 1 ? 'Revoke grant' : 'Revoke all grants'} tone="destructive" last
              disabled={revoking || pendingGrants.length > 0}
              onPress={() => { setError(null); setConfirmRevoke(true); }} testID="connection-revoke-grants" />
          ) : (
            <YStack paddingVertical="3">
              <ConfirmCard question={revokeQuestion} confirmLabel={revoking ? 'Revoking…' : 'Revoke'} busy={revoking}
                onCancel={() => setConfirmRevoke(false)} onConfirm={() => void revoke()} testID="connection-revoke-confirm" />
            </YStack>
          )}
        </Section>
      ) : null}
      {revokedLine || pendingLine ? <ConnectorNote testID="connection-revoked-line">{revokedLine ?? pendingLine}</ConnectorNote> : null}
      {error || loadError ? (
        <YStack gap="2" testID="connection-error-state">
          <ConnectorNote tone="danger" testID="connection-error">
            {error ?? (loadError?.includes('Key not found')
              ? 'Key not found — it belongs to another member or no longer exists'
              : 'Key unavailable right now')}
          </ConnectorNote>
          {detail && error ? <Btn label="Retry" alignSelf="flex-start" onPress={() => void revoke()} testID="connection-retry">{'Retry'}</Btn> : null}
        </YStack>
      ) : null}
    </ConnectorFrame>
  );
}
