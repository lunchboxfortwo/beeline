import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React from 'react';
import { YStack } from 'tamagui';
import { router, useLocalSearchParams } from 'expo-router';
import { WalletQr } from '@/components/buzz/WalletQr';
import { useSharedWallet } from '@/buzz/wallet-surface';
import { Copy, T } from '@/ui/grammar';
import { ConnectorCard, ConnectorFrame, ConnectorRow } from '@/ui/screens/settings/connectors/ConnectorParts';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Receive (mock §Screens 5): one address, one QR. Same address on every
 * EVM chain. Solana is the only exception — a separate CDP account, shown
 * as its own row with a different address. The QR painting is the shared
 * `WalletQr` the dashboard also renders.
 */
export default function WalletReceiveScreen() {
  useLatencyRouteFrame('/beeline/settings/workbench/wallet-receive');
  const params = useLocalSearchParams<{ workspaceId?: string | string[] }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  const { value: wallet } = useSharedWallet(workspaceId);
  const address = wallet?.address ?? '';
  const solanaAddress = wallet?.solanaAddress ?? null;

  return (
    <ConnectorFrame title="Receive" back={() => router.back()} backLabel="Back to Wallet" testID="wallet-receive-screen">
      <YStack alignItems="center" gap="2">
        <WalletQr payload={address} />
        <T v="code" {...SELECTABLE} testID="wallet-receive-address">{address}</T>
        <Copy small quiet>Same address on every EVM chain.</Copy>
      </YStack>
      <ConnectorCard>
        <ConnectorRow title="Solana" description={solanaAddress ?? 'different address'} last testID="wallet-receive-solana" />
      </ConnectorCard>
    </ConnectorFrame>
  );
}

/** React Native's selectable text; Tamagui's Text types omit it but pass it through. */
const SELECTABLE = { selectable: true } as object;
