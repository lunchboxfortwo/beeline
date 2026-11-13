import { RepositoryMark } from '@/components/buzz/RepositoryMark';
import React, { useEffect, useState } from 'react';
import { Card, Image, ListItem, RadioGroup, XStack, YStack } from 'tamagui';
import { Check, CornerDownRight } from 'lucide-react-native';
import type { AttachmentReference } from '@beeline/buzz-client';
import type { NeedsYouActionView, NeedsYouApprovalView, NeedsYouItemView } from '@beeline/api-contract/phone';
import { artifactImageSource, releaseArtifactImageSource } from '@/buzz/artifact-link';
import { compactRelativeTime } from '@/buzz/relative-time';
import { Btn, Copy, Glyph, HEIGHT, T } from '@/ui/grammar';
import { approveDecision, checksLine, denyDecision, squireEvidence, tagPlace, tagSentence, type TagDecision } from './tag-card-model';

export type TagCardActions = {
  /** Opens where the card was sent; a plain tag is read on the way. */
  open: (item: NeedsYouItemView) => void;
  decide: (item: NeedsYouItemView, decision: TagDecision) => Promise<void>;
  openImage: (item: NeedsYouItemView, image: AttachmentReference) => void;
};

/** One header on every card: the chat, then ↳ the thread or "· in the chat", the age in brass. */
function Where({ item, age }: { item: NeedsYouItemView; age: string }) {
  const place = tagPlace(item);
  return (
    <XStack gap="2" alignItems="flex-start" testID={`tag-where-${item.messageId}`}>
      <RepositoryMark avatarUrl={item.roomAvatar} faviconUrl={item.roomFavicon} size={20} />
      <XStack flex={1} minWidth={0} gap="1" alignItems="flex-start">
        {place.chat ? <Copy small strong>{place.chat}</Copy> : null}
        {place.thread ? (
          <>
            <YStack paddingTop="0.5" paddingLeft="1"><Glyph icon={CornerDownRight} size={14} /></YStack>
            <YStack flex={1} minWidth={0}><Copy small quiet>{place.thread}</Copy></YStack>
          </>
        ) : item.roomKind === 'direct' ? null : <Copy small quiet> · in the chat</Copy>}
      </XStack>
      {age ? <Copy small accent testID={`tag-age-${item.messageId}`}>{age}</Copy> : null}
    </XStack>
  );
}

function PullRequestBox({ pr }: { pr: NonNullable<NeedsYouApprovalView['pullRequest']> }) {
  const checks = checksLine(pr.checks);
  return (
    <Card backgroundColor="canvas" borderWidth={1} borderColor="strongStroke" padding="3" gap="2" aria-label="Pull request evidence">
      <Copy small quiet>{`Pull request #${pr.number}${checks ? ` · ${checks}` : ''}`}</Copy>
      <Copy strong>{pr.title}</Copy>
      {pr.additions !== undefined || pr.deletions !== undefined || pr.files !== undefined ? (
        <XStack gap="3" alignItems="center">
          {pr.additions !== undefined ? <T v="meta" color="added">{`+${pr.additions}`}</T> : null}
          {pr.deletions !== undefined ? <T v="meta" color="removed">{`−${pr.deletions}`}</T> : null}
          {pr.files !== undefined ? <Copy small quiet>{`${pr.files} ${pr.files === 1 ? 'file' : 'files'}`}</Copy> : null}
        </XStack>
      ) : null}
    </Card>
  );
}

/** Trusty Squire's card, merchant and amount, and what the payment is for. */
function SquireBox({ approval }: { approval: NeedsYouApprovalView }) {
  const evidence = squireEvidence(approval);
  return (
    <Card backgroundColor="canvas" borderWidth={1} borderColor="strongStroke" padding="3" gap="1" aria-label="Payment evidence">
      <Copy small quiet>{evidence.source}</Copy>
      {evidence.headline ? <Copy strong>{evidence.headline}</Copy> : null}
      {evidence.purpose ? <Copy small quiet>{evidence.purpose}</Copy> : null}
    </Card>
  );
}

