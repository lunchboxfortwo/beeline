import { useCallback, useRef, type MutableRefObject, type Ref } from 'react';
import { Platform } from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useAnimatedStyle } from 'react-native-reanimated';
import { YStack } from 'tamagui';
import { composerBottomPadding } from '@/buzz/composer-keyboard';
import { T } from '@/ui/grammar';
import { KeyboardBody } from '@/ui/grammar-root';
import { router, type Href } from 'expo-router';
import { CORNER_TITLE, ROOM_TITLE } from '@/buzz/vocabulary';
import { type RoomSurfaceSessionBindings, type UseRoomSurfaceSessionResult } from './useRoomSurfaceSession';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { RoomActionsBackground } from '@/components/buzz/RoomRepositoryChoice';
import { RoomReviewerSurfaceNotice } from '@/components/buzz/RoomReviewerActions';
export { ChatOpeningSurface } from '@/components/buzz/ChatOpeningSurface';
import { useChatRoute, type NotificationAnchor } from './useChatRoute';
import { useChatScrollState } from './useChatScrollState';
import { useChatComposerRefs } from './useChatComposerRefs';
import { useChatRoomSession } from './useChatRoomSession';
import { useChatComposerDraft } from './useChatComposerDraft';
import { useChatActionState } from './useChatActionState';
import { useChatDesktopLayout } from './useChatDesktopLayout';
import { useChatRoomPresentation } from './useChatRoomPresentation';
import { useChatTranscriptHistory } from './useChatTranscriptHistory';
import { useChatRoster } from './useChatRoster';
import { useChatComposerSuggestions } from './useChatComposerSuggestions';
import { useChatComposerCommandController } from './useChatComposerCommandController';
import { useChatHeader } from './useChatHeader';
import { useChatTranscriptProjection } from './useChatTranscriptProjection';
import { useChatTranscriptWindow } from './useChatTranscriptWindow';
import { useChatDesktopScroll } from './useChatDesktopScroll';
import { useChatTranscriptLanding } from './useChatTranscriptLanding';
import { useChatTurnPresentation } from './useChatTurnPresentation';
import { useChatMessageActions } from './useChatMessageActions';
import { useChatComposerSend } from './useChatComposerSend';
import { useChatComposerAttachments } from './useChatComposerAttachments';
import { useChatCardActions } from './useChatCardActions';
import { useChatMembershipActions } from './useChatMembershipActions';
import { useChatCornerActions } from './useChatCornerActions';
import { useChatRepositories } from './useChatRepositories';
import { useChatNavigation } from './useChatNavigation';
import { useChatComposerCommands } from './useChatComposerCommands';
import { useChatTranscriptRenderer } from './useChatTranscriptRenderer';
import { ChatSurfaceErrorHeader, ChatSurfaceHeaderView as ChatSurfaceHeader } from './ChatSurfaceHeader';
import { useChatThreadHeader } from './useChatThreadHeader';
import { ThreadsDropdown, ThreadsDropdownScope } from '@/ui/screens/chat/ThreadsDropdown';
import { openPlace } from '@/ui/shell/panel';
import { ChatSurfaceTranscript } from './ChatSurfaceTranscript';
import { ChatSurfaceComposer } from './ChatSurfaceComposer';
import { ChatSurfaceWorkPane } from './ChatSurfaceWorkPane';
import { ChatSurfaceOverlays } from './ChatSurfaceOverlays';
import { ChatLinkProvider } from '@/components/buzz/ChatLinkProvider';
import { sharedChatLinkStore } from '@/buzz/chat-link-store';
import { openChatMessageLink } from '@/buzz/message-link';



