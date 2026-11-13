import { useTextDraft } from '@/buzz/use-text-draft';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Input, XStack, YStack } from 'tamagui';
import { Btn, T } from '@/ui/grammar';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { HullActionSheetModal, HullActionSheetRow } from '@/components/buzz/HullActionSheet';
import { chainFeeLabel, getWalletSource } from '@/buzz/wallet-source';
import type { WalletChainView, WalletSendOutcome, WalletView } from '@beeline/api-contract/wallet';

/**
 * The send form, shared by the wallet dashboard's Send tab and the
 * standalone `wallet-send` route: Amount, To, then Via — the chain sits in
 * a popup over the same screen, next to what it costs. The only refusals
 * are insufficient funds and an expired delegation; both settle as a named
 * outcome inline.
 */
export function WalletSendForm({ workspaceId}: { workspaceId: string }) {
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [amount, setAmount, amountDraft] = useTextDraft(`wallet:${workspaceId}:amount`, '');
  const [to, setTo, toDraft] = useTextDraft(`wallet:${workspaceId}:to`, '');
  const [chain, setChain] = useState<WalletChainView | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [outcome, setOutcome] = useState<WalletSendOutcome | null>(null);
  const [sending, setSending] = useState(false);
  const attemptHeld = useRef(false);

  useEffect(() => {
    void getWalletSource()
      .readWallet({ workspaceId})
      .then((view) => {
        setWallet(view);
        setChain(view.chains.find((candidate) => candidate.id === 'base') ?? view.chains[0] ?? null);
      })
      .catch(() => setWallet(null));
  }, [workspaceId]);

  const defaultAsset = useMemo(() => wallet?.coins[0]?.symbol.toLowerCase() ?? 'usdc', [wallet]);

  const send = useCallback(async () => {
    if (!chain || !amount || !to || attemptHeld.current) return;
    attemptHeld.current = true;
    let uncertain = false;
    const clearAmount = amountDraft.capture();
    const clearTo = toDraft.capture();
    setSending(true);
    try {
      const result = await getWalletSource().sendFromWallet({
        workspaceId,
        chain: chain.id,
        asset: defaultAsset,
        amount,
        to,
      });
      uncertain = result.outcome === 'pending';
      setOutcome(result);
      if (result.outcome === 'sent') {
        clearAmount();
        clearTo();
      }
    } catch {
      uncertain = true;
      setOutcome({ outcome: 'pending', reason: 'The result is unknown. Do not send again while it is unconfirmed.' });
    } finally {
      attemptHeld.current = uncertain;
      setSending(false);
    }
  }, [workspaceId, chain, amount, to, defaultAsset, amountDraft, toDraft]);

  const blocked = sending || outcome?.outcome === 'pending' || !amount || !to;
  return (
    <YStack testID="wallet-send-form">
      <T v="meta" color="secondary">Amount</T>
      <XStack alignItems="baseline" gap="2">
        <Input
          flex={1}
          keyboardType="decimal-pad"
          onChangeText={setAmount}
          testID="wallet-send-amount"
          value={amount}
        />
        <T v="meta" color="secondary">{defaultAsset.toUpperCase()}</T>
      </XStack>
      <T v="meta" color="secondary">To</T>
      <Input
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setTo}
        placeholder="0x…"
        placeholderTextColor="secondary"
        testID="wallet-send-to"
        value={to}
      />
      <T v="meta" color="secondary" marginTop="4">Via</T>
      <YStack onPress={() => setPickerOpen(true)} accessibilityRole="button" testID="wallet-send-chain">
        <SettingsRow
          description={chain ? chainFeeLabel(chain) : undefined}
          testID="wallet-send-chain-row"
          title={chain?.name ?? 'Chain'}
        />
      </YStack>
      {outcome ? (
        <T v="meta" color={outcome.outcome === 'sent' ? 'ink' : 'secondary'} marginTop="4" testID="wallet-send-outcome">
          {outcome.outcome === 'sent'
            ? `Sent ${outcome.amountText} · ${outcome.balanceAfterUsd} left`
            : outcome.outcome === 'insufficient'
              ? `Not enough ${outcome.asset} — ${outcome.available} available`
              : outcome.outcome === 'delegation-expired'
                ? 'Your permission to let agents sign has expired. Renew it on the wallet screen.'
                : outcome.outcome === 'pending'
                  ? `Result pending · ${outcome.reason}`
                  : `Could not send · ${outcome.reason}`}
        </T>
      ) : null}
      <Btn
        kind="quiet"
        accessibilityRole="button"
        disabled={blocked}
        onPress={send}
        testID="wallet-send-confirm"
        label="Send"
        marginTop="6"
      >
        <T v="heading" color="needsYou" textAlign="center">Send</T>
      </Btn>
      <HullActionSheetModal
        onClose={() => setPickerOpen(false)}
        testID="wallet-chain-picker"
        title="send via"
        visible={pickerOpen}
      >
        {(wallet?.chains ?? []).map((candidate) => (
          <HullActionSheetRow
            key={candidate.id}
            disabled={!candidate.hasBalance}
            label={candidate.name}
            metadata={chainFeeLabel(candidate)}
            onPress={() => {
              setChain(candidate);
              setPickerOpen(false);
            }}
            selected={chain?.id === candidate.id}
            testID={`wallet-chain-${candidate.id}`}
          />
        ))}
      </HullActionSheetModal>
    </YStack>
  );
}
