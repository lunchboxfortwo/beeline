import { PageLoader } from '@/ui/PageLoader';
import { appReadErrorCopy } from '@/buzz/app-error-copy';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useCallback, useEffect, useState } from 'react';
import { Image, XStack, YStack } from 'tamagui';
import { ArrowDown, ArrowUp } from 'lucide-react-native';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { WalletQr } from '@/components/buzz/WalletQr';
import { chainIcon, tokenIcon } from '@/buzz/wallet-icons';
import { getWalletSource } from '@/buzz/wallet-source';
import { useSharedWallet, useSharedWalletHistory } from '@/buzz/wallet-surface';
import { resolveWalletWorkspaceId } from '@/buzz/wallet-workspace';
import { useActiveCommunityId } from '@/buzz/use-active-community';
import { WALLET_GRANT_ENDED_MESSAGE } from '@/buzz/workbench';
import { useSharedWorkbench } from '@/buzz/workbench-surface';
import { phoneOperationFailureReason } from '@/sync/transport/monolith-operation';
import { Btn, Copy, Glyph, Section, T } from '@/ui/grammar';
import { ConnectorCard, ConnectorFrame, ConnectorLoading, ConnectorNote, ConnectorRow } from '@/ui/screens/settings/connectors/ConnectorParts';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** `14:26` today, otherwise `13 Sep` — one stamp vocabulary with the ledger. */
function activityStamp(createdAt: number, now: number = Date.now()): string {
  const date = new Date(createdAt < 1e12 ? createdAt * 1000 : createdAt);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  return `${date.getDate()} ${date.toLocaleString('en', { month: 'short' })}`;
}

/**
 * Wallet dashboard (post-connect overview): the address with copy and QR,
 * the total in USD, the asset breakdown with real token and chain marks,
 * the Send/Receive action tabs, and the transaction history feed.
 *
 * Data contracts: `WalletView` carries address/total/coins; the history
 * feed comes from `readWalletHistory` (the server's own ledger rows —
 * oldest first as stored, rendered newest first). The balance IS the
 * limit. Until agents hold an active grant to sign, the page shows only the
 * one row that connects it.
 */
