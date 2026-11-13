import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React from 'react';
import { YStack } from 'tamagui';
import { router, useLocalSearchParams } from 'expo-router';
import { WalletSendForm } from '@/buzz/wallet-send-form';
import { ConnectorFrame } from '@/ui/screens/settings/connectors/ConnectorParts';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Send (mock §Screens 3–4) — the standalone route, now a thin wrapper over
 * the shared `WalletSendForm` the wallet dashboard's Send tab also renders.
 */
export default function WalletSendScreen() {
  useLatencyRouteFrame('/beeline/settings/workbench/wallet-send');
  const params = useLocalSearchParams<{ workspaceId?: string | string[] }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  return (
    <ConnectorFrame title="Send" back={() => router.back()} backLabel="Back to Wallet" testID="wallet-send-screen" scroll={false}>
      <YStack flex={1} padding="4" gap="1">
        <WalletSendForm workspaceId={workspaceId} />
      </YStack>
    </ConnectorFrame>
  );
}
