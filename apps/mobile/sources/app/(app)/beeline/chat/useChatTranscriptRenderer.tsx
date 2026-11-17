import { VaultSaveCard } from '@/components/buzz/VaultSaveCard';
import { RepositoryOnboardingCard } from './RepositoryOnboardingCard';
import React, { useCallback, useMemo } from 'react';
import { YStack } from 'tamagui';
import { T } from '@/ui/grammar';
import { router } from 'expo-router';
import { Modal } from '@/modal';
import { type RoomRepository, type MessageReactionEmoji } from '@beeline/buzz-client';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { type ChannelReferenceIndex, type ChannelReferenceTarget } from '@/buzz/channel-reference';
import { continuedSpeakerIds, ledgerSpeakerKey } from '@/buzz/ledger-attribution';
import { ledgerStamp } from '@/buzz/relative-time';
import { openAppSignIn } from '@/buzz/app-sign-in';
import { AgentSignInCard } from '@/components/buzz/AgentSignInCard';
import { ComputerSessionCard } from '@/components/buzz/ComputerSession';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { messageJumpHref } from '@/buzz/corner-navigation';
import { type MessageReplyDisplayTarget } from '@/buzz/message-reply';
import { archiveActionPresentation, liveCardPresentation, messageFailureGroups, messageRosterPresentation, useRoomMessageRenderItem } from '@/buzz/room-message-cell';
import type { RoomMessagePresentation, RoomMessageRenderContext } from '@/buzz/room-message-cell';
import { GitHubEventCard, NotificationLifecycleCard, DaemonFactCard, GrantRequestCard, SquireApprovalCard, ConnectorOfferCard, AppSignInCard, ChoiceCard, WalletCards, agentCommandTranscriptMessage, OrdinaryLedgerMessage, TargetBranchProposalCard, WritePermissionCard } from './RoomMessageVariants';
import { monolithPhoneOperation, phoneOperationFailureReason } from '@/sync/transport/monolith-operation';
import { CornerOpenedMarkers } from '@/components/buzz/CornerOpenedMarker';
import { LedgerRoomUpdate, LedgerSystemLine } from '@/components/buzz/Ledger';
import { type RoomRosterParticipant } from '@/buzz/room-participants';
import { rosterAgent, durableFactLine, knownAgentPubkeysFor } from './chat-surface-values';
import { TranscriptPills, type PillIdentityResolver } from '@/components/buzz/TranscriptPills';
import { canDecideGrantRequest, GrantRequestPill } from '@/components/buzz/GrantRequestCard';
import { isPillMessage } from '@/buzz/transcript-pills';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';

