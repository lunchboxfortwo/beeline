import { useArtifactRowVisible } from '@/buzz/artifact-viewport';
import Ionicons from '@expo/vector-icons/Ionicons';
import { LedgerUntaggedHint } from '@/components/buzz/Ledger';
import { TurnSettledLine } from '@/components/buzz/TurnProgressLine';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import type { AttachmentReference } from '@beeline/buzz-client';
import { XStack, YStack } from 'tamagui';
import { ContentTarget } from '@/components/buzz/IndexRow';
import { agentActivityReplyExcerpt, canBeginReply } from '@/buzz/message-reply';
import { resolvePendingAgentDisplay } from '@/buzz/agent-display';
import { fallbackMemberName } from '@/buzz/member-display';
import { CHANNEL_MENTION_HANDLE, SYSTEM_MENTION_HANDLE, hasChannelMentionToken } from '@/buzz/room-participants';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';
import { shouldShowReplyReference } from '@/buzz/reply-reference';
import { draftRequestId, provisionalDraftKey } from '@/buzz/draft-settle';
import { RoomPresentationContext } from '@/buzz/room-presentation-context';
import { splitLedgerText } from '@/buzz/ledger-text';
import { splitViewerContext } from '@/buzz/viewer-conversation';
import { parseConnectorReceipt } from '@/buzz/connector-receipt';
import { ledgerStamp } from '@/buzz/relative-time';
import { isLedgerDayOpener } from '@/buzz/message-dates';
import { useTranscriptStamp } from '@/buzz/use-transcript-stamp';
import { messageArtifactGroup } from '@/buzz/artifact-group';
import { TranscriptReference } from '@/components/buzz/TranscriptReference';
import { ArtifactCard } from '@/components/buzz/ArtifactCard';
import { CORNER_LABEL } from '@/buzz/vocabulary';
import { openExternalUrl } from '@/utils/open-external-url';
import { ActivityTimeline, TurnStepsLine } from '@/components/buzz/ActivityTimeline';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { MessageReactionRoster } from '@/components/buzz/MessageReactionRoster';
import { parseCornerProposal } from '@/buzz/corner-proposal';
import { LedgerEntry, LedgerGhostLine, LedgerSystemLine, LedgerSteer, type LedgerByline } from '@/components/buzz/Ledger';
import { NewMessageMaterialize } from '@/components/buzz/MonoHull';
import { TranscriptCard } from '@/components/buzz/TranscriptCard';
import { TranscriptLine } from '@/ui/screens/transcript/TranscriptLine';
import { RequestFrame } from '@/ui/screens/transcript/cards/RequestCard';
import { forwardedMessageParts } from '@/buzz/message-forward';
import { agentMessageJsonMarkdown } from '@/buzz/agent-message-json';
import { T } from '@/ui/grammar';
import { OrdinaryLedgerMessageProps, SwipeToReply, ConnectorReceiptCard, ExpiredAttachmentRow, ViewerContextReference } from './RoomMessageVariants-attachment-card';