/** Facts the request carries: a shared grant's details. */
function FactsBox({ approval }: { approval: NeedsYouApprovalView }) {
  return (
    <Card backgroundColor="canvas" borderWidth={1} borderColor="strongStroke" padding="3" gap="1" aria-label="Request evidence">
      {approval.facts?.map((fact) => (
        <Copy key={`${fact.label}:${fact.value}`} small>{`${fact.label} · ${fact.value}`}</Copy>
      ))}
      {approval.purpose ? <Copy small quiet>{approval.purpose}</Copy> : null}
    </Card>
  );
}

/** The asking message's image, full width; it opens in the viewer. */
function AskImage({ image, onOpen }: { image: AttachmentReference; onOpen: () => void }) {
  const [source, setSource] = useState<{ uri: string; headers?: { authorization: string } } | null>(null);
  useEffect(() => {
    let live = true;
    let loaded: { uri: string } | null = null;
    const controller = new AbortController();
    void artifactImageSource(image, { signal: controller.signal, preview: true })
      .then((next) => {
        loaded = next;
        if (live) setSource(next);
        else releaseArtifactImageSource(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      controller.abort();
      releaseArtifactImageSource(loaded);
    };
  }, [image.url, image.mimeType, image.size, image.sha256]);
  const ratio = image.width && image.height ? image.width / image.height : 16 / 10;
  return (
    <ListItem padding="0" borderRadius="md" borderWidth={1} borderColor="strongStroke" backgroundColor="canvas" overflow="hidden"
      aria-label={`Open ${image.title ?? image.name}`} accessibilityRole="button" testID="tag-image"
      onPress={(event: { stopPropagation?: () => void }) => { event?.stopPropagation?.(); onOpen(); }}>
      <YStack width="100%" aspectRatio={ratio} backgroundColor="highlight">
        {source ? <Image source={source} width="100%" height="100%" resizeMode="cover" aria-label={image.title ?? image.name} /> : null}
      </YStack>
    </ListItem>
  );
}

/** A choice's options; the server records no recommended one, so none is pre-picked. */
function Options({ item, value, onChange }: { item: NeedsYouItemView; value: string; onChange: (id: string) => void }) {
  const options = (item.approval?.actions ?? []).filter(
    (action): action is Extract<NeedsYouActionView, { kind: 'choice' }> => action.kind === 'choice');
  if (!options.length) return null;
  return (
    <YStack onPress={(event: { stopPropagation?: () => void }) => event?.stopPropagation?.()}>
      <RadioGroup aria-label={item.approval?.subject} value={value} onValueChange={onChange} gap="2">
        {options.map((option) => {
          const on = value === option.optionId;
          return (
            <ListItem key={option.optionId} gap="3" alignItems="flex-start" padding="2" borderRadius="md" borderWidth={1}
              borderColor={on ? 'strongStroke' : 'stroke'} backgroundColor={on ? 'highlight' : 'raised'}
              minHeight={HEIGHT.control} onPress={() => onChange(option.optionId)} aria-label={option.label}
              testID={`tag-option-${option.optionId}`}>
              <RadioGroup.Item value={option.optionId} id={`${item.messageId}-${option.optionId}`} marginTop="1" aria-label={option.label}
                theme={on ? 'brand' : undefined}>
                <RadioGroup.Indicator />
              </RadioGroup.Item>
              <YStack flex={1} minWidth={0} gap="1">
                <Copy strong>{option.label}</Copy>
                {option.detail && option.detail !== option.label ? <Copy small quiet>{option.detail}</Copy> : null}
              </YStack>
            </ListItem>
          );
        })}
      </RadioGroup>
    </YStack>
  );
}

/**
 * One Tags card. Tapping it (outside its controls) opens where it was sent.
 * A request carries its evidence and Approve / Deny; a plain tag is outlined
 * in brass while it is fresh.
 */
export const TagCard = React.memo(function TagCard({ item, now, actions }: {
  item: NeedsYouItemView;
  now: number;
  actions: TagCardActions;
}) {
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);
  const approval = item.approval;
  const sentence = tagSentence(item);
  const relative = compactRelativeTime(item.createdAt, now);
  const fresh = relative === 'now';
  const age = fresh ? 'just now' : relative;
  const approve = approveDecision(item, choice);
  const deny = denyDecision(item);
  const hasChoices = approval?.kind === 'choice' && (approval.actions ?? []).some((action) => action.kind === 'choice');
  const offersDecision = Boolean(approve || deny || hasChoices);
  const squire = approval?.kind === 'squire';
  const detail = approval && approval.kind !== 'choice' && !squire && approval.detail !== sentence.text ? approval.detail : undefined;
  const send = async (decision: TagDecision | null) => {
    if (!decision || busy) return;
    setBusy(true);
    try {
      await actions.decide(item, decision);
    } finally {
      setBusy(false);
    }
  };
  const press = (decision: TagDecision | null) => (event?: { stopPropagation?: () => void }) => {
    event?.stopPropagation?.();
    void send(decision);
  };
  return (
    <Card backgroundColor="raised" borderWidth={1} borderColor={!approval && fresh ? 'needsYou' : 'stroke'} padding="3" gap="3"
      onPress={() => actions.open(item)} accessibilityRole="button"
      aria-label={`Open the message: ${[sentence.lead, sentence.text].filter(Boolean).join(' ')}`}
      testID={`tag-card-${item.messageId}`}>
      <Where item={item} age={age} />
      <YStack gap="1">
        <T v="body" color="needsYou" testID={`tag-sentence-${item.messageId}`}>
          {sentence.lead ? <T v="heading" color="needsYou">{`${sentence.lead} `}</T> : null}
          {sentence.literal ? null : sentence.text}
        </T>
        {sentence.literal ? <T v="code" testID={`tag-literal-${item.messageId}`}>{sentence.text}</T> : null}
        {approval?.forName ? <Copy small quiet>{`for ${approval.forName}`}</Copy> : null}
        {detail ? <Copy small quiet testID={`tag-detail-${item.messageId}`}>{detail}</Copy> : null}
      </YStack>
      {approval?.image ? <AskImage image={approval.image} onOpen={() => actions.openImage(item, approval.image!)} /> : null}
      {approval?.pullRequest ? <PullRequestBox pr={approval.pullRequest} /> : null}
      {approval && squire ? <SquireBox approval={approval} /> : null}
      {approval && !squire && (approval.facts?.length || approval.purpose) ? <FactsBox approval={approval} /> : null}
      {approval?.script ? (
        <YStack gap="2">
          <Btn kind="quiet" label="Script" alignSelf="flex-start" paddingHorizontal="0"
            onPress={(event: { stopPropagation?: () => void }) => { event?.stopPropagation?.(); setScriptOpen((open) => !open); }}
            testID={`tag-script-toggle-${item.messageId}`}>
            <Copy small quiet>{`Script · ${approval.script.contents.replace(/\r?\n$/, '').split('\n').length} lines`}</Copy>
          </Btn>
          {scriptOpen ? (
            <YStack gap="1" testID={`tag-script-${item.messageId}`}>
              <Copy small quiet>{approval.script.path}</Copy>
              <T v="code">{approval.script.contents}</T>
            </YStack>
          ) : null}
        </YStack>
      ) : null}
      {hasChoices ? <Options item={item} value={choice} onChange={setChoice} /> : null}
      {offersDecision ? (
        <XStack gap="2" flexWrap="wrap">
          <Btn kind="primary" minHeight={HEIGHT.control} label={`Approve: ${sentence.text}`} disabled={!approve || busy}
            onPress={press(approve)} testID={`tag-approve-${item.messageId}`}>
            <XStack gap="2" alignItems="center">
              <Glyph icon={Check} size={16} color="primaryInk" />
              <T v="heading" color="primaryInk">Approve</T>
            </XStack>
          </Btn>
          {deny ? (
            <Btn kind="secondary" label={`Deny: ${sentence.text}`} disabled={busy} onPress={press(deny)}
              testID={`tag-deny-${item.messageId}`}>Deny</Btn>
          ) : null}
        </XStack>
      ) : null}
    </Card>
  );
});