export default function WalletScreen() {
  useLatencyRouteFrame('/beeline/settings/workbench/wallet');
  const params = useLocalSearchParams<{ workspaceId?: string | string[]; viewerId?: string | string[] }>();
  const routeWorkspaceId = firstParam(params.workspaceId);
  const viewerId = firstParam(params.viewerId);
  // The Connectors row's own name titles this page, so the tap and the page agree.
  const { value: workbench } = useSharedWorkbench(viewerId ? { workspaceId: routeWorkspaceId ?? '', viewerId } : null);
  const title = workbench?.companies?.rows.find(row => row.items.some(item => item.target.kind === 'wallet'))?.name ?? 'Coinbase wallet';
  const activeWorkspaceId = useActiveCommunityId();
  // A route Workspace wins; only a personal entry follows a later Room open.
  const followedWorkspaceId = routeWorkspaceId ? undefined : activeWorkspaceId;
  const [workspaceId, setWorkspaceId] = useState<string | null | undefined>(undefined);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const { value: wallet, error, refresh: refreshWallet } = useSharedWallet(workspaceId);
  const { value: historyView, error: historyError, refresh: refreshHistory } =
    useSharedWalletHistory(workspaceId);
  const history = historyView ? [...historyView.entries].reverse() : null;
  const historyUnavailable = Boolean(historyError);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!routeWorkspaceId && followedWorkspaceId === undefined) return;
    void resolveWalletWorkspaceId(routeWorkspaceId, followedWorkspaceId)
      .then((id) => {
        if (!cancelled) setWorkspaceId(id);
      })
      .catch((cause) => {
        if (!cancelled) setWorkspaceError(appReadErrorCopy(cause) || null);
      });
    return () => {
      cancelled = true;
    };
  }, [followedWorkspaceId, routeWorkspaceId]);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    await Promise.allSettled([refreshWallet(), refreshHistory()]);
  }, [workspaceId, refreshWallet, refreshHistory]);

  const grant = useCallback(async () => {
    if (!workspaceId) return;
    setGranting(true);
    setGrantError(null);
    try {
      await getWalletSource().grantDelegation({ workspaceId });
      await load();
    } catch (failure) {
      // grantWalletDelegation throws `wallet not created` when there is no
      // binding; every other refusal rides the server's `{error}` through
      // MonolithPhoneOperationError. A fetch miss keeps its own message.
      // That sentence belongs on the connect row — `error` only paints the
      // empty-wallet NetworkUnavailableState.
      setGrantError(phoneOperationFailureReason(failure));
    } finally {
      setGranting(false);
    }
  }, [workspaceId, load]);

  const copyAddress = useCallback(async () => {
    if (!wallet?.address) return;
    await Clipboard.setStringAsync(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [wallet?.address]);

  const disconnect = useCallback(async () => {
    if (revoking) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      await getWalletSource().revokeDelegation();
      await load();
    } catch (failure) {
      setRevokeError(phoneOperationFailureReason(failure));
    } finally {
      setRevoking(false);
    }
  }, [revoking, load]);

  const needsGrant = wallet !== null && !wallet.delegation.active;
  const address = wallet?.address ?? '';
  const coins = wallet?.coins ?? [];

  const frame = (children: React.ReactNode, scrollTestID?: string) => (
    <ConnectorFrame title={title} back={() => router.back()} backLabel="Back to Connectors" scrollTestID={scrollTestID}>
      {children}
    </ConnectorFrame>
  );

  if (workspaceId === null || workspaceError) {
    return frame(
      <Copy testID="wallet-workspace-missing">
        {workspaceError ?? 'Join or select a Workspace, then open Wallet again.'}
      </Copy>,
    );
  }

  if (error && wallet === null) return frame(<ConnectorNote tone="danger">{error}</ConnectorNote>);

  if (wallet === null) {
    return frame(<ConnectorLoading testID="wallet-loading"><PageLoader testID="wallet-loader" /></ConnectorLoading>);
  }

  return frame(
    <YStack gap="5" testID="wallet-screen">
      {needsGrant ? (
        // Nothing of the wallet shows until the connect sequence (the
        // grant to sign) has finished.
        <ConnectorCard>
          <ConnectorRow
            action={granting ? undefined : wallet.delegation.expiresAt !== null ? 'reconnect' : 'connect'}
            description={grantError ?? (wallet.delegation.expiresAt !== null
              ? WALLET_GRANT_ENDED_MESSAGE
              : 'Connect to let your agents sign and spend.')}
            descriptionTone={grantError ? 'danger' : undefined}
            onPress={grant}
            testID="wallet-connect-row"
            title="Wallet not connected"
            value={granting ? 'Connecting…' : undefined}
            valueTone={granting ? 'accent' : undefined}
            last
          />
        </ConnectorCard>
      ) : (
        <>
          {/* Address: one row, copy on the trailing axis, QR on demand. */}
          <YStack gap="2" testID="wallet-address">
            <T v="metaStrong" color="secondary">Address</T>
            <XStack gap="2" alignItems="center">
              <YStack flex={1} minWidth={0}>
                <T v="code" numberOfLines={1} {...SELECTABLE} testID="wallet-address-value">{address || '—'}</T>
              </YStack>
              <Btn kind="quiet" label="Copy address" onPress={copyAddress} testID="wallet-address-copy">{copied ? 'Copied' : 'Copy'}</Btn>
              <Btn kind="quiet" label="Show address QR code" onPress={() => setQrOpen((open) => !open)} testID="wallet-address-qr-toggle">QR</Btn>
            </XStack>
            {qrOpen ? (
              <YStack alignItems="center" paddingVertical="3" testID="wallet-address-qr">
                <WalletQr payload={address} size={160} />
              </YStack>
            ) : null}
          </YStack>

          <YStack alignItems="center" gap="2" testID="wallet-balance">
            <T v="title" testID="wallet-balance-value">{wallet?.totalUsd ?? '—'}</T>
            <Copy small quiet>Total balance</Copy>
            <XStack gap="2" paddingTop="2" testID="wallet-actions">
              {(['send', 'receive'] as const).map((action) => (
                <Btn
                  key={action}
                  label={action === 'send' ? 'Send' : 'Receive'}
                  onPress={() =>
                    router.push({
                      pathname: `/beeline/settings/workbench/wallet-${action}`,
                      params: { workspaceId },
                    } as unknown as Href)
                  }
                  testID={`wallet-action-${action}`}
                >
                  {action === 'send' ? 'Send' : 'Receive'}
                </Btn>
              ))}
            </XStack>
          </YStack>

          <Section title="Assets" testID="wallet-assets-head">
            {coins.length === 0 ? (
              <ConnectorRow title="No assets yet. Receive funds to get started." tone="quiet" last testID="wallet-assets-empty" />
            ) : (
              coins.map((coin, n) => {
                const mark = tokenIcon(coin.symbol);
                const badge = coin.chain ? chainIcon(coin.chain) : undefined;
                return (
                  <ConnectorRow
                    key={coin.symbol}
                    title={coin.name}
                    leading={mark ? <Image source={mark} width={TOKEN_ICON_SIZE} height={TOKEN_ICON_SIZE} borderRadius="full" />
                      : <YStack width={TOKEN_ICON_SIZE} height={TOKEN_ICON_SIZE} borderRadius="full" backgroundColor="highlight" alignItems="center" justifyContent="center">
                        <T v="metaStrong">{coin.symbol.slice(0, 1)}</T>
                      </YStack>}
                    descriptionContent={<XStack gap="2" alignItems="center">
                      <T v="meta" color="secondary">{coin.symbol}</T>
                      {badge && coin.chain ? (
                        <XStack gap="1" alignItems="center" testID={`wallet-coin-chain-${coin.chain}`}>
                          <Image source={badge} width={CHAIN_ICON_SIZE} height={CHAIN_ICON_SIZE} borderRadius="full" />
                          <T v="meta" color="secondary">{coin.chain}</T>
                        </XStack>
                      ) : null}
                    </XStack>}
                    trailing={<YStack alignItems="flex-end" gap="1">
                      <Copy>{coin.usd}</Copy>
                      <T v="meta" color="secondary">{coin.amount}</T>
                    </YStack>}
                    last={n === coins.length - 1}
                    testID={`wallet-coin-${coin.symbol}`}
                  />
                );
              })
            )}
          </Section>

          <Section title="Activity" testID="wallet-activity-head">
            {historyUnavailable ? (
              <YStack paddingVertical="3"><ConnectorNote tone="danger" testID="wallet-activity-unavailable">{historyError ?? ''}</ConnectorNote></YStack>
            ) : history === null ? (
              <YStack alignItems="flex-start" paddingVertical="3" testID="wallet-activity-loading">
                <SurfaceGlyphLoader compact testID="wallet-activity-loader" />
              </YStack>
            ) : history.length === 0 ? (
              <ConnectorRow title="No transactions yet." tone="quiet" last testID="wallet-activity-empty" />
            ) : (
              history.map((entry, index) => (
                <ConnectorRow
                  key={`${entry.createdAt}-${index}`}
                  leading={<YStack width={28} height={28} borderRadius="full" borderWidth={1} alignItems="center" justifyContent="center"
                    borderColor={entry.direction === 'in' ? 'added' : 'strongStroke'}>
                    <Glyph icon={entry.direction === 'in' ? ArrowDown : ArrowUp} size={16} />
                  </YStack>}
                  title={entry.direction === 'in'
                    ? 'Received'
                    : entry.agentName
                      ? `Sent by ${entry.agentName}`
                      : 'Sent'}
                  description={`${entry.counterparty} · ${entry.chain}`}
                  trailing={<YStack alignItems="flex-end" gap="1">
                    <T v="body" color={entry.direction === 'in' ? 'added' : 'ink'}>{entry.amountText}</T>
                    <T v="meta" color="secondary">{activityStamp(entry.createdAt)}</T>
                  </YStack>}
                  last={index === history.length - 1}
                  testID={`wallet-activity-${index}`}
                />
              ))
            )}
          </Section>
        </>
      )}
      <Section title="Agent permissions" testID="wallet-permissions-head">
        <YStack paddingVertical="3">
          <Copy small quiet testID="wallet-permissions">Your agents can prepare wallet actions within the permissions you grant. You review spending before it happens.</Copy>
        </YStack>
        {needsGrant ? null : (
          <ConnectorRow
            title="Revoke agent signing"
            description={revokeError ?? 'Your funds and transaction history stay in your wallet.'}
            descriptionTone={revokeError ? 'danger' : undefined}
            disabled={revoking}
            onPress={disconnect}
            value={revoking ? 'Revoking…' : undefined}
            testID="wallet-disconnect-row"
            last
          />
        )}
      </Section>
    </YStack>,
    'wallet-scroll',
  );
}

const TOKEN_ICON_SIZE = 36;
const CHAIN_ICON_SIZE = 16;

/** React Native's selectable text; Tamagui's Text types omit it but pass it through. */
const SELECTABLE = { selectable: true } as object;