export const OrdinaryLedgerMessage = React.memo(function OrdinaryLedgerMessage({
  message,
  agent,
  participantsHydrated,
  personName,
  personAvatar,
  personFace,
  viewerPubkey,
  speakerWorking,
  continued,
  immediatelyPrecedingMessage,
  firstBylineOfDay,
  referencedTarget,
  participantHandles,
  channelIndex,
  deliveryFailed,
  sendState,
  sendFailureIds,
  onRetry,
  untaggedHint = false,
  onChannelReference,
  codeRoomId,
  onOpenCode,
  onOpenSource,
  onMention,
  onOpenProfile,
  onTapOutsideComposer,
  onReply,
  onCopy,
  onMessageActions,
  onReact = () => undefined,
  onForward = () => undefined,
  onBookmark = () => undefined,
  onReportIssue,
  onForwardToNewCorner,
  onCornerProposalDecision,
  cornerProposalAction = null,
  cornerProposalAnswer = null,
  onDismiss,
  announcementFeed = false,
  desktopLayout = false,
}: OrdinaryLedgerMessageProps) {
  const liveDraftDrainStore = React.useContext(RoomPresentationContext);
  const artifactVisible = useArtifactRowVisible(message.id, Boolean(message.attachments?.some(attachment => !attachment.expired)));
  const replyAvailable = canBeginReply(message, codeRoomId ?? message.reference?.channelId ?? '');
  const isOwn = message.isUser;
  const indexedAuthor = message.authorIdentity;
  // A loaded roster entry is the current identity. Historical rows may still
  // carry the face or generated avatar that was current when they were cached,
  // including artwork the agent has since removed.
  const speakerFace = agent ? agent.face : (personFace ?? indexedAuthor?.face);
  const speakerAvatar = agent ? agent.avatar : (personAvatar ?? indexedAuthor?.avatar);
  const currentAgent =
    indexedAuthor?.kind === 'agent'
      ? {
          pubkey: indexedAuthor.pubkey,
          displayName: indexedAuthor.name,
          ...(indexedAuthor.avatar ? { avatar: indexedAuthor.avatar } : {}),
          ...(agent?.soulProfile ? { soulProfile: agent.soulProfile } : {}),
          // This row's own server identity names the face first; the roster
          // entry fills it in for a row the index has not identified.
          ...(speakerFace ? { face: speakerFace } : {}),
        }
      : agent;
  const isAgent =
    indexedAuthor?.kind === 'agent' ||
    message.isAgentAuthor ||
    message.isAgentActivity ||
    Boolean(currentAgent);
  const cornerProposal =
    isAgent && !message.isAgentActivity && !message.isAgentDraft
      ? parseCornerProposal(message.text)
      : null;
  const display = isAgent
    ? resolvePendingAgentDisplay(
        message.pubkey ?? indexedAuthor?.pubkey ?? 'unknown-agent',
        currentAgent,
        participantsHydrated,
      )
    : null;
  const isSelfSteer = isOwn && !isAgent;
  const dayOpener = isLedgerDayOpener(message.timestamp, immediatelyPrecedingMessage?.timestamp);
  const bylineOpener = firstBylineOfDay ?? dayOpener;
  const stamp = useTranscriptStamp(message.timestamp, bylineOpener && !message.isAgentActivity);
  const continuedRun = continued && !bylineOpener;
  const voiceName = isAgent
    ? (indexedAuthor?.name ??
      display?.name ??
      personName ??
      fallbackMemberName(message.pubkey ?? ''))
    : (indexedAuthor?.name ??
      personName ??
      (message.pubkey ? fallbackMemberName(message.pubkey) : 'SOMEONE'));
  const markSeed = message.pubkey ?? (isSelfSteer ? viewerPubkey || 'self' : 'unknown-person');
  const byline: LedgerByline | undefined =
    // The same rule for people and agents: follow-ups sit under the sender line.
    continuedRun &&
    !announcementFeed &&
    !message.bookmarked &&
    !message.feedbackReported
      ? undefined
      : {
          // The viewer's name is brass; their body is ink like everyone's.
          name: voiceName,
          onOpenProfile:
            !announcementFeed && message.pubkey && onOpenProfile
              ? () =>
                  isAgent ? onOpenProfile(message.pubkey!) : onOpenProfile(message.pubkey!, 'human')
              : undefined,
          // The byline is a nested profile Pressable. Giving that Pressable
          // the row's long-press action makes React Native cancel its onPress
          // on release instead of navigating behind the actions sheet.
          onLongPress: onMessageActions ? () => onMessageActions(message) : undefined,
          stamp,
          isViewer: isSelfSteer,
          bookmarked: message.bookmarked,
          feedbackReported: message.feedbackReported,
          ...(announcementFeed
            ? {}
            : {
                mark: {
                  seed: markSeed,
                  kind: isAgent ? ('agent' as const) : ('human' as const),
                  ...(speakerFace ? { face: speakerFace } : {}),
                  ...(speakerAvatar ? { avatarUrl: speakerAvatar } : {}),
                  ...(isAgent ? { alive: speakerWorking } : {}),
                },
              }),
        };
  // A row with no activity of its own still has its text to show, so it is
  // lifted into one `output` item — which `buildTurnActivity` renders as
  // narration, at the settled tier. A LIVE DRAFT is the one row that must
  // never take that path: its words are provisional, they are already rendered
  // in the provisional face through `messageDraft`, and promoting them here
  // printed the same unfinished sentence twice, the first copy dressed as the
  // durable reply.
  const activity = useMemo(
    () =>
      message.activity?.length
        ? message.activity
        : message.isAgentDraft
          ? []
          : [{ kind: 'output' as const, title: 'Output', text: message.text }],
    [message.activity, message.isAgentDraft, message.text],
  );
  // What the reader is being shown while the turn writes, remembered under the
  // turn's own request id. The durable reply below collects it and fades out
  // of it; nothing about the draft itself changes (C98).
  const draftKey =
    message.pubkey && (message.agentMessageDraft || message.agentMessageDraftKey)
      ? draftRequestId(message.id)
      : undefined;
  useEffect(() => {
    if (!draftKey || !message.pubkey) return;
    const text =
      message.agentMessageDraft ??
      (message.agentMessageDraftKey
        ? liveDraftDrainStore.getReceived(message.agentMessageDraftKey)
        : '');
    if (!text) return;
    liveDraftDrainStore.rememberProvisionalDraft(provisionalDraftKey(message.pubkey, draftKey), text);
  }, [draftKey, liveDraftDrainStore, message.agentMessageDraft, message.agentMessageDraftKey, message.pubkey]);
  // Spent once per settled reply, and decided once per mounted row: a
  // re-render mid-transition must not restart or cancel the dissolve.
  const settleRef = useRef<string | undefined>(undefined);
  if (settleRef.current === undefined) {
    settleRef.current =
      isAgent && message.requestId && message.pubkey && !message.isAgentActivity
        ? (liveDraftDrainStore.takeProvisionalDraft(provisionalDraftKey(message.pubkey, message.requestId)) ?? '')
        : '';
  }
  const settleFrom = settleRef.current || undefined;
  const taggedMentionPubkeys = useMemo(
    () => new Set(message.mentionPubkeys ?? []),
    [message.mentionPubkeys],
  );
  const mentionHandles = useMemo(() => {
    const handles = participantHandles
      .filter((participant) => taggedMentionPubkeys.has(participant.pubkey) ||
        (isAgent && message.text.toLocaleLowerCase().includes(`@${participant.handle.toLocaleLowerCase()}`)))
      .map((participant) => participant.handle);
    // `@channel` is sent as one literal token, never expanded into names, so
    // it is highlighted by its own reserved handle rather than a roster hit.
    if (hasChannelMentionToken(message.text)) handles.push(CHANNEL_MENTION_HANDLE);
    if (message.text.toLocaleLowerCase().includes('@system')) handles.push(SYSTEM_MENTION_HANDLE);
    return handles;
  }, [participantHandles, taggedMentionPubkeys, message.text, isAgent]);
  const viewerHandle = useMemo(
    () => participantHandles.find((participant) => participant.pubkey === viewerPubkey)?.handle,
    [participantHandles, viewerPubkey],
  );
  const handleMention = useCallback(
    (handle: string) => {
      if (handle === SYSTEM_MENTION_HANDLE) {
        onMention?.(SYSTEM_IDENTITY_PUBKEY);
        return;
      }
      const participant = participantHandles.find(
        (candidate) =>
          candidate.pubkey !== viewerPubkey &&
          (taggedMentionPubkeys.has(candidate.pubkey) || isAgent) &&
          candidate.handle.normalize('NFKC').toLocaleLowerCase() === handle,
      );
      if (participant) onMention?.(participant.pubkey);
    },
    [onMention, participantHandles, taggedMentionPubkeys, viewerPubkey, isAgent],
  );
  if (message.isAgentActivity) {
    const excerpt = agentActivityReplyExcerpt(message);
    return (
      <YStack width="100%" minWidth={0} testID="corner-activity">
        <SwipeToReply
          messageId={message.id}
          onLongPress={() => onCopy(excerpt)}
          onActions={onMessageActions ? () => onMessageActions(message) : undefined}
          {...(onTapOutsideComposer ? { onPress: onTapOutsideComposer } : {})}
          onReply={replyAvailable ? () => onReply(message) : undefined}
          onReact={() => undefined}
          onForward={() => undefined}
          isDesktop={desktopLayout}
          replyOnly
        >
          <ActivityTimeline
            active={message.isAgentLiveTurn === true}
            chronological={desktopLayout}
            handle={!continuedRun && isAgent ? voiceName : undefined}
            mark={
              !continuedRun && isAgent
                ? {
                    seed: markSeed,
                    kind: 'agent',
                    // Same axes the settled byline mark renders (its creature,
                    // and working → gold ring): the streaming lane is the same
                    // speaker, so it must not wear a different animal for the
                    // length of the turn.
                    ...(speakerFace ? { face: speakerFace } : {}),
                    ...(speakerAvatar ? { avatarUrl: speakerAvatar } : {}),
                    alive: message.isAgentLiveTurn === true,
                  }
                : undefined
            }
            items={activity}
            messageDraft={message.agentMessageDraft}
            messageDraftKey={message.agentMessageDraftKey}
            stamp={ledgerStamp(message.timestamp)}
            testID="corner-activity-timeline"
          />
        </SwipeToReply>
      </YStack>
    );
  }

  const showReplyReference = shouldShowReplyReference({
    replyToId: message.replyToId,
    speaksAsAgent: isAgent,
    immediatelyPrecedingMessage,
  });
  const replySourceRoomId = message.reference?.channelId ?? codeRoomId;
  const replySourceMessageId = message.replyToId;
  const replyReference = showReplyReference ? (
    <TranscriptReference
      accessibilityLabel="Open original message"
      onPress={onOpenSource && replySourceRoomId && replySourceMessageId
        ? () => onOpenSource(replySourceRoomId, replySourceMessageId) : undefined}
      testID={`reply-reference-${message.id}`}
    >
      ↳ {referencedTarget?.authorName ?? 'ORIGINAL MESSAGE'} ·{' '}
      {referencedTarget?.preview ?? 'Message not loaded'}
    </TranscriptReference>
  ) : null;
  const forwarded = forwardedMessageParts(message.text);
  const forwardSource = forwarded.source;
  const forwardBodyAction =
    forwardSource && onOpenSource
      ? {
          accessibilityLabel: 'Open original forwarded message',
          onPress: () => onOpenSource(forwardSource.roomId, forwardSource.messageId),
          testID: `forward-source-${message.id}`,
        }
      : undefined;
  const connectorReceipt = parseConnectorReceipt(forwarded.body);
  const receiptBody = connectorReceipt ? connectorReceipt.prose : forwarded.body;
  const viewerMessage = !isAgent ? splitViewerContext(receiptBody) : { body: receiptBody };
  const ledgerText = isSelfSteer ? undefined : splitLedgerText(viewerMessage.body);
  const proseBody = ledgerText ? ledgerText.prose : viewerMessage.body;
  const renderedBody = isAgent ? (agentMessageJsonMarkdown(proseBody) ?? proseBody) : proseBody;
  const receiptCard =
    connectorReceipt && !isSelfSteer ? (
      <ConnectorReceiptCard receipt={connectorReceipt.receipt} identity={message.authorIdentity} />
    ) : null;
  const ghostLine = ledgerText?.machine ? (
    <LedgerGhostLine
      body={ledgerText.machine}
      label={`${ledgerText.machineLines} lines of tool output`}
      testID={`chat-machine-noise-${message.id}`}
    />
  ) : null;
  // A Room reply carries its turn's steps — tool calls and the text written
  // before the answer — and shows them folded under the prose.
  const stepsLine =
    isAgent && message.activity?.length ? (
      <TurnStepsLine items={message.activity} testID={`reply-steps-${message.id}`} />
    ) : null;
  const machineNoise =
    ghostLine || stepsLine ? (
      <>
        {ghostLine}
        {stepsLine}
      </>
    ) : null;
  // The first attachment of a "Viewing artifact" message is the viewed file,
  // already named by the viewer reference line.
  const viewerContext = viewerMessage.context;
  const viewedAttachment = useCallback((attachment: AttachmentReference, index: number) =>
    Boolean(viewerContext) && index === 0 &&
    (viewerContext!.startsWith('Viewing artifact:') || attachment.name === 'browser-screen.jpg'), [viewerContext]);
  // Two or more live files share one stacked card at the first file's place.
  // Memoized so the memoized card is not redrawn by an unrelated row update.
  // Every live file is one artifact card; the file's own url/mime/name/size
  // decides, never the optional server decoration that used to flip the shape.
  const artifactGroup = useMemo(() => messageArtifactGroup(message.attachments, viewedAttachment),
    [message.attachments, viewedAttachment]);
  const firstGroupArtifact = artifactGroup?.[0];
  const command = message.agentCommand;
  const askingViewer = command?.kind === 'report' && command.status === 'needs-decision' &&
    Boolean(viewerPubkey) && command.recipient.id === viewerPubkey ? command : null;
  const attachments = message.attachments?.map((attachment, index) => {
    if (viewedAttachment(attachment, index)) return null;
    if (!attachment.expired) {
      if (artifactGroup && attachment !== firstGroupArtifact) return null;
      return (
        <ArtifactCard
          visible={!message.attachmentUploadPending && artifactVisible}
          attachment={attachment}
          authorHandle={
            attachment.author ??
            (message.authorIdentity?.kind === 'agent'
              ? (message.authorIdentity.handle ?? message.authorIdentity.name).replace(/^@/, '')
              : undefined)
          }
          isDesktop={desktopLayout}
          key={`${message.id}-${attachment.url}`}
          {...(artifactGroup ? { groupAttachments: artifactGroup } : {})}
        />
      );
    }
    return (
      <ExpiredAttachmentRow
        attachment={attachment}
        key={`${message.id}-${attachment.url}`}
      />
    );
  });

  const viewerReference = viewerMessage.context ? (
    <ViewerContextReference context={viewerMessage.context} attachment={message.attachments?.[0]}
      roomId={codeRoomId} timestamp={message.timestamp} isDesktop={desktopLayout}
      testID={`viewer-context-${message.id}`} />
  ) : null;
  const messageReference = viewerReference ? (
    <>{replyReference}{viewerReference}</>
  ) : (
    replyReference
  );

  // A local send is tap feedback; never hide it behind the arrival fade.
  const content = (
    <NewMessageMaterialize enabled={Boolean(message.isNew) && !message.isUser} messageId={message.id}>
      <>
        {isSelfSteer ? (
          <LedgerSteer
            itemId={message.id}
            continued={continuedRun}
            chronological={desktopLayout}
            precededByDayCaption={dayOpener}
            byline={byline}
            bodyText={viewerMessage.body}
            pending={Boolean(sendState)}
            mentionHandles={mentionHandles}
            viewerHandle={viewerHandle}
            onMention={handleMention}
            channelIndex={channelIndex}
            onChannelReference={onChannelReference}
            codeRoomId={codeRoomId}
            onOpenCode={onOpenCode}
            bodyTestID={`chat-message-text-${message.id}`}
            bodyAction={forwardBodyAction}
            replyReference={messageReference}
            attachments={attachments}
          />
        ) : cornerProposal ? (
          <TranscriptCard
            tier={onCornerProposalDecision && !cornerProposalAnswer ? 'ask' : 'record'}
            testID={`corner-proposal-${message.id}`}
            identity={
              <IdentityMark
                kind="agent"
                seed={markSeed}
                avatarUrl={speakerAvatar}
                face={speakerFace}
                name={voiceName}
                size={26}
              />
            }
            title={`Proposed ${CORNER_LABEL}: ${cornerProposal.title}`}
            wrapTitle
            subline={cornerProposal.objective}
            stamp={ledgerStamp(message.timestamp)}
            body={cornerProposal.warnings.length ? cornerProposal.warnings.join('\n') : undefined}
            quietBody
            choices={(
              [
                ['open', 'A', `Open ${CORNER_LABEL}`],
                ['cancel', 'B', 'Cancel'],
              ] as const
            ).map(([decision, letter, label]) => ({
              id: `corner-proposal-${decision}-${message.id}`,
              letter,
              label,
              consequence: '',
              selected: (cornerProposalAnswer?.decision ?? cornerProposalAction) === decision,
              ...(onCornerProposalDecision && !cornerProposalAnswer && !cornerProposalAction
                ? { onPress: () => onCornerProposalDecision(message, decision) }
                : {}),
            }))}
            footerNote={
              cornerProposalAnswer
                ? `${
                    cornerProposalAnswer.decision === 'open'
                      ? 'opened'
                      : cornerProposalAnswer.decision === 'cancel'
                        ? 'cancelled'
                        : 'answered'
                  } · @${cornerProposalAnswer.handle}`
                : undefined
            }
            footerNoteTestID={`corner-proposal-footer-${message.id}`}
          />
        ) : message.awayWarning ? (
          <TranscriptCard tier="record" testID="away-warning-card" wrapTitle
            title="Routines will pause in 1 day"
            body={message.text} stamp={ledgerStamp(message.timestamp)} />
        ) : (message.authorIdentity?.pubkey ?? message.pubkey) === SYSTEM_IDENTITY_PUBKEY ? (
          <LedgerSystemLine
            id={message.id}
            text={renderedBody}
            {...(message.systemEvent ? { event: message.systemEvent } : {})}
            stamp={ledgerStamp(message.timestamp)}
            onOpenUrl={(url) => void openExternalUrl(url).catch(() => undefined)}
          />
        ) : askingViewer ? (
          // A decision report to you reads as the agent's question (build spec, thread frame).
          <LedgerEntry
            itemId={message.id}
            byline={byline}
            continued={continuedRun}
            chronological={desktopLayout}
            precededByDayCaption={dayOpener}
            bodyText=""
            bodyTestID={`chat-message-text-${message.id}`}
            replyReference={messageReference}
            attachments={<RequestFrame ask={askingViewer.text} testID={`request-${message.id}`}>{attachments}</RequestFrame>}
          />
        ) : (
          <LedgerEntry
            itemId={message.id}
            byline={byline}
            continued={continuedRun}
            chronological={desktopLayout}
            precededByDayCaption={dayOpener}
            luminous={isAgent && !announcementFeed}
            typewriter={isAgent && !announcementFeed && Boolean(message.isNew)}
            settleFrom={settleFrom}
            bodyText={renderedBody}
            mentionHandles={mentionHandles}
            viewerHandle={viewerHandle}
            onMention={handleMention}
            channelIndex={channelIndex}
            onChannelReference={onChannelReference}
            codeRoomId={codeRoomId}
            onOpenCode={onOpenCode}
            bodyTestID={`chat-message-text-${message.id}`}
            bodyAction={forwardBodyAction}
            replyReference={messageReference}
            machineNoise={machineNoise}
            attachments={attachments}
          />
        )}
        {receiptCard || forwarded.caption || message.reactions?.length ||
          (untaggedHint && isSelfSteer) || (message.isUser && sendState && sendFailureIds?.length) ? (
          // Everything under a message sits in its column, clear of the face.
          <TranscriptLine>
          {receiptCard}
          {forwarded.caption ? (
            forwardSource && onOpenSource ? (
              <ContentTarget
                accessibilityLabel="Open original forwarded message"
                accessibilityRole="button"
                onPress={() => onOpenSource(forwardSource.roomId, forwardSource.messageId)}
                testID={`forward-source-caption-${message.id}`}
              >
                <T v="metaStrong" color="secondary" textTransform="uppercase" marginTop="1" testID={`forward-caption-${message.id}`}>
                  {forwarded.caption}
                </T>
              </ContentTarget>
            ) : (
              <T v="metaStrong" color="secondary" textTransform="uppercase" marginTop="1" testID={`forward-caption-${message.id}`}>
                {forwarded.caption}
              </T>
            )
          ) : null}
          {untaggedHint && isSelfSteer && !deliveryFailed &&
            (message.pubkey ?? indexedAuthor?.pubkey) === viewerPubkey ? (
            <LedgerUntaggedHint messageId={message.id} />
          ) : null}
          {message.isUser && sendState && sendState.kind !== 'sending' && sendFailureIds?.length ? (
            <TurnSettledLine inset={false} leadingGlyph={false} multiline
              line={sendFailureIds.length > 1 ? `${sendFailureIds.length} not sent` : sendState.text}
              action={onRetry ? { label: sendFailureIds.length > 1 ? 'Retry all' : 'Retry', onPress: () => onRetry(sendFailureIds) } : undefined}
              testID={`outbox-delivery-failed-${message.id}`} />
          ) : null}
          {message.reactions?.length ? (
            <XStack flexWrap="wrap" gap="2" marginTop="1" marginBottom="1" marginLeft="2" testID={`reaction-chips-${message.id}`}>
              {message.reactions.map((reaction) => (
                <MessageReactionRoster
                  desktop={desktopLayout}
                  key={reaction.emoji}
                  messageId={message.id}
                  onReact={() => onReact(message, reaction.emoji)}
                  reaction={reaction}
                />
              ))}
            </XStack>
          ) : null}
          </TranscriptLine>
        ) : null}
      </>
    </NewMessageMaterialize>
  );
  if (announcementFeed) return content;
  return (
    <SwipeToReply
      messageId={message.id}
      onLongPress={() => onCopy(message.text)}
      onActions={onMessageActions ? () => onMessageActions(message) : undefined}
      {...(sendState && onMessageActions
        ? { onPress: () => onMessageActions(message) }
        : onTapOutsideComposer ? { onPress: onTapOutsideComposer } : {})}
      onReply={replyAvailable ? () => onReply(message) : undefined}
      onReact={(emoji) => onReact(message, emoji)}
      onForward={() => onForward(message)}
      onBookmark={() => onBookmark(message)}
      {...(onReportIssue && !message.isAgentDraft && !message.isAgentActivity
        ? { onReportIssue: () => onReportIssue(message) }
        : {})}
      {...(onForwardToNewCorner && !message.isAgentDraft
        ? // A message someone else wrote can carry the swipe-to-corner tip.
          { onSwipeThread: () => onForwardToNewCorner(message) }
        : {})}
      bookmarked={message.bookmarked}
      isDesktop={desktopLayout}
    >
      {content}
    </SwipeToReply>
  );
});