export function BuzzChatSurface({
  anchor,
  session,
  bindingsRef,
}: {
  anchor: NotificationAnchor;
  session: UseRoomSurfaceSessionResult;
  bindingsRef: MutableRefObject<RoomSurfaceSessionBindings>;
}) {
  const [
    sendPreview, decodedId, navigation, desktopExperience, desktopAvailableWidth,
    routeParentChannelId, allowOlderHistoryRef, routeChannelTitle, routeCommunityId, messageAnchorId, notificationResponseId,
    notificationMessageId, notificationTarget, insets, cornerReturnTarget, isDesktop,
    readOnlyFooterInset,
  ] = useChatRoute(anchor);
  const [
    transcriptWindowIdRef, scrollController, handledNotificationAnchorRef, flatListRef, phoneRowKey,
    PhoneTranscriptCell, phoneScrollList,
  ] = useChatScrollState([
    sendPreview, () => desktopScrollNodeRef, () => desktopRowNodesRef, () => desktopTranscript,
    () => transcriptMessagesRef, () => transcriptHostIdsRef, () => messageJumpCanScrollTo,
    () => foldedMessages, () => revealTranscriptThrough, () => transcriptHistoryStatus,
    () => loadOlderTranscriptMessages, () => transcriptJump, () => endTranscriptJump,
    () => heldLandingFromOldestRef, () => phoneContentHeightRef, () => phoneScrollOffsetRef,
    () => heldLandingShortRef, () => phoneListHeightRef, () => raiseSourceLandingFlash,
    () => messageAnchorIdRef, () => raiseArrivalFlash, () => anchoredSegmentActive,
  ]);
  const [
    inputTextRef, composerRef, roomMessageProjector, selectedAgentMentionsRef, selectedMentionsRef,
    sendInFlightRef, composerInputRevisionRef,
  ] = useChatComposerRefs([

  ]);
  const [
    userPubkey, outbox, transport, roomSurface, roomClient, firstUnreadMessageId, isFocused,
    messageRecordScope, liveOverlays, heartbeatPresences, presenceNow, presenceReconnectGrace,
    setSessionTransport, advanceReadCursor, liveDraftStore, readRoom, setPresenceNow,
    applyRoomMessageResult, applyPendingAgentCommands, acknowledgeReadMark,
    applyRoomRepositoryResult, applyRoomName, clearRoomRepository, transcriptHydrationFailed,
    transcriptHydrationError, retryHydration, applyRoomReviewer, pushMuteWorking, togglePushMute,
    pushMuted,
  ] = useChatRoomSession([
    decodedId, () => setMembershipError, navigation, session,
  ]);
  const [
    inputText, setDesktopDeliveryState, updateInputText, setInputSelection, setDismissedMentionKey,
    desktopWorkPaneRef, setDesktopWorkPane, desktopWorkPaneContent, inputSelection,
    dismissedMentionKey, optimisticDeletes,
    optimisticReactions, dismissedSlashText, setHighlightedSlashVerbIndex, composerHeight,
    setReplyTarget, reactingRef, optimisticReactionsRef, setOptimisticReactions, showReportToast,
    setOptimisticDeletes, setMessageActionsTarget, setForwardTarget, setForwardRooms,
    setForwardError, forwardTarget, forwardBusyRoomId, setForwardBusyRoomId, composerDraft,
    replyTarget, pendingAttachmentsRef, setSending, attachmentUploader, activeComposerDraftRef,
    setComposerInputRevision, setComposerHeight, replacePendingAttachments, setCornerProposalAction,
    pendingAttachments, setAttachmentPickerVisible, setHighlightedMentionIndex, setRoomRepoListLoading, setRoomRepoError, setShowRoomRepoPicker,
    setRoomRepoNotice, roomRepoBusy, setRoomRepoBusy, roomRepoListLoading, roomRepoError,
    roomRepoNotice, showRoomRepoPicker, sending, setDismissedSlashText, highlightedSlashVerbIndex,
    failedOutboxIds, cornerProposalAction, turnChromeTopInset, setTurnChromeTopInset,
    highlightedMentionIndex, desktopDeliveryState, composerInputRevision, reportToast,
    attachmentPickerVisible, messageActionsTarget, forwardError, forwardRooms,
  ] = useChatComposerDraft([
    decodedId, userPubkey, desktopExperience, desktopAvailableWidth, outbox, transport,
  ]);
  const insertedStarterRef = useRef<string | null>(null);
  const setInputText = useCallback((update: string | ((previous: string) => string)) => {
    insertedStarterRef.current = null;
    updateInputText(update);
  }, [updateInputText]);
  const [
    setMembershipError, isDirectMessage, participantPickerVisible, roomRepoAccessIssue, setCornerOpenRepoPrompt, participantPickerKind, composerFocused,
    directMessage, setAgentConnectVisible, setParticipantPickerKind, setParticipantPickerVisible, targetBranchActionId,
    pendingAck, setPendingAck, receivedSteer, setReceivedSteer, setPermissionActionId,
    grantActionId, setGrantActionId, choiceActionId, setChoiceActionId, createPollBusy,
    setCreatePollBusy, setCreatePollVisible, connectorOfferActionId, setConnectorOfferActionId,
    setTargetBranchNotice, setTargetBranchActionId, setRoomActionsVisible, roomLifecycleBusy,
    setRoomLifecycleBusy, renameBusy, setRenameEditing, setRenameError, renameDraft, setRenameBusy,
    renameTextDraft, openingRandomCorner, setOpeningRandomCorner, setForwardCornerPrompt,
    forwardCornerPrompt, uncoveredOwnersRef, setOwnerGrant, setRoomRepoAccessIssue,
    permissionActionId, appSignInActionId, setAppSignInActionId, targetBranchNotice,
    conversationFrameRef, setCornerActionsVisible, setDmActionsVisible, cornerOpenRepoPrompt,
    ownerGrant, setComposerFocused, membershipError, roomActionsRef, renameEditing, setRenameDraft, renameError, dmActionsVisible,
    cornerActionsVisible, agentConnectVisible, createPollVisible,
  ] = useChatActionState([
    decodedId, userPubkey, roomSurface, inputTextRef, inputText, setDesktopDeliveryState,
    setInputText, setInputSelection, setDismissedMentionKey, composerRef,
  ]);
  const [
    chatListKey, isArchived, isCorner, activeCommunityId, surfaceParentId, parentChannelId,
    resolvedChannelName, commitDesktopWorkPane, desktopWorkRoomId, cacheViewerPubkey,
    workspaceRoster, channelKind, openWorkspaceRoster, roomRepoCandidates, githubScope,
    chatListRelayUrl, githubInstallations, desktopWorkPaneMounted, displayedDesktopWorkPaneContent,
  ] = useChatDesktopLayout([
    desktopWorkPaneRef, setDesktopWorkPane, desktopExperience, desktopAvailableWidth, decodedId,
    userPubkey, roomSurface, routeParentChannelId, isDirectMessage, desktopWorkPaneContent,
    roomClient, firstUnreadMessageId, allowOlderHistoryRef, routeChannelTitle, routeCommunityId,
    participantPickerVisible, setMembershipError,
  ]);
  const [
    revealTranscriptThrough, transcriptHistoryStatus, transcriptJump, endTranscriptJump,
    serverTailRows, serverHistoryRows, transcriptWindowId, historyAttached, resetTranscriptHistory,
    visibleMessageCount, cornerTask, loadOlderHistory, retryOlderHistory, jumpToTranscriptMessage,
    transcriptNewerStatus, retryNewerTranscriptMessages, workspaceChats, viewerPubkey,
    roomRepository, viewerIsAgent, canManageWorkspace, fillTranscript, transcriptFillStatus,
    transcriptPositions, loadNewerTranscriptMessages, loadLatestTranscriptMessages, voice,
    workspaceChatList, captureUntaggedSend, roomRepositoryResolved, canRenameTitle,
    openDesktopCorner, handleOpenChannelReference, handleOpenMention, channelReferenceIndex,
    handleOpenProfile, hintMessageIds, channelReferenceKey, communities,
  ] = useChatRoomPresentation([
    chatListKey, decodedId, roomSurface, userPubkey, isFocused, isDirectMessage, isArchived,
    isCorner, activeCommunityId, surfaceParentId, roomRepoAccessIssue, setCornerOpenRepoPrompt,
    parentChannelId, resolvedChannelName, routeChannelTitle, commitDesktopWorkPane,
    desktopExperience, desktopWorkRoomId, roomClient, cacheViewerPubkey, transport,
  ]);
  const [
    transcriptHostIdsRef, foldedMessages, loadOlderTranscriptMessages, anchoredSegmentActive,
    conversationIdentities, durableMessages, unprojectedMessages, combinedMessages, arrivalMessages,
    unreadLine, transcriptArrivalObservation, addMessages, removeOptimistic, reconcileOptimistic,
    openCurrentBrief, firstNewMessageId,
    cornerObjectiveText, openRoomWorkflowRun, roomWorkflowRun, roomOtherLiveRuns,
    transcriptHistoryLine, transcriptForwardLine, loadOlderTranscriptIfReaderAsked,
  ] = useChatTranscriptHistory([
    messageRecordScope, decodedId, serverTailRows, serverHistoryRows, cacheViewerPubkey,
    roomMessageProjector, roomSurface, liveOverlays, transcriptWindowIdRef, transcriptWindowId,
    historyAttached, bindingsRef, resetTranscriptHistory, outbox, userPubkey, isCorner,
    firstUnreadMessageId, visibleMessageCount, cornerTask, resolvedChannelName, loadOlderHistory,
    allowOlderHistoryRef, retryOlderHistory, transcriptJump, scrollController,
    jumpToTranscriptMessage, transcriptNewerStatus, retryNewerTranscriptMessages,
    transcriptHistoryStatus,
  ]);
  const [
    roomParticipants, agentPresences, describedRoomParticipants, participantsHydrated,
    personProfileByPubkey, agentByPubkey, roomAgents, agentProfileModelByPubkey, speakerRoleByPubkey, composerTagHandles,
    speechHints, roomParticipantTotal,
    ] = useChatRoster([
    roomSurface, conversationIdentities, durableMessages, resolvedChannelName, userPubkey,
    workspaceRoster, heartbeatPresences,
  ]);
  const [
    directMessageListItem, isReadOnlyDirectMessage, messages, activeAgentTurns,
    pendingCornerRequest, pendingTargetBranchProposal, agentTurnMarkers, activeAgentTurn, starPrompt,
    activeMention, activeChannel,
    mentionMenuVisible, mentionSuggestions, channelMenuVisible, channelSuggestions, suggestionCount,
    mentionMenuKey, channelMenuKey, memberManagement,
  ] = useChatComposerSuggestions([
    inputSelection, inputText,
    describedRoomParticipants, composerFocused, dismissedMentionKey, isDirectMessage,
    parentChannelId, decodedId, roomClient, workspaceChats, roomSurface, presenceReconnectGrace,
    unprojectedMessages, participantsHydrated, participantPickerVisible,
    combinedMessages, roomRepository,
  ]);
  const commandController = useChatComposerCommandController({
    roomParticipants, inputText, decodedId, viewerPubkey, roomClient, activeCommunityId,
    transport, setSessionTransport, inputTextRef, setInputText, setInputSelection, setComposerHeight,
    isCorner, isDirectMessage, viewerIsAgent, roomSurface, canManageWorkspace, pendingCornerRequest,
    pendingTargetBranchProposal, targetBranchActionId, composerFocused, dismissedSlashText,
    setHighlightedSlashVerbIndex,
  });
  const [
    emptyLedgerVariant, displayRoomName, roomName, firstRoomAgent, startCornerMessage,
    focusComposer, starterPrompts, starterIntro, storedRoomName, headerTitleKind,
    displayHeaderTitle, dmPeerPubkey, dmPeerIdentity, dmPeerAgentDisplay, dmPeerProfile,
    dmHeaderPresence, headerTitle, closeAgentConnect, connectAgent, dmPeerMark,
  ] = useChatHeader([
    parentChannelId, roomSurface, resolvedChannelName, isCorner, channelKind, decodedId,
    isDirectMessage, userPubkey, directMessage, personProfileByPubkey, directMessageListItem,
    agentByPubkey, presenceNow, workspaceRoster, isReadOnlyDirectMessage, composerRef, inputTextRef,
    selectedAgentMentionsRef, selectedMentionsRef, setInputText, setInputSelection,
    activeCommunityId, viewerIsAgent, setAgentConnectVisible, canManageWorkspace,
    setMembershipError, setParticipantPickerKind, openWorkspaceRoster, setParticipantPickerVisible,
  ], insertedStarterRef);
  const [
    desktopTranscript, transcriptMessagesRef, transcriptMessages, visibleMessages,
    cornerAgentPubkey, dismissComposerKeyboard, speakerWorking, continuedAttributionIds,
    cornerOwnerDisplay, cornerHeaderSource, emptyLedger,
  ] = useChatTranscriptProjection([
    isCorner, parentChannelId, decodedId, isArchived, roomClient, messages, agentByPubkey,
    roomSurface, activeAgentTurns, participantsHydrated, optimisticDeletes, optimisticReactions,
    desktopExperience, viewerIsAgent, emptyLedgerVariant, isDirectMessage, displayRoomName,
    roomName, firstRoomAgent, startCornerMessage, focusComposer, starterPrompts, starterIntro,
  ]);
  const threadHeader = useChatThreadHeader({
    sourceMessageId:notificationMessageId??notificationTarget,
    isCorner, roomSurface, resolvedChannelName, decodedId, parentChannelId,
    state: cornerHeaderSource?.state,
    objective: cornerObjectiveText, isArchived, isDesktop, positions: transcriptPositions,
  });
  const [
    desktopScrollNodeRef, heldLandingFromOldestRef, phoneContentHeightRef, phoneScrollOffsetRef,
    heldLandingShortRef, phoneListHeightRef, observeVisibleMessages, chronologicalMessagesRef,
    newMessageHasObservedVisibility, newestTranscriptMessageId, desktopContentObserverRef,
    desktopContentNodeRef, observeTailPinned, applyComposerPrefill, composerPrefillRef,
    phoneUnderfill, detachedFillMeasuredRef, holdPhoneLanding, newMessageBadgeCount,
    newestJumpDiscShown,
  ] = useChatTranscriptWindow([
    anchoredSegmentActive, scrollController, fillTranscript, foldedMessages, desktopTranscript,
    transcriptMessages, roomClient, cacheViewerPubkey, transcriptFillStatus, visibleMessageCount,
    visibleMessages, viewerIsAgent, userPubkey, agentByPubkey, isDirectMessage, decodedId,
    roomSurface, selectedAgentMentionsRef, selectedMentionsRef, inputTextRef, setInputText,
    setInputSelection, arrivalMessages, unreadLine, transcriptArrivalObservation, isCorner,
  ]);
  const [
    desktopRowNodesRef, messageJumpCanScrollTo, raiseSourceLandingFlash, messageAnchorIdRef,
    raiseArrivalFlash, restoreDesktopReadingAnchor, handleOpenCode, handleOpenMessageSource,
    arrivalFlashMessageId, sourceLandingFlashMessageId, setDesktopScrollNode, handleDesktopScroll,
    setDesktopContentNode, getDesktopRowRefCallback, observeVisibleTranscriptMessages,
  ] = useChatDesktopScroll([
    desktopScrollNodeRef, scrollController, messageAnchorId, decodedId, desktopTranscript,
    transcriptJump, transcriptPositions, observeVisibleMessages, advanceReadCursor,
    chronologicalMessagesRef, anchoredSegmentActive, isFocused, newMessageHasObservedVisibility,
    newestTranscriptMessageId, visibleMessages, transcriptMessagesRef, transcriptMessages,
    combinedMessages, revealTranscriptThrough, desktopContentObserverRef, desktopContentNodeRef,
    observeTailPinned, loadNewerTranscriptMessages, loadOlderTranscriptMessages,
  ]);
  const [
    landAtOwnSend, observePhoneTailOffset, landAtNewestMessage,
  ] = useChatTranscriptLanding([
    scrollController, observeTailPinned, desktopTranscript, restoreDesktopReadingAnchor,
    transcriptMessages, transcriptJump, isCorner, firstUnreadMessageId, messageAnchorId, decodedId,
    loadLatestTranscriptMessages, liveDraftStore, voice, foldedMessages, notificationResponseId,
    notificationMessageId, notificationTarget, handledNotificationAnchorRef, transcriptHostIdsRef,
    messageJumpCanScrollTo, roomClient, cacheViewerPubkey, roomSurface, jumpToTranscriptMessage,
    anchoredSegmentActive, transcriptNewerStatus, desktopScrollNodeRef, loadNewerTranscriptMessages,
  ]);
  const [
    bylineOpeners, answerByMessageId, visibleMessageById, immediatelyPrecedingVisibleMessageById,
    composerAck, settledTurn, stoppingThisTurn, handleStopTurn, ,
    keyboardHeight,
  ] = useChatTurnPresentation([
    visibleMessages, pendingAck, agentTurnMarkers, setPendingAck, receivedSteer, activeAgentTurn,
    setReceivedSteer, isCorner, roomSurface, viewerPubkey, conversationIdentities, agentByPubkey,
    insets, composerHeight, scrollController, decodedId, readRoom, desktopExperience,
    setDesktopDeliveryState, agentPresences, setPresenceNow, presenceNow, combinedMessages,
  ]);
  // The composer's foot follows the keyboard on the UI thread: the same inset
  // as the turn presentation's padding, drawn as the height under the row.
  const { progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const composerBottomInset = useAnimatedStyle(
    () => ({ height: composerBottomPadding(Platform.OS, insets.bottom, keyboardProgress.value) }),
    [insets.bottom],
  );
  const [
    replyTargetForMessage, beginForward, beginReply, openMessageActions, handleReactToMessage,
    handleReportMessage, dismissOutboxMessage,
    canDeleteMessage, handleDeleteMessage, forwardToRoom,
  ] = useChatMessageActions([
    agentByPubkey, personProfileByPubkey, chronologicalMessagesRef, decodedId, setReplyTarget,
    applyComposerPrefill, inputTextRef, composerPrefillRef, setDismissedMentionKey,
    scrollController, composerRef, reactingRef, optimisticReactionsRef, setOptimisticReactions,
    applyRoomMessageResult, starPrompt, messageRecordScope, showReportToast, canManageWorkspace,
    setOptimisticDeletes, setMessageActionsTarget, workspaceChatList, roomClient, activeCommunityId,
    setForwardTarget, setForwardRooms, setForwardError, chatListKey, forwardTarget,
    forwardBusyRoomId, setForwardBusyRoomId, transport, displayRoomName, outbox,
  ]);
  const [
    handleSend, handleCornerProposalDecision,
  ] = useChatComposerSend([
    composerDraft, inputTextRef, replyTarget, pendingAttachmentsRef, sendInFlightRef, isArchived,
    roomParticipants, selectedMentionsRef, captureUntaggedSend, selectedAgentMentionsRef,
    roomAgents, isCorner, outbox, desktopTranscript, setReceivedSteer, setPendingAck, setSending,
    desktopExperience, setDesktopDeliveryState, roomSurface, userPubkey, sendPreview,
    scrollController, landAtOwnSend, addMessages, isDirectMessage, roomRepository,
    roomRepositoryResolved, roomRepoAccessIssue, setCornerOpenRepoPrompt, activeCommunityId,
    roomRepoCandidates, transport, githubScope, setSessionTransport, removeOptimistic,
    attachmentUploader, decodedId, reconcileOptimistic, activeComposerDraftRef,
    composerInputRevisionRef, composerRef, setComposerInputRevision, setComposerHeight,
    setInputSelection, replacePendingAttachments, setReplyTarget, applyRoomMessageResult,
    applyPendingAgentCommands, activeAgentTurn, acknowledgeReadMark, isFocused, parentChannelId,
    cacheViewerPubkey, cornerAgentPubkey, agentPresences, presenceNow, presenceReconnectGrace,
    agentByPubkey, replyTargetForMessage, setCornerProposalAction,
  ]);
  const [
    selectMention, selectChannel, chooseAttachment, pickDocument, pickPhoto, pasteImage,
  ] = useChatComposerAttachments([
    pendingAttachments, replacePendingAttachments, setAttachmentPickerVisible, activeMention,
    inputTextRef, selectedAgentMentionsRef, selectedMentionsRef, setInputText, setInputSelection,
    setDismissedMentionKey, setHighlightedMentionIndex, composerRef, activeChannel,
  ]);
  const [
    handleWritePermission, handleConfirmTargetBranch, handleGrantDecision, handleChoiceAnswer,
    handleAcceptConnectorOffer, continueConnectorOffer, openWorkbench,
    handleCreatePoll,
  ] = useChatCardActions([
    transport, viewerIsAgent, cacheViewerPubkey, setPermissionActionId, decodedId, grantActionId,
    setGrantActionId, choiceActionId, setChoiceActionId, roomSurface, focusComposer, readRoom,
    createPollBusy, setCreatePollBusy, setCreatePollVisible, activeCommunityId,
    connectorOfferActionId, setConnectorOfferActionId, targetBranchActionId, canManageWorkspace,
    setTargetBranchNotice, setTargetBranchActionId, applyRoomRepositoryResult,
  ]);
  const [
    closeRoomActions, handleConnectAgent, handleRenameRoom,
    handleRoomLifecycle, ] = useChatMembershipActions([
    transport, activeCommunityId, canManageWorkspace, setMembershipError, decodedId, setParticipantPickerVisible,
    setRoomActionsVisible, roomLifecycleBusy,
    setRoomLifecycleBusy, displayRoomName, roomSurface, readRoom, renameBusy, setRenameEditing,
    setRenameError, renameDraft, isCorner, canRenameTitle, setRenameBusy, renameTextDraft,
    applyRoomName, chatListKey,
  ]);
  const [
    startRenameFromTitle, handleForwardToNewCorner, handleOpenRandomCorner,
    confirmForwardToNewCorner,
  ] = useChatCornerActions([
    canRenameTitle, renameTextDraft, storedRoomName, setRenameError, setRenameEditing, isCorner,
    setRoomActionsVisible, openingRandomCorner, isArchived, viewerIsAgent, transport,
    setOpeningRandomCorner, parentChannelId, decodedId, desktopExperience, openDesktopCorner,
    setForwardCornerPrompt, forwardCornerPrompt, displayRoomName,
  ]);
  const [
    handleReconnectRoomRepository, handleAddGitHubAccount, handleAskOwnerGrant,
    handleCreateGitHubRepository, handleManageGitHubInstallation, handleSelectRoomRepoCandidate,
    roomRepoOptions,
  ] = useChatRepositories([
    transport, activeCommunityId, githubScope, setRoomRepoListLoading, setRoomRepoError,
    chatListRelayUrl, userPubkey, setShowRoomRepoPicker, decodedId, setRoomRepoNotice, roomRepoBusy,
    setRoomRepoBusy, uncoveredOwnersRef, setOwnerGrant, applyRoomRepositoryResult,
    setCornerOpenRepoPrompt, parentChannelId, roomRepository, clearRoomRepository,
    canManageWorkspace, roomSurface, roomRepoCandidates, githubInstallations, roomRepoListLoading,
    roomRepoError, roomRepoNotice, showRoomRepoPicker, closeRoomActions, roomRepoAccessIssue,
    setRoomRepoAccessIssue,
  ]);
  const [
    handleCloseCorner, openCorner, handleBack, handleCommunitySelect, handleDesktopDrop,
    handleDesktopPaste, closeDesktopWorkPane,
  ] = useChatNavigation([
    liveDraftStore, navigation, parentChannelId, cornerReturnTarget, transport, decodedId, readRoom,
    desktopExperience, openDesktopCorner, commitDesktopWorkPane, focusComposer,
    desktopWorkPaneMounted, sending, pendingAttachments,
    replacePendingAttachments,
  ]);
  const [
    rowActions, handleOpenGitHubEvent, handleOpenSystemIdentity, handleCopyLedgerMessage,
    dismissSlashMenu, runSlashVerb, selectHighlightedPaletteItem,
    handleSelectLedgerMessage,
  ] = useChatComposerCommands([
    inputTextRef, setInputText, setInputSelection, setComposerHeight, setDismissedSlashText,
    setHighlightedSlashVerbIndex, composerRef, inputText, commandController, activeCommunityId,
    transport, decodedId, setCreatePollVisible, canManageWorkspace,
    pendingCornerRequest, handleWritePermission, startRenameFromTitle, handleCloseCorner,
    pendingTargetBranchProposal, handleConfirmTargetBranch, handleConnectAgent, setMembershipError,
    setParticipantPickerKind, openWorkspaceRoster, setParticipantPickerVisible,
    highlightedSlashVerbIndex, handleSend, beginForward,
    handleForwardToNewCorner, handleOpenChannelReference, handleOpenMention, cacheViewerPubkey,
  ]);
  const [
    renderItem,
  ] = useChatTranscriptRenderer([
    viewerIsAgent, canManageWorkspace, permissionActionId, grantActionId, choiceActionId,
    connectorOfferActionId, appSignInActionId, targetBranchActionId, roomRepository,
    participantsHydrated, personProfileByPubkey, agentProfileModelByPubkey, agentByPubkey,
    roomParticipants, decodedId, cacheViewerPubkey, roomName, rowActions, openCorner,
    handleGrantDecision, desktopExperience, handleChoiceAnswer,
    setAppSignInActionId, activeCommunityId, handleAcceptConnectorOffer, setConnectorOfferActionId,
    continueConnectorOffer, openWorkbench, isCorner, handleOpenGitHubEvent, targetBranchNotice,
    setTargetBranchActionId, handleOpenSystemIdentity, openCurrentBrief, replyTargetForMessage,
    isReadOnlyDirectMessage, channelReferenceIndex, handleOpenCode, handleOpenMessageSource,
    handleOpenProfile, dismissComposerKeyboard, beginReply, handleCopyLedgerMessage,
    openMessageActions, handleReactToMessage, handleReportMessage,
    isDirectMessage, isArchived, handleCornerProposalDecision, dismissOutboxMessage, isDesktop,
    bylineOpeners, hintMessageIds, failedOutboxIds, outbox, speakerWorking, answerByMessageId,
    cornerProposalAction, speakerRoleByPubkey, visibleMessageById, channelReferenceKey,
    visibleMessages, continuedAttributionIds, immediatelyPrecedingVisibleMessageById,
    firstNewMessageId, arrivalFlashMessageId,
    sourceLandingFlashMessageId,
  ]);

  const openChatInfo = useCallback(() => openPlace({ kind: 'chat-info', roomId: decodedId }, isDesktop), [decodedId, isDesktop]);
  const openMembers = useCallback(() => openPlace({ kind: 'members', roomId: decodedId }, isDesktop), [decodedId, isDesktop]);
  const openDmActions = useCallback(() => {
    setMembershipError(null);
    setDmActionsVisible(true);
  }, [setMembershipError, setDmActionsVisible]);
  const openCornerActions = useCallback(() => setCornerActionsVisible(true), [setCornerActionsVisible]);
  const openLinkedThread = (link: { roomId: string; parentRoomId: string }) =>
    void handleOpenChannelReference({ kind: 'corner', channelId: link.roomId, parentChannelId: link.parentRoomId });
  const openLinkedMessage = (link: { roomId: string; messageId: string; workspaceId: string }) =>
    openChatMessageLink(link, (href) => router.navigate(href as Href));

  if (!roomSurface && transcriptHydrationFailed) {
    return (
      <ChatSurfaceErrorHeader
        title={displayHeaderTitle ?? routeChannelTitle ?? ROOM_TITLE}
        showBack
        handleBack={handleBack}
        error={transcriptHydrationError}
      />
    );
  }

  return (
    <ThreadsDropdownScope>
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={activeCommunityId}
      onSelect={handleCommunitySelect}
      onAdd={() => router.push('/beeline/community' as Href)}
    >
      <ConversationFrame flex={1} minWidth={0} flexDirection="row" position="relative" ref={conversationFrameRef as unknown as Ref<never>}>
        <YStack flex={1} backgroundColor="canvas">
          {/* Header. No surface of its own — the chrome sits on the same
            obsidian as the transcript, parted only by a hairline. */}
          <ChatSurfaceHeader
  isCorner={isCorner}
  isDirectMessage={isDirectMessage}
  desktop={isDesktop}
  showBack={!isDesktop || isCorner}
  handleBack={handleBack}
  title={displayHeaderTitle}
  memberCount={roomParticipantTotal}
  repositoryHomepageIcon={roomSurface?.room.homepageIcon}
  openChatInfo={openChatInfo}
  openMembers={openMembers}
  dmPeer={dmPeerMark}
  dmHeaderPresence={dmHeaderPresence}
  openDmActions={!viewerIsAgent && !isArchived ? openDmActions : undefined}
  thread={threadHeader.thread}
  threadCollapsed={!roomSurface || threadHeader.collapsed}
  openParentChat={threadHeader.openParentChat}
  threadExpanded={threadHeader.expandedBlock}
  expandThread={threadHeader.expand}
  openCornerActions={!viewerIsAgent && !isArchived ? openCornerActions : undefined}
  threadBarRef={threadHeader.barRef}
  onThreadBarLayout={threadHeader.onBarLayout}
/>

          {!isCorner && !isDirectMessage && (
            <YStack paddingTop={isDesktop ? '2' : '0'}>
              <ThreadsDropdown roomId={decodedId} chatName={resolvedChannelName} viewer={viewerPubkey ?? undefined} openThread={openCorner}
                onNewThread={() => void handleOpenRandomCorner()}
                newThreadDisabled={viewerIsAgent || isArchived} />
            </YStack>
          )}

          <RoomReviewerSurfaceNotice
            allowAutoMerge={roomRepository?.allowAutoMerge}
            canManage={canManageWorkspace}
            isCorner={isCorner}
            reviewerAgentId={roomSurface?.room.reviewerAgentId}
          />

          <ChatLinkProvider
            roomId={decodedId}
            store={sharedChatLinkStore()}
            onOpenThread={openLinkedThread}
            onOpenMessage={openLinkedMessage}
          >
          <KeyboardBody>
            {/* A corner's title, status, PR, objective and brief are the
            transcript's first block (header B, `useChatThreadHeader`). */}
            {roomSurface ? <ChatSurfaceTranscript
  desktopTranscript={desktopTranscript}
  setDesktopScrollNode={setDesktopScrollNode}
  handleDesktopScroll={handleDesktopScroll}
  scrollController={scrollController}
  setDesktopContentNode={setDesktopContentNode}
  transcriptMessages={transcriptMessages}
  emptyLedger={emptyLedger}
  transcriptHistoryLine={transcriptHistoryLine}
  getDesktopRowRefCallback={getDesktopRowRefCallback}
  renderItem={renderItem}
  transcriptForwardLine={transcriptForwardLine}
  sendPreview={sendPreview}
  flatListRef={flatListRef}
  phoneRowKey={phoneRowKey}
  PhoneTranscriptCell={PhoneTranscriptCell}
  isArchived={isArchived}
  composerAck={composerAck}
  settledTurn={settledTurn}
  anchoredSegmentActive={anchoredSegmentActive}
  phoneScrollOffsetRef={phoneScrollOffsetRef}
  observePhoneTailOffset={observePhoneTailOffset}
  transcriptPositions={transcriptPositions}
  loadNewerTranscriptMessages={loadNewerTranscriptMessages}
  observeVisibleTranscriptMessages={observeVisibleTranscriptMessages}
  allowOlderHistoryRef={allowOlderHistoryRef}
  phoneListHeightRef={phoneListHeightRef}
  phoneUnderfill={phoneUnderfill}
  detachedFillMeasuredRef={detachedFillMeasuredRef}
  holdPhoneLanding={holdPhoneLanding}
  phoneScrollList={phoneScrollList}
  loadOlderTranscriptIfReaderAsked={loadOlderTranscriptIfReaderAsked}
  starPrompt={starPrompt}
  loadOlderTranscriptMessages={loadOlderTranscriptMessages}
  desktopExperience={desktopExperience}
  turnChromeTopInset={turnChromeTopInset}
  isCorner={isCorner}
  newMessageBadgeCount={newMessageBadgeCount}
  newestJumpDiscShown={newestJumpDiscShown}
  landAtNewestMessage={landAtNewestMessage}
  leadBlock={threadHeader.titleBlock}
/> : <YStack flex={1} testID="room-transcript-pending" />}

            {/* P2: Archived channels are read-only */}
            {isArchived ? (
              <>
                <YStack
                  paddingHorizontal="4"
                  paddingTop="4"
                  paddingBottom={readOnlyFooterInset.paddingBottom === undefined ? '2' : 0}
                  borderTopWidth={1}
                  borderTopColor="stroke"
                  backgroundColor="canvas"
                  alignItems="center"
                >
                  <T v={isCorner ? 'code' : 'meta'} color="secondary">
                    {parentChannelId ? CORNER_TITLE : ROOM_TITLE} archived (read-only)
                  </T>
                  {readOnlyFooterInset.paddingBottom === undefined ? null : <YStack height={readOnlyFooterInset.paddingBottom} />}
                </YStack>
                {readOnlyFooterInset.marginBottom === undefined ? null : <YStack height={readOnlyFooterInset.marginBottom} />}
              </>
            ) : (
              <ChatSurfaceComposer
  desktopExperience={desktopExperience}
  setTurnChromeTopInset={setTurnChromeTopInset}
  composerAck={composerAck}
  stoppingThisTurn={stoppingThisTurn}
  handleStopTurn={handleStopTurn}
  settledTurn={settledTurn}
  transcriptHydrationFailed={transcriptHydrationFailed}
  transcriptHydrationError={transcriptHydrationError}
  retryHydration={retryHydration}
  isReadOnlyDirectMessage={isReadOnlyDirectMessage}
  readOnlyFooterInset={readOnlyFooterInset}
  composerBottomInset={composerBottomInset}
  commandController={commandController}
  agentByPubkey={agentByPubkey}
  highlightedSlashVerbIndex={highlightedSlashVerbIndex}
  dismissSlashMenu={dismissSlashMenu}
  runSlashVerb={runSlashVerb}
  mentionMenuVisible={mentionMenuVisible}
  highlightedMentionIndex={highlightedMentionIndex}
  keyboardHeight={keyboardHeight}
  mentionSuggestions={mentionSuggestions}
  selectMention={selectMention}
  personProfileByPubkey={personProfileByPubkey}
  channelMenuVisible={channelMenuVisible}
  channelSuggestions={channelSuggestions}
  selectChannel={selectChannel}
  activeChannel={activeChannel}
  cornerOpenRepoPrompt={cornerOpenRepoPrompt}
  roomRepoAccessIssue={roomRepoAccessIssue}
  handleReconnectRoomRepository={handleReconnectRoomRepository}
  setCornerOpenRepoPrompt={setCornerOpenRepoPrompt}
  canManageWorkspace={canManageWorkspace}
  decodedId={decodedId}
  roomRepoBusy={roomRepoBusy}
  roomRepoCandidates={roomRepoCandidates}
  githubInstallations={githubInstallations}
  roomRepoError={roomRepoError}
  roomRepoNotice={roomRepoNotice}
  ownerGrant={ownerGrant}
  handleAddGitHubAccount={handleAddGitHubAccount}
  handleAskOwnerGrant={handleAskOwnerGrant}
  handleCreateGitHubRepository={handleCreateGitHubRepository}
  handleManageGitHubInstallation={handleManageGitHubInstallation}
  handleSelectRoomRepoCandidate={handleSelectRoomRepoCandidate}
  desktopDeliveryState={desktopDeliveryState}
  isDirectMessage={isDirectMessage}
  roomSurface={roomSurface}
  isCorner={isCorner}
  voice={voice}
  composerRef={composerRef}
  replyTarget={replyTarget}
  setReplyTarget={setReplyTarget}
  composerTagHandles={composerTagHandles}
  insertedStarterRef={insertedStarterRef}
  pendingAttachments={pendingAttachments}
  pendingAttachmentsRef={pendingAttachmentsRef}
  attachmentUploader={attachmentUploader}
  sending={sending}
  replacePendingAttachments={replacePendingAttachments}
  transport={transport}
  speechHints={speechHints}
  inputText={inputText}
  composerInputRevision={composerInputRevision}
  composerInputRevisionRef={composerInputRevisionRef}
  composerHeight={composerHeight}
  composerFocused={composerFocused}
  chooseAttachment={chooseAttachment}
  handleDesktopDrop={handleDesktopDrop}
  handleDesktopPaste={handleDesktopPaste}
  inputTextRef={inputTextRef}
  setInputText={setInputText}
  setComposerHeight={setComposerHeight}
  setComposerFocused={setComposerFocused}
  selectHighlightedPaletteItem={selectHighlightedPaletteItem}
  setHighlightedSlashVerbIndex={setHighlightedSlashVerbIndex}
  suggestionCount={suggestionCount}
  handleSend={handleSend}
  setHighlightedMentionIndex={setHighlightedMentionIndex}
  setDismissedMentionKey={setDismissedMentionKey}
  mentionMenuKey={mentionMenuKey}
  channelMenuKey={channelMenuKey}
  setInputSelection={setInputSelection}
/>
            )}
          </KeyboardBody>
          </ChatLinkProvider>
          {reportToast}
        </YStack>
<ChatSurfaceWorkPane
  desktopWorkPaneMounted={desktopWorkPaneMounted}
  displayedDesktopWorkPaneContent={displayedDesktopWorkPaneContent}
  closeDesktopWorkPane={closeDesktopWorkPane}
/>
      </ConversationFrame>

<ChatSurfaceOverlays
  attachmentPickerVisible={attachmentPickerVisible}
  setAttachmentPickerVisible={setAttachmentPickerVisible}
  pickDocument={pickDocument}
  pickPhoto={pickPhoto}
  desktopExperience={desktopExperience}
  pasteImage={pasteImage}
  setMessageActionsTarget={setMessageActionsTarget}
  messageActionsTarget={messageActionsTarget}
  outbox={outbox}
  handleReactToMessage={handleReactToMessage}
  handleReportMessage={handleReportMessage}
  handleCopyLedgerMessage={handleCopyLedgerMessage}
  showCopyToast={showReportToast}
  handleSelectLedgerMessage={handleSelectLedgerMessage}
  decodedId={decodedId}
  beginReply={beginReply}
  beginForward={beginForward}
  canDeleteMessage={canDeleteMessage}
  handleDeleteMessage={handleDeleteMessage}
  setForwardCornerPrompt={setForwardCornerPrompt}
  confirmForwardToNewCorner={confirmForwardToNewCorner}
  forwardCornerPrompt={forwardCornerPrompt}
  forwardBusyRoomId={forwardBusyRoomId}
  forwardError={forwardError}
  setForwardTarget={setForwardTarget}
  setForwardRooms={setForwardRooms}
  setForwardError={setForwardError}
  forwardToRoom={forwardToRoom}
  forwardRooms={forwardRooms}
  forwardTarget={forwardTarget}
  roomSurface={roomSurface}
  isDirectMessage={isDirectMessage}
  membershipError={membershipError}
  setParticipantPickerVisible={setParticipantPickerVisible}
  memberManagement={memberManagement}
  renameBusy={renameBusy}
  closeRoomActions={closeRoomActions}
  canRenameTitle={canRenameTitle}
  startRenameFromTitle={startRenameFromTitle}
  displayRoomName={displayRoomName}
  roomActionsRef={roomActionsRef}
  roomRepoOptions={roomRepoOptions}
  conversationFrameRef={conversationFrameRef}
  isCorner={isCorner}
  renameEditing={renameEditing}
  setRenameDraft={setRenameDraft}
  setRenameError={setRenameError}
  handleRenameRoom={handleRenameRoom}
  renameDraft={renameDraft}
  setRenameEditing={setRenameEditing}
  roomRepository={roomRepository}
  canManageWorkspace={canManageWorkspace}
  applyRoomReviewer={applyRoomReviewer}
  pushMuteWorking={pushMuteWorking}
  togglePushMute={togglePushMute}
  pushMuted={pushMuted}
  roomParticipantTotal={roomParticipantTotal}
  participantsHydrated={participantsHydrated}
  setRoomActionsVisible={setRoomActionsVisible}
  activeCommunityId={activeCommunityId}
  roomLifecycleBusy={roomLifecycleBusy}
  handleRoomLifecycle={handleRoomLifecycle}
  renameError={renameError}
  setDmActionsVisible={setDmActionsVisible}
  dmActionsVisible={dmActionsVisible}
  viewerIsAgent={viewerIsAgent}
  headerTitle={headerTitle}
  cornerOwnerDisplay={cornerOwnerDisplay}
  cornerActionsVisible={cornerActionsVisible}
  transport={transport}
  setCornerActionsVisible={setCornerActionsVisible}
  handleBack={handleBack}
  readRoom={readRoom}
  participantPickerKind={participantPickerKind}
  agentConnectVisible={agentConnectVisible}
  closeAgentConnect={closeAgentConnect}
  createPollVisible={createPollVisible}
  createPollBusy={createPollBusy}
  setCreatePollVisible={setCreatePollVisible}
  handleCreatePoll={handleCreatePoll}
/>
    </BuzzCommunityShell>
    </ThreadsDropdownScope>
  );
}

/** The frosted-behind frame of the conversation and its desktop work pane, laid out across. */
const ConversationFrame = RoomActionsBackground;
