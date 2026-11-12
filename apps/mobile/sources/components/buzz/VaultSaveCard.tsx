import React, { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { YStack } from 'tamagui';
import { T } from '@/ui/grammar';
import { readVaultSaveCard, type VaultSaveCard as Card } from '@beeline/api-contract/phone';
import { TranscriptCard } from './TranscriptCard';
import { HullDialogInput } from './HullDialog';
import { Button } from './Button';
import { AgentCardLine } from './AgentApprovalCard';
import { monolithSession } from '@/auth/monolith-session';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';

/** Values live only in this mounted form and its one HTTPS request, never in the chat draft. */
export function VaultSaveCard({
  card,
  cardId,
  roomId,
  viewerId,
  agentName,
  stamp,
}: {
  card: Card;
  cardId: string;
  roomId: string;
  viewerId: string;
  agentName: string;
  stamp?: string;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Card | null>(null);
  const [error, setError] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const isOwner = viewerId === card.ownerId;
  card = saved ?? card;
  const settled = saved || card.status === 'saved';
  useEffect(() => {
    setValues({});
    setShown({});
    setSaved(null);
    setError(false);
    setDismissed(false);
  }, [cardId]);
  useEffect(() => {
    if (card.status === 'saved' || !isOwner) {
      setValues({});
      setShown({});
    }
  }, [card.status, isOwner]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        setValues({});
        setShown({});
      }
    });
    return () => listener.remove();
  }, []);
  // The asking agent's transcript line carries the card (build spec, chat-milo-cards).
  const line = (node: React.ReactNode) => (
    <AgentCardLine sender={{ name: agentName, stamp: stamp ?? '', mark: { kind: 'agent', seed: card.agentId } }}>{node}</AgentCardLine>
  );
  if (!isOwner && !settled)
    return line(
      <TranscriptCard
        tier="record"
        title={`${agentName} wants a vault entry`}
        subline={`waiting for @${card.ownerName}`}
        testID="vault-save-waiting"
      />
    );
  const submit = async () => {
    if (busy || settled || !isOwner || card.fields.some((f) => !values[f.name]?.length)) return;
    setBusy(true);
    setError(false);
    const submitted = { ...values };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 75_000);
    setValues({});
    setShown({});
    try {
      const response = await monolithSession.fetch(
        `${getBuzzRuntimeConfig().monolithUrl}/v1/vault-save/submit`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cardId, roomId, values: submitted }),
          signal: controller.signal,
        },
        { timeoutMs: 75_000 },
      );
      const result = (await response.json()) as { status?: string; card?: unknown };
      const savedCard = readVaultSaveCard(result.card);
      if (!response.ok || result.status !== 'saved' || savedCard?.status !== 'saved') {
        setError(true);
        return;
      }
      setSaved(savedCard);
    } catch {
      setError(true);
    } finally {
      clearTimeout(timeout);
      for (const name of Object.keys(submitted)) delete submitted[name];
      setBusy(false);
    }
  };
  const canType = isOwner && !settled && !dismissed;
  const time = card.savedAt
    ? new Date(card.savedAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  return line(
    <TranscriptCard
      tier={canType ? 'ask' : 'record'}
      title={`${agentName} wants a ${card.service} ${card.authStrategy === 'username_password' ? 'login' : 'entry'}`}
      wrapTitle
      decisionNote
      subline={isOwner ? 'to your vault · for you' : `to @${card.ownerName}'s vault`}
      facts={[
        { label: 'For', value: card.purpose },
        {
          label: settled ? 'Saved as' : 'Saves to',
          value: `${settled ? '' : 'Your vault · '}${card.service} / ${card.label}`,
        },
        ...(settled
          ? [{ label: 'Fields', value: card.fields.map((f) => f.label).join(' · ') }]
          : []),
        { label: 'Sent only to', value: card.allowedHosts.join(', ') },
      ]}
      footerNote={
        settled
          ? `Saved by ${isOwner ? 'you' : card.ownerName}${time ? ` · ${time}` : ''}`
          : undefined
      }
      actions={
        canType
          ? [
              {
                label: 'Approve',
                primary: true,
                loading: busy,
                disabled: busy || card.fields.some((f) => !values[f.name]?.length),
                onPress: () => {
                  void submit();
                },
              },
              {
                label: 'Deny',
                secondary: true,
                onPress: () => {
                  setValues({});
                  setShown({});
                  setDismissed(true);
                },
              },
            ]
          : isOwner && dismissed && !settled
            ? [{ label: 'Enter values', onPress: () => setDismissed(false) }]
            : []
      }
      testID="vault-save-card"
      inlineError={error ? {
        title: 'Your vault could not save this entry.',
        description: 'Values were cleared. Check the helper is online, enter them again and retry.',
      } : undefined}
    >
      {canType && (
        <YStack gap="4">
          {card.fields.map((field) => (
            <YStack key={field.name} gap="2">
              <T v="meta" color="ink">{field.label}</T>
              <HullDialogInput
                variant="boxed"
                accessibilityLabel={field.label}
                value={values[field.name] ?? ''}
                onChangeText={(value) =>
                  setValues((current) => ({ ...current, [field.name]: value }))
                }
                secureTextEntry={field.secret && !shown[field.name]}
                autoCorrect={false}
                autoCapitalize="none"
                autoComplete="off"
                importantForAutofill="no"
                textContentType="none"
                readOnly={busy}
                maxLength={16_384}
                placeholder={field.label}
                testID={`vault-save-${field.name}`}
                accessory={
                  field.secret ? (
                    <Button
                      size="inline"
                      label={shown[field.name] ? 'Hide' : 'Show'}
                      accessibilityLabel={`${shown[field.name] ? 'Hide' : 'Show'} ${field.label}`}
                      onPress={() =>
                        setShown((current) => ({ ...current, [field.name]: !current[field.name] }))
                      }
                    />
                  ) : undefined
                }
              />
            </YStack>
          ))}
          <T v="meta" color="secondary">
            Goes from this card straight to your Trusty Squire vault. {agentName} and the chat only
            learn that it was saved.
          </T>
        </YStack>
      )}
    </TranscriptCard>
  );
}