type Props = [
  viewerIsAgent: boolean,
  canManageWorkspace: boolean,
  permissionActionId: string | null,
  grantActionId: string | null,
  choiceActionId: string | null,
  connectorOfferActionId: string | null,
  appSignInActionId: string | null,
  targetBranchActionId: string | null,
  roomRepository: RoomRepository | null,
  participantsHydrated: boolean,
  personProfileByPubkey: Map<string, { face?: string | undefined; avatar?: string | undefined; handle?: string | undefined; pubkey: string; name: string; }>,
  agentProfileModelByPubkey: Map<string, string>,
  agentByPubkey: Map<string, import("@/buzz/agent-display").DisplayableAgent>,
  roomParticipants: RoomRosterParticipant[],
  decodedId: string,
  cacheViewerPubkey: string,
  roomName: string,
  rowActions: { handleWritePermission: (message: ChatDisplayMessage, decision: "allow" | "deny") => Promise<void>; beginForward: (message: ChatDisplayMessage) => Promise<void>; handleForwardToNewCorner: (message: ChatDisplayMessage) => void; handleConfirmTargetBranch: (message: ChatDisplayMessage) => Promise<void>; handleOpenChannelReference: (target: ChannelReferenceTarget, text?: string) => Promise<void>; handleOpenMention: (participantId: string) => Promise<void>; },
  openCorner: (subchannelId: string | undefined) => void,
  handleGrantDecision: (grantId: string, decision: "always" | "once" | "deny") => Promise<void>,
  desktopExperience: boolean,
  handleChoiceAnswer: (choiceId: string, optionId: string, note?: string) => Promise<void>,
  handleChoiceSkip: (choiceId: string) => Promise<void>,
  setAppSignInActionId: React.Dispatch<React.SetStateAction<string | null>>,
  activeCommunityId: string | null,
  handleAcceptConnectorOffer: (offerId: string, connectorType: string) => Promise<void>,
  setConnectorOfferActionId: React.Dispatch<React.SetStateAction<string | null>>,
  continueConnectorOffer: (offerId: string, connectorType: string, pairedConnectorId: string, reconnect: boolean) => Promise<void>,
  openWorkbench: () => void,
  isCorner: boolean,
  handleOpenGitHubEvent: (url: string) => void,
  targetBranchNotice: { proposalId: string; text: string; } | null,
  setTargetBranchActionId: React.Dispatch<React.SetStateAction<string | null>>,
  handleOpenSystemIdentity: () => void,
  openCurrentBrief: (() => void) | undefined,
  replyTargetForMessage: (message: ChatDisplayMessage) => MessageReplyDisplayTarget,
  isReadOnlyDirectMessage: boolean,
  channelReferenceIndex: ChannelReferenceIndex,
  handleOpenCode: (messageId: string) => void,
  handleOpenMessageSource: (roomId: string, messageId: string) => void,
  handleOpenProfile: (agentId: string, kind?: "human" | "agent") => void,
  dismissComposerKeyboard: () => void,
  beginReply: (message: ChatDisplayMessage) => void,
  handleCopyLedgerMessage: (text: string) => void,
  openMessageActions: (message: ChatDisplayMessage) => void,
  handleReactToMessage: (message: ChatDisplayMessage, emoji: MessageReactionEmoji) => Promise<void>,
  handleBookmarkMessage: (message: ChatDisplayMessage) => Promise<void>,
  handleReportMessage: (message: ChatDisplayMessage) => Promise<void>,
  isDirectMessage: boolean,
  isArchived: boolean,
  handleCornerProposalDecision: (message: ChatDisplayMessage, decision: "open" | "cancel") => void,
  dismissOutboxMessage: (eventId: string) => void,
  isDesktop: boolean,
  bylineOpeners: Set<string>,
  hintMessageIds: ReadonlySet<string>,
  failedOutboxIds: ReadonlySet<string>,
  outbox: import("@/app/(app)/beeline/chat/useRoomSurfaceSession").RoomSurfaceOutboxHandle,
  speakerWorking: Readonly<Record<string, true>>,
  answerByMessageId: Map<string, { decision: "open" | "cancel" | null; handle: string; }>,
  cornerProposalAction: { messageId: string; decision: "open" | "cancel"; } | null,
  speakerRoleByPubkey: Map<string, string>,
  visibleMessageById: Map<string, ChatDisplayMessage>,
  channelReferenceKey: string,
  visibleMessages: ChatDisplayMessage[],
  continuedAttributionIds: Set<string>,
  immediatelyPrecedingVisibleMessageById: Map<string, ChatDisplayMessage>,
  firstNewMessageId: string | null,
  arrivalFlashMessageId: string | null,
  sourceLandingFlashMessageId: string | null,
];

export function useChatTranscriptRenderer([
  viewerIsAgent, canManageWorkspace, permissionActionId, grantActionId, choiceActionId,
  connectorOfferActionId, appSignInActionId, targetBranchActionId, roomRepository,
  participantsHydrated, personProfileByPubkey, agentProfileModelByPubkey, agentByPubkey,
  roomParticipants, decodedId, cacheViewerPubkey, roomName, rowActions, openCorner,
  handleGrantDecision, desktopExperience, handleChoiceAnswer, handleChoiceSkip,
  setAppSignInActionId, activeCommunityId, handleAcceptConnectorOffer, setConnectorOfferActionId,
  continueConnectorOffer, openWorkbench, isCorner, handleOpenGitHubEvent, targetBranchNotice,
  setTargetBranchActionId, handleOpenSystemIdentity, openCurrentBrief, replyTargetForMessage,
  isReadOnlyDirectMessage, channelReferenceIndex, handleOpenCode, handleOpenMessageSource,
  handleOpenProfile, dismissComposerKeyboard, beginReply, handleCopyLedgerMessage,
  openMessageActions, handleReactToMessage, handleBookmarkMessage, handleReportMessage,
  isDirectMessage, isArchived, handleCornerProposalDecision, dismissOutboxMessage, isDesktop,
  bylineOpeners, hintMessageIds, failedOutboxIds, outbox, speakerWorking, answerByMessageId,
  cornerProposalAction, speakerRoleByPubkey, visibleMessageById, channelReferenceKey,
  visibleMessages, continuedAttributionIds, immediatelyPrecedingVisibleMessageById,
  firstNewMessageId, arrivalFlashMessageId, sourceLandingFlashMessageId,
]: Props): [
  renderItem: ({ item }: { item: ChatDisplayMessage; }) => import("react/jsx-runtime").JSX.Element,
] {

  const knownAgentPubkeys = useMemo(() => knownAgentPubkeysFor(agentByPubkey), [agentByPubkey]);
  // A pill face: the Beeline account, or the roster's agent or person by id.
  const resolvePillIdentity = useCallback<PillIdentityResolver>((id, name, kind) => {
    if (id === SYSTEM_IDENTITY_PUBKEY) return { kind: 'system', name: 'Beeline' };
    const agent = agentByPubkey.get(id);
    if (agent || (kind === 'agent' && !personProfileByPubkey.has(id))) {
      return {
        kind: 'agent', seed: id, name: agent?.displayName || name,
        ...(agent?.face ? { face: agent.face } : {}),
        ...(agent?.avatar ? { avatarUrl: agent.avatar } : {}),
      };
    }
    const person = personProfileByPubkey.get(id);
    return {
      kind: 'human', seed: id, name: person?.name || name,
      ...(person?.face ? { face: person.face } : {}),
      ...(person?.avatar ? { avatarUrl: person.avatar } : {}),
    };
  }, [agentByPubkey, personProfileByPubkey]);

  const renderMessage = useCallback(
    (
      item: ChatDisplayMessage,
      {
        continued: attributionContinued,
        immediatelyPrecedingMessage,
        referencedMessage,
        firstBylineOfDay,
        untaggedHint,
        deliveryFailed = false,
        desktopLayout: rowDesktopLayout = false,
        sendState,
        sendFailureIds,
        speakerWorking: rowSpeakerWorking = false,
        cornerProposalAnswer,
        cornerProposalAction: rowCornerProposalAction,
        roomArchived: rowRoomArchived,
        cornerSwipeEnabled: rowCornerSwipeEnabled,
        cornerProposalEnabled: rowCornerProposalEnabled,
        permissionActionId: rowPermissionActionId,
        grantActionId: rowGrantActionId,
        choiceActionId: rowChoiceActionId,
        connectorOfferActionId: rowConnectorOfferActionId,
        appSignInActionId: rowAppSignInActionId,
        targetBranchActionId: rowTargetBranchActionId,
        targetBranchNotice: rowTargetBranchNotice,
        targetBranch: rowTargetBranch,
        canManageWorkspace: rowCanManage,
        viewerIsAgent: rowViewerIsAgent,
        participantsHydrated: rowParticipantsHydrated,
        personName: rowPersonName,
        personAvatar: rowPersonAvatar,
        personFace: rowPersonFace,
        agentPubkey: rowAgentPubkey,
        agentName: rowAgentName,
        agentAvatar: rowAgentAvatar,
        agentFace: rowAgentFace,
        agentHandle: rowAgentHandle,
      }: RoomMessageRenderContext,
    ) => {
      // Props win over the closed-over renderer. The cell only re-renders a row
      // whose live inputs changed, and this paint must use those inputs.
      // Roster fields that cross the memo boundary: participantsHydrated,
      // person name/avatar/face/handle, agent pubkey/name/avatar/face/handle,
      // agent model (byline role), speakerRole (room role), mentionHandles,
      // reply author name/handle, and channelReferenceKey. Archive fields:
      // roomArchived, cornerSwipeEnabled, and cornerProposalEnabled. The
      // closure still supplies handlers, layout flags, viewer pubkey, room
      // name, and the full handle list; mentionHandles is what makes a row
      // read that list again.
      const rowViewer = rowViewerIsAgent !== undefined ? rowViewerIsAgent : viewerIsAgent;
      const rowManage = rowCanManage !== undefined ? rowCanManage : canManageWorkspace;
      const rowPermission = rowPermissionActionId !== undefined ? rowPermissionActionId : permissionActionId;
      const rowGrant = rowGrantActionId !== undefined ? rowGrantActionId : grantActionId;
      const rowChoice = rowChoiceActionId !== undefined ? rowChoiceActionId : choiceActionId;
      const rowConnector = rowConnectorOfferActionId !== undefined ? rowConnectorOfferActionId : connectorOfferActionId;
      const rowAppSignIn = rowAppSignInActionId !== undefined ? rowAppSignInActionId : appSignInActionId;
      const rowBranchAction = rowTargetBranchActionId !== undefined ? rowTargetBranchActionId : targetBranchActionId;
      const rowBranch = rowTargetBranch !== undefined ? rowTargetBranch : roomRepository?.targetBranch;
      const rosterFromProps = rowParticipantsHydrated !== undefined;
      const rowHydrated = rosterFromProps ? rowParticipantsHydrated : participantsHydrated;
      const profileName = rosterFromProps
        ? rowPersonName
        : (item.pubkey ? personProfileByPubkey.get(item.pubkey)?.name : undefined);
      const profileAvatar = rosterFromProps ? rowPersonAvatar : undefined;
      const profileFace = rosterFromProps ? rowPersonFace : undefined;
      const agentFor = (pubkey: string | undefined) =>
        rosterAgent(pubkey, {
          agentPubkey: rowAgentPubkey,
          agentName: rowAgentName,
          agentAvatar: rowAgentAvatar,
          agentFace: rowAgentFace,
          agentHandle: rowAgentHandle,
        }, agentByPubkey);
      // System lines and agent-to-agent messages are avatar-only pills; a
      // folded run shares one wrapping row.
      const pillRun = item.pillRun ??
        (isPillMessage(item) ? [item] : null);
      if (pillRun) {
        return (
          <TranscriptPills
            run={pillRun}
            resolve={resolvePillIdentity}
            onOpenIdentity={handleOpenSystemIdentity}
            onOpenUrl={handleOpenGitHubEvent}
            onOpenBrief={openCurrentBrief}
            onOpenCorner={openCorner}
            cornerId={isCorner ? decodedId : undefined}
          />
        );
      }
      // An agent's order or report is ordinary transcript: the recipient leads
      // the text as an @mention and the row keeps its own author's byline.
      item = agentCommandTranscriptMessage(item, roomParticipants);
      if (item.vaultSave) {
        return <VaultSaveCard card={item.vaultSave} cardId={item.id} roomId={decodedId}
          stamp={ledgerStamp(item.timestamp)}
          viewerId={cacheViewerPubkey} agentName={agentFor(item.vaultSave.agentId)?.displayName ?? 'Agent'} />;
      }
      if (item.roomUpdate) {
        return (
          <LedgerRoomUpdate
            id={item.id}
            line={item.text}
            stamp={ledgerStamp(item.timestamp)}
            digest={item.roomUpdate.digest}
          />
        );
      }

      if (item.writePermission) {
        return (
          <WritePermissionCard
            message={item}
            roomName={roomName}
            agent={agentFor(item.writePermission.agentPubkey)}
            viewerIsAgent={rowViewer}
            viewerPubkey={cacheViewerPubkey}
            viewerCanManage={rowManage}
            actionId={rowPermission}
            targetBranch={rowBranch}
            onDecision={rowActions.handleWritePermission}
            onOpenCorner={openCorner}
          />
        );
      }

      if (item.grantRequest) {
        const card = (
          <GrantRequestCard
            message={item}
            agent={agentFor(item.grantRequest.agent.pubkey)}
            viewerIsAgent={rowViewer}
            viewerPubkey={cacheViewerPubkey}
            viewerCanManageWorkspace={rowManage}
            actionId={rowGrant}
            onDecision={handleGrantDecision}
            onOpenSource={(roomId, messageId) =>
              router.navigate(messageJumpHref(roomId, messageId, `squire-grant:${item.id}`))
            }
          />
        );
        return canDecideGrantRequest(item.grantRequest, cacheViewerPubkey, rowViewer, rowManage)
          ? card
          : <GrantRequestPill message={item} resolve={resolvePillIdentity} card={card} />;
      }
      if (item.squireApproval) {
        return (
          <SquireApprovalCard
            message={item}
            agent={agentFor(item.squireApproval.agent.pubkey)}
            viewerPubkey={cacheViewerPubkey}
            onOpenSource={(roomId, messageId) =>
              router.navigate(messageJumpHref(roomId, messageId, `squire-approval:${item.id}`))
            }
          />
        );
      }
      if (item.computerSession) {
        return (
          <ComputerSessionCard session={item.computerSession} messageId={item.id} roomId={decodedId} isDesktop={desktopExperience}
          agentHandle={item.authorIdentity?.kind === 'agent' ? item.authorIdentity.handle : undefined} />
        );
      }
      // The active call lives below the Room header; ended calls use LedgerSystemLine.
      if (item.voiceCall && !item.voiceCall.endedAt) return null;
      if (item.onboarding) return <RepositoryOnboardingCard card={item.onboarding} viewerId={cacheViewerPubkey} author={item.authorIdentity} />;
      if (item.choice) {
        return (
          <ChoiceCard
            message={item}
            agent={agentFor(item.choice.agent.pubkey)}
            viewerIsAgent={rowViewer}
            viewerPubkey={cacheViewerPubkey}
            actionId={rowChoice}
            onAnswer={handleChoiceAnswer}
            onSkip={handleChoiceSkip}
            onReply={!rowDesktopLayout && !isReadOnlyDirectMessage ? beginReply : undefined}
          />
        );
      }

      if (item.appSignIn) {
        const card = item.appSignIn;
        const agentName = resolveAgentDisplayIdentity(
          card.agentId,
          agentFor(card.agentId),
        ).name;
        return (
          <AppSignInCard
            message={item}
            agentName={agentName}
            canConnect={!rowViewer && cacheViewerPubkey === card.ownerId}
            busy={rowAppSignIn === card.appId}
            onConnect={() => {
              if (rowAppSignIn || rowViewer || cacheViewerPubkey !== card.ownerId) return;
              setAppSignInActionId(card.appId);
              void monolithPhoneOperation('beginAppSignIn', { appId: card.appId })
                .then((result) =>
                  openAppSignIn(result.authorizationUrl, {
                    workspaceId: activeCommunityId ?? '',
                    viewerId: cacheViewerPubkey,
                    roomId: decodedId,
                    appId: card.appId,
                  }),
                )
                .catch((error) =>
                  Modal.alert('Could not connect app', phoneOperationFailureReason(error)),
                )
                .finally(() => setAppSignInActionId(null));
            }}
          />
        );
      }
      if (item.agentSignIn) {
        const card = item.agentSignIn;
        const agentName = resolveAgentDisplayIdentity(
          card.agentId,
          agentFor(card.agentId),
        ).name;
        return (
          <AgentSignInCard
            card={card}
            agentName={agentName}
            isOwner={!rowViewer && cacheViewerPubkey === card.ownerId}
            onSubmit={async (code) => {
              try {
                await monolithPhoneOperation('completeAgentSignIn', {
                  roomId: decodedId,
                  messageId: item.id,
                  code,
                });
              } catch (error) {
                throw new Error(phoneOperationFailureReason(error));
              }
            }}
            testID={`agent-sign-in-${item.id}`}
          />
        );
      }
      if (item.connectorOffer) {
        return (
          <ConnectorOfferCard
            message={item}
            agent={agentFor(item.connectorOffer.agent.pubkey)}
            viewerIsAgent={rowViewer}
            viewerPubkey={cacheViewerPubkey}
            viewerCanManage={rowManage}
            actionId={rowConnector}
            onAccept={handleAcceptConnectorOffer}
            onDecline={async offerId => {
              if (rowConnector) return;
              setConnectorOfferActionId(offerId);
              try { await monolithPhoneOperation('decideApprovalCard', { roomId: decodedId, messageId: item.id, decision: 'deny' }); }
              catch (error) { Modal.alert('Could not decline', phoneOperationFailureReason(error)); }
              finally { setConnectorOfferActionId(null); }
            }}
            onContinue={(offerId, connectorType, pairedConnectorId) =>
              void continueConnectorOffer(offerId, connectorType, pairedConnectorId, item.connectorOffer!.intent === 'reconnect')
            }
            onOpenWorkbench={openWorkbench}
            onOpenReplacement={messageId => handleOpenMessageSource(decodedId, messageId)}
          />
        );
      }

      if (item.notificationLifecycleRun) {
        return (
          <NotificationLifecycleCard
            message={item}
            cornerId={isCorner ? decodedId : undefined}
            onOpenCorner={openCorner}
            onOpenUrl={handleOpenGitHubEvent}
          />
        );
      }

      if (item.walletTx || item.walletInsufficient || item.walletDelegation) {
        return <WalletCards message={item} stamp={ledgerStamp(item.timestamp)} />;
      }

      if (item.targetBranchProposal) {
        const notice =
          rowTargetBranchNotice !== undefined
            ? rowTargetBranchNotice
            : targetBranchNotice?.proposalId === item.targetBranchProposal.proposalId
              ? targetBranchNotice.text
              : null;
        return (
          <TargetBranchProposalCard
            message={item}
            roomName={roomName}
            agent={agentFor(item.targetBranchProposal.agentPubkey)}
            currentTargetBranch={rowBranch}
            canManageWorkspace={rowManage}
            viewerIsAgent={rowViewer}
            actionId={rowBranchAction}
            notice={notice}
            onConfirm={rowActions.handleConfirmTargetBranch}
            viewerPubkey={cacheViewerPubkey}
            onDeny={async () => {
              if (rowBranchAction) return;
              setTargetBranchActionId(item.targetBranchProposal!.proposalId);
              try { await monolithPhoneOperation('decideApprovalCard', { roomId: decodedId, messageId: item.id, decision: 'deny' }); }
              catch (error) { Modal.alert('Could not decline', phoneOperationFailureReason(error)); }
              finally { setTargetBranchActionId(null); }
            }}
          />
        );
      }
      if (item.corner) {
        return null;
      }

      if (item.githubEvent) {
        return <GitHubEventCard message={item} onOpenCorner={openCorner} onOpenUrl={handleOpenGitHubEvent} />;
      }

      if (item.daemonFact) {
        return (
          <YStack>
            <DaemonFactCard
              message={item}
              onOpenCorner={openCorner}
              onOpenUrl={handleOpenGitHubEvent}
            />
          </YStack>
        );
      }

      // ── Archived notice ──────────────────────────────────────────
      if (item.isArchivedNotice) {
        return (
          <YStack paddingVertical="2" marginBottom="4" alignSelf="center" maxWidth="90%">
            <T v="code" color="secondary" textAlign="center">□ THREAD ARCHIVED · READ-ONLY</T>
          </YStack>
        );
      }

      // ── System line: one renderer for every server-phrased notification ──
      if (item.isSystemNotice) {
        return (
          <LedgerSystemLine
            id={item.id}
            text={item.text}
            {...(item.systemEvent ? { event: item.systemEvent } : {})}
            stamp={ledgerStamp(item.timestamp)}
            onOpenIdentity={handleOpenSystemIdentity}
            onOpenUrl={handleOpenGitHubEvent}
            onOpenBrief={openCurrentBrief}
          />
        );
      }

      if (item.durableFact) {
        return (
          <LedgerRoomUpdate
            id={item.id}
            line={durableFactLine(item)}
            stamp={ledgerStamp(item.timestamp)}
            tone={item.durableFact.kind === 'failure' ? 'brass' : 'quiet'}
          />
        );
      }

      const knownAgent = agentFor(item.pubkey);
      const personName = profileName;
      const referencedTarget = referencedMessage
        ? replyTargetForMessage(referencedMessage)
        : undefined;
      const ledgerMessage = (
        <OrdinaryLedgerMessage
          message={item}
          firstBylineOfDay={firstBylineOfDay}
          desktopLayout={rowDesktopLayout}
          announcementFeed={isReadOnlyDirectMessage}
          {...(knownAgent ? { agent: knownAgent } : {})}
          participantsHydrated={rowHydrated}
          {...(personName ? { personName } : {})}
          {...(profileAvatar ? { personAvatar: profileAvatar } : {})}
          {...(profileFace ? { personFace: profileFace } : {})}
          viewerPubkey={cacheViewerPubkey}
          speakerWorking={rowSpeakerWorking}
          continued={attributionContinued}
          {...(immediatelyPrecedingMessage ? { immediatelyPrecedingMessage } : {})}
          {...(referencedTarget ? { referencedTarget } : {})}
          participantHandles={roomParticipants}
          channelIndex={channelReferenceIndex}
          untaggedHint={untaggedHint}
          deliveryFailed={deliveryFailed}
          sendState={sendState}
          sendFailureIds={sendFailureIds}
          onRetry={outbox.retry}
          onChannelReference={rowActions.handleOpenChannelReference}
          codeRoomId={decodedId}
          onOpenCode={handleOpenCode}
          onOpenSource={handleOpenMessageSource}
          onMention={rowActions.handleOpenMention}
          onOpenProfile={handleOpenProfile}
          onTapOutsideComposer={dismissComposerKeyboard}
          onReply={beginReply}
          onCopy={handleCopyLedgerMessage}
          onMessageActions={openMessageActions}
          onReact={handleReactToMessage}
          onForward={rowActions.beginForward}
          onBookmark={handleBookmarkMessage}
          onReportIssue={handleReportMessage}
          {...((rowCornerSwipeEnabled ??
            (!isDirectMessage && !isArchived && !viewerIsAgent && !desktopExperience)) &&
          rowRoomArchived !== true
            ? { onForwardToNewCorner: rowActions.handleForwardToNewCorner }
            : {})}
          {...((rowCornerProposalEnabled ??
            (!isCorner &&
              !isArchived &&
              !viewerIsAgent &&
              !isReadOnlyDirectMessage &&
              !cornerProposalAnswer)) &&
          rowRoomArchived !== true
            ? { onCornerProposalDecision: handleCornerProposalDecision }
            : {})}
          cornerProposalAnswer={cornerProposalAnswer}
          cornerProposalAction={rowCornerProposalAction}
          onDismiss={dismissOutboxMessage}
        />
      );
      return item.cornerMarkers?.length ? (
        <YStack>
          {ledgerMessage}
          <CornerOpenedMarkers message={item} onOpenCorner={openCorner} onOpenUrl={handleOpenGitHubEvent} />
        </YStack>
      ) : (
        ledgerMessage
      );
    },
    [
      knownAgentPubkeys,
      resolvePillIdentity,
      rowActions,
      openCorner,
      isDirectMessage,
      agentByPubkey,
      agentProfileModelByPubkey,
      isDesktop,
      handleGrantDecision,
      handleChoiceAnswer,
      handleChoiceSkip,
      handleOpenSystemIdentity,
      openCurrentBrief,
      handleOpenCode,
      handleOpenMessageSource,
      handleReactToMessage,
      handleBookmarkMessage,
      handleReportMessage,
      handleCornerProposalDecision,
      grantActionId,
      connectorOfferActionId,
      appSignInActionId,
      activeCommunityId,
      cacheViewerPubkey,
      decodedId,
      handleAcceptConnectorOffer,
      continueConnectorOffer,
      openWorkbench,
      choiceActionId,
      openCorner,
      participantsHydrated,
      permissionActionId,
      personProfileByPubkey,
      cacheViewerPubkey,
      roomRepository?.targetBranch,
      roomName,
      roomParticipants,
      targetBranchActionId,
      targetBranchNotice,
      canManageWorkspace,
      viewerIsAgent,
      beginReply,
      dismissOutboxMessage,
      outbox.retry,
      replyTargetForMessage,
      channelReferenceIndex,
      dismissComposerKeyboard,
      handleOpenProfile,
      handleOpenGitHubEvent,
      handleCopyLedgerMessage,
      openMessageActions,
      isReadOnlyDirectMessage,
      isDirectMessage,
      desktopExperience,
      isArchived,
      isCorner,
      decodedId,
    ],
  );

  // Resolve changing transcript-wide indexes before the memo boundary. A new
  // hint, byline opener, working speaker, or this row's roster paint changes
  // only that row's props.
  const failureGroups = useMemo(() => messageFailureGroups(visibleMessages, outbox.states), [visibleMessages, outbox.states]);
  const presentationForMessage = useCallback((item: ChatDisplayMessage): RoomMessagePresentation => ({
    desktopLayout: isDesktop,
    firstBylineOfDay: bylineOpeners.has(item.id),
    untaggedHint: hintMessageIds.has(item.id),
    deliveryFailed: failedOutboxIds.has(item.id),
    sendState: outbox.states?.get(item.id),
    sendFailureIds: failureGroups.get(item.id),
    speakerWorking: Boolean(item.pubkey && speakerWorking[item.pubkey]),
    cornerProposalAnswer: answerByMessageId.get(item.relayId ?? item.id) ?? null,
    cornerProposalAction: cornerProposalAction?.messageId === item.id ? cornerProposalAction.decision : null,
    ...liveCardPresentation(item, {
      permissionActionId,
      grantActionId,
      choiceActionId,
      connectorOfferActionId,
      appSignInActionId,
      targetBranchActionId,
      targetBranchNotice,
      targetBranch: roomRepository?.targetBranch,
      canManageWorkspace,
      viewerIsAgent,
    }),
    ...messageRosterPresentation(
      item,
      {
        participantsHydrated,
        personByPubkey: personProfileByPubkey,
        agentByPubkey,
        agentModelByPubkey: agentProfileModelByPubkey,
        roleByPubkey: speakerRoleByPubkey,
        participants: roomParticipants,
      },
      item.replyToId ? visibleMessageById.get(item.replyToId) : undefined,
    ),
    ...archiveActionPresentation(item, {
      roomArchived: isArchived,
      cornerSwipeOffered: !isDirectMessage && !viewerIsAgent && !desktopExperience,
      cornerProposalOffered: !isCorner && !viewerIsAgent && !isReadOnlyDirectMessage,
    }),
    channelReferenceKey,
  }), [
    bylineOpeners,
    hintMessageIds,
    failedOutboxIds,
    outbox.states,
    failureGroups,
    speakerWorking,
    answerByMessageId,
    cornerProposalAction,
    permissionActionId,
    grantActionId,
    choiceActionId,
    connectorOfferActionId,
    appSignInActionId,
    targetBranchActionId,
    targetBranchNotice,
    roomRepository?.targetBranch,
    canManageWorkspace,
    viewerIsAgent,
    participantsHydrated,
    personProfileByPubkey,
    agentByPubkey,
    agentProfileModelByPubkey,
    speakerRoleByPubkey,
    roomParticipants,
    visibleMessageById,
    channelReferenceKey,
    isArchived,
    isDirectMessage,
    desktopExperience,
    isDesktop,
    isCorner,
    isReadOnlyDirectMessage,
  ]);

  const pendingMessageContext = useCallback((item: ChatDisplayMessage) => {
    const preceding = visibleMessages.at(-1);
    const pair = preceding ? [preceding, item] : [item];
    return {
      immediatelyPrecedingMessage: preceding,
      continued: continuedSpeakerIds(pair.map(message => ({
        id: message.id,
        speaker: ledgerSpeakerKey(message, knownAgentPubkeys),
        isMachine: message.isAgentActivity,
        hasReplyReference: Boolean(message.replyToId),
      }))).has(item.id),
    };
  }, [knownAgentPubkeys, visibleMessages]);

  const renderItem = useRoomMessageRenderItem({
    render: renderMessage,
    presentationForMessage,
    pendingContext: pendingMessageContext,
    continuedIds: continuedAttributionIds,
    precedingMessageById: immediatelyPrecedingVisibleMessageById,
    messageById: visibleMessageById,
    firstNewMessageId,
    arrivalFlashMessageId,
    sourceLandingFlashMessageId,
  });
  return [
    renderItem,
  ];
}
