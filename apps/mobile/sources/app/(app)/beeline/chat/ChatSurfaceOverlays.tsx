import { appErrorCopy } from '@/buzz/app-error-copy';
import { ErrorBanner } from '@/components/buzz/ErrorBanner';
import { CornerActionsSheet } from '@/components/buzz/CornerActionsSheet';
import { HullDialogActions } from '@/components/buzz/HullDialog';
import React from 'react';
import type { View } from 'react-native';
import { YStack } from 'tamagui';
import * as Haptics from 'expo-haptics';
import { router, type Href } from 'expo-router';
import { Modal } from '@/modal';
import { BuzzRigTransport } from '@/sync/transport';
import { type RoomRepository, type MessageReactionEmoji } from '@beeline/buzz-client';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { CORNER_LABEL, CORNER_TITLE, ROOM_LABEL } from '@/buzz/vocabulary';
import { ROOM_SLUG_HINT, roomNameEntry, validRoomSlug } from '@/buzz/room-name';
import { formatRoomParticipantTotal } from '@/buzz/room-participants';
import { agentActivityReplyExcerpt, canBeginReply } from '@/buzz/message-reply';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { type ForwardTarget } from '@/buzz/message-forward';
import { AttachmentPickerSheet } from '@/components/buzz/AttachmentPickerSheet';
import { ForwardMessagePickerSheet } from '@/components/buzz/ForwardMessagePickerSheet';
import { ForwardCornerSheet } from '@/components/buzz/ForwardCornerSheet';
import { MessageReactionStrip } from '@/components/buzz/MessageReactionStrip';
import { HullActionSheetCancel, HullActionSheetModal, HullActionSheetRow } from '@/components/buzz/HullActionSheet';
import { RoomActionsSheet, type RoomActionsSheetHandle, type RoomRepositoryOptions } from '@/components/buzz/RoomRepositoryChoice';
import { RoomReviewerActions } from '@/components/buzz/RoomReviewerActions';
import { HullDialog, HullDialogInput } from '@/components/buzz/HullDialog';
import { type CornerOpenAttempt } from '@/buzz/open-random-corner';
import { ChatAddSheet, WorkspaceAddAgentSheet } from '@/ui/screens/members/ChatAddSheets';
import { openPlace } from '@/ui/shell/panel';
import { useIsDesktop } from '@/utils/responsive';
import { CreatePollSheet, type PollDraft } from '@/components/buzz/CreatePollSheet';
import { T } from '@/ui/grammar';
import * as Clipboard from 'expo-clipboard';
import { chatMessageLinkToken, copyChatMessageLink } from '@/buzz/message-link';

type Props = {
  attachmentPickerVisible: boolean;
  setAttachmentPickerVisible: React.Dispatch<React.SetStateAction<boolean>>;
  pickDocument: () => Promise<void>;
  pickPhoto: () => Promise<void>;
  desktopExperience: boolean;
  pasteImage: () => Promise<void>;
  setMessageActionsTarget: React.Dispatch<React.SetStateAction<ChatDisplayMessage | null>>;
  messageActionsTarget: ChatDisplayMessage | null;
  outbox: import('./useRoomSurfaceSession').RoomSurfaceOutboxHandle;
  handleReactToMessage: (message: ChatDisplayMessage, emoji: MessageReactionEmoji) => Promise<void>;
  messageIsBookmarked: (message: ChatDisplayMessage) => boolean;
  handleBookmarkMessage: (message: ChatDisplayMessage) => Promise<void>;
  handleReportMessage: (message: ChatDisplayMessage) => Promise<void>;
  handleCopyLedgerMessage: (text: string) => void;
  /** Confirms a copy in the transcript's toast. */
  showCopyToast: (message: string) => void;
  handleSelectLedgerMessage: (text: string) => void;
  decodedId: string;
  beginReply: (message: ChatDisplayMessage) => void;
  beginForward: (message: ChatDisplayMessage) => Promise<void>;
  canDeleteMessage: (message: ChatDisplayMessage) => boolean;
  handleDeleteMessage: (message: ChatDisplayMessage) => Promise<void>;
  setForwardCornerPrompt: React.Dispatch<React.SetStateAction<ChatDisplayMessage | null>>;
  confirmForwardToNewCorner: (retry?: { target: ChatDisplayMessage; attempt: CornerOpenAttempt; }) => Promise<void>;
  forwardCornerPrompt: ChatDisplayMessage | null;
  forwardBusyRoomId: string | null;
  forwardError: string | null;
  setForwardTarget: React.Dispatch<React.SetStateAction<ChatDisplayMessage | null>>;
  setForwardRooms: React.Dispatch<React.SetStateAction<readonly ForwardTarget[] | null>>;
  setForwardError: React.Dispatch<React.SetStateAction<string | null>>;
  forwardToRoom: (target: ForwardTarget) => Promise<boolean>;
  forwardRooms: readonly ForwardTarget[] | null;
  forwardTarget: ChatDisplayMessage | null;
  roomSurface: import("@beeline/api-contract/phone").RoomView | null;
  isDirectMessage: boolean;
  membershipError: string | null;
  setParticipantPickerVisible: React.Dispatch<React.SetStateAction<boolean>>;
  memberManagement: { canOpenRoster: boolean; pickerVisible: boolean; };
  renameBusy: boolean;
  closeRoomActions: () => void;
  canRenameTitle: boolean;
  startRenameFromTitle: () => void;
  displayRoomName: string;
  roomActionsRef: React.RefObject<RoomActionsSheetHandle | null>;
  roomRepoOptions: RoomRepositoryOptions;
  conversationFrameRef: React.RefObject<View | null>;
  isCorner: boolean;
  renameEditing: boolean;
  setRenameDraft: (update: string | ((previous: string) => string)) => void;
  setRenameError: React.Dispatch<React.SetStateAction<string | null>>;
  handleRenameRoom: () => Promise<void>;
  renameDraft: string;
  setRenameEditing: React.Dispatch<React.SetStateAction<boolean>>;
  roomRepository: RoomRepository | null;
  canManageWorkspace: boolean;
  applyRoomReviewer: (reviewerAgentId: string | undefined) => void;
  pushMuteWorking: boolean;
  togglePushMute: () => Promise<void>;
  pushMuted: boolean;
  roomParticipantTotal: number;
  participantsHydrated: boolean;
  setRoomActionsVisible: (visible: boolean) => void | undefined;
  activeCommunityId: string | null;
  roomLifecycleBusy: boolean;
  handleRoomLifecycle: (action: "delete" | "leave") => Promise<void>;
  renameError: string | null;
  setDmActionsVisible: React.Dispatch<React.SetStateAction<boolean>>;
  dmActionsVisible: boolean;
  viewerIsAgent: boolean;
  headerTitle: string | null;
  cornerOwnerDisplay: import("@/buzz/agent-display").AgentDisplayIdentity | null | undefined;
  cornerActionsVisible: boolean;
  transport: BuzzRigTransport | null;
  setCornerActionsVisible: React.Dispatch<React.SetStateAction<boolean>>;
  handleBack: () => void;
  readRoom: () => void;
  participantPickerKind: "agent" | "person" | null;
  agentConnectVisible: boolean;
  closeAgentConnect: () => void;
  createPollVisible: boolean;
  createPollBusy: boolean;
  setCreatePollVisible: React.Dispatch<React.SetStateAction<boolean>>;
  handleCreatePoll: (draft: PollDraft) => Promise<boolean>;
};
export function ChatSurfaceOverlays({
  attachmentPickerVisible,
  setAttachmentPickerVisible,
  pickDocument,
  pickPhoto,
  desktopExperience,
  pasteImage,
  setMessageActionsTarget,
  messageActionsTarget,
  outbox,
  handleReactToMessage,
  messageIsBookmarked,
  handleBookmarkMessage,
  handleReportMessage,
  handleCopyLedgerMessage,
  showCopyToast,
  handleSelectLedgerMessage,
  decodedId,
  beginReply,
  beginForward,
  canDeleteMessage,
  handleDeleteMessage,
  setForwardCornerPrompt,
  confirmForwardToNewCorner,
  forwardCornerPrompt,
  forwardBusyRoomId,
  forwardError,
  setForwardTarget,
  setForwardRooms,
  setForwardError,
  forwardToRoom,
  forwardRooms,
  forwardTarget,
  roomSurface,
  isDirectMessage,
  membershipError,
  setParticipantPickerVisible,
  memberManagement,
  renameBusy,
  closeRoomActions,
  canRenameTitle,
  startRenameFromTitle,
  displayRoomName,
  roomActionsRef,
  roomRepoOptions,
  conversationFrameRef,
  isCorner,
  renameEditing,
  setRenameDraft,
  setRenameError,
  handleRenameRoom,
  renameDraft,
  setRenameEditing,
  roomRepository,
  canManageWorkspace,
  applyRoomReviewer,
  pushMuteWorking,
  togglePushMute,
  pushMuted,
  roomParticipantTotal,
  participantsHydrated,
  setRoomActionsVisible,
  activeCommunityId,
  roomLifecycleBusy,
  handleRoomLifecycle,
  renameError,
  setDmActionsVisible,
  dmActionsVisible,
  viewerIsAgent,
  headerTitle,
  cornerOwnerDisplay,
  cornerActionsVisible,
  transport,
  setCornerActionsVisible,
  handleBack,
  readRoom,
  participantPickerKind,
  agentConnectVisible,
  closeAgentConnect,
  createPollVisible,
  createPollBusy,
  setCreatePollVisible,
  handleCreatePoll,
}: Props) {
  const desktop = useIsDesktop();
  // Mount each sheet on its first opening, then retain it for native dismissal
  // and onDismiss cleanup. Closed sheets do no mount/style work on chat open.
  const messageActionsMounted = useOpenedSheet(Boolean(messageActionsTarget));
  const forwardCornerMounted = useOpenedSheet(Boolean(forwardCornerPrompt));
  const forwardMessageMounted = useOpenedSheet(Boolean(forwardTarget));
  const dmActionsMounted = useOpenedSheet(dmActionsVisible);
  const renameMounted = useOpenedSheet(isCorner && renameEditing);
  const pollMounted = useOpenedSheet(createPollVisible);
  const messageLinkToken = messageActionsTarget ? chatMessageLinkToken(messageActionsTarget) : null;
  return <>
      {attachmentPickerVisible && <AttachmentPickerSheet
        visible={attachmentPickerVisible}
        onClose={() => setAttachmentPickerVisible(false)}
        onPickDocument={() => void pickDocument()}
        onPickPhoto={() => void pickPhoto()}
        onPickPasted={desktopExperience ? undefined : () => void pasteImage()}
      />}

      {messageActionsMounted && <HullActionSheetModal
        accessibilityLabel="Close message actions"
        onClose={() => setMessageActionsTarget(null)}
        testID="message-actions-sheet"
        title="Message"
        subtitle={messageActionsTarget ? outbox.states.get(messageActionsTarget.id)?.reason : undefined}
        visible={Boolean(messageActionsTarget)}
      >
        {messageActionsTarget && outbox.states.get(messageActionsTarget.id)?.kind !== 'sending' && outbox.current()?.get(messageActionsTarget.id) ? (
          <HullActionSheetRow label="Retry" testID="message-retry-action" onPress={() => {
            const target = messageActionsTarget;
            setMessageActionsTarget(null);
            void outbox.retry([target.id]);
          }} />
        ) : null}
        {messageActionsTarget && !messageActionsTarget.isAgentActivity ? (
          // The reaction entry point is the emoji scroll itself — the sheet's
          // top cell, with no React row and nothing to expand above it.
          <MessageReactionStrip
            onReact={(emoji) => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) void handleReactToMessage(target, emoji);
            }}
          />
        ) : null}
        {messageActionsTarget && !messageActionsTarget.isAgentActivity ? (
          <HullActionSheetRow
            accessibilityLabel={
              messageIsBookmarked(messageActionsTarget) ? 'Remove bookmark' : 'Bookmark message'
            }
            label={messageIsBookmarked(messageActionsTarget) ? 'Remove bookmark' : 'Bookmark'}
            onPress={() => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) void handleBookmarkMessage(target);
            }}
            testID="message-bookmark-action"
          />
        ) : null}
        {messageActionsTarget && !messageActionsTarget.isAgentActivity ? (
          <HullActionSheetRow
            accessibilityLabel="Report an issue with this message"
            label="Report issue"
            onPress={() => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) void handleReportMessage(target);
            }}
            testID="message-report-action"
          />
        ) : null}
        {messageActionsTarget ? (
          <HullActionSheetRow
            accessibilityLabel="Copy message text"
            label="Copy"
            onPress={() => {
              handleCopyLedgerMessage(
                messageActionsTarget.isAgentActivity
                  ? agentActivityReplyExcerpt(messageActionsTarget)
                  : messageActionsTarget.text,
              );
              setMessageActionsTarget(null);
            }}
            testID="message-copy-action"
          />
        ) : null}
        {messageLinkToken ? (
          <HullActionSheetRow
            accessibilityLabel={`Copy link ${messageLinkToken}`}
            label="Copy link"
            metadata={messageLinkToken}
            onPress={() => {
              setMessageActionsTarget(null);
              void copyChatMessageLink(messageLinkToken, Clipboard.setStringAsync,
                { showCopied: showCopyToast, showCopyFailed: showCopyToast });
            }}
            testID="message-copy-link-action"
          />
        ) : null}
        {messageActionsTarget ? (
          <HullActionSheetRow
            accessibilityLabel="Select message text"
            label="Select"
            onPress={() => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) {
                handleSelectLedgerMessage(
                  target.isAgentActivity ? agentActivityReplyExcerpt(target) : target.text,
                );
              }
            }}
            testID="message-select-action"
          />
        ) : null}
        {messageActionsTarget && canBeginReply(messageActionsTarget, decodedId) ? (
          <HullActionSheetRow
            accessibilityLabel="Reply to message"
            label="Reply"
            onPress={() => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) beginReply(target);
            }}
            testID="message-reply-action"
          />
        ) : null}
        {messageActionsTarget && !messageActionsTarget.isAgentActivity ? (
          <HullActionSheetRow
            accessibilityLabel="Forward message"
            label="Forward"
            onPress={() => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) void beginForward(target);
            }}
            testID="message-forward-action"
          />
        ) : null}
        {messageActionsTarget && canDeleteMessage(messageActionsTarget) ? (
          <HullActionSheetRow
            accessibilityLabel="Delete message"
            destructive
            label="Delete"
            onPress={() => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) void handleDeleteMessage(target);
            }}
            testID="message-delete-action"
          />
        ) : null}
        <HullActionSheetCancel
          onPress={() => setMessageActionsTarget(null)}
          testID="message-actions-close"
        />
      </HullActionSheetModal>}

      {forwardCornerMounted && <ForwardCornerSheet
        onClose={() => setForwardCornerPrompt(null)}
        onOpen={() => void confirmForwardToNewCorner()}
        visible={Boolean(forwardCornerPrompt)}
      />}

      {forwardMessageMounted && <ForwardMessagePickerSheet
        draftContext={decodedId}
        busyRoomId={forwardBusyRoomId}
        error={forwardError}
        onClose={() => {
          if (forwardBusyRoomId) return;
          setForwardTarget(null);
        }}
        onDismiss={() => {
          setForwardRooms(null);
          setForwardError(null);
        }}
        onForward={forwardToRoom}
        targets={forwardRooms}
        visible={Boolean(forwardTarget)}
      />}


      <RoomActionsSheet
        accessibilityLabel={`Close ${ROOM_LABEL} actions`}
        dismissOnBackdrop={!renameBusy}
        onClose={closeRoomActions}
        onTitlePress={canRenameTitle ? startRenameFromTitle : undefined}
        testID="room-actions-sheet"
        title={displayRoomName}
        titleAccessibilityLabel={`Rename ${displayRoomName}`}
        titleTestID="room-actions-title"
        ref={roomActionsRef}
        repository={roomRepoOptions}
        backgroundRef={conversationFrameRef}
      >
        {() => <>
            {!isCorner && canRenameTitle && renameEditing && (
              // Hangs between the sheet's rows, on their 24pt inset.
              <YStack paddingHorizontal="6" paddingVertical="2" borderTopWidth={1} borderTopColor="stroke" testID="rename-room-editor">
                <T v="meta" color="secondary">New {ROOM_LABEL.toLowerCase()} name</T>
                <YStack marginTop="1">
                <HullDialogInput
                  accessibilityLabel={`New ${ROOM_LABEL} name`}
                  autoCapitalize="none"
                  autoCorrect={false}
                  // The native field's own prop; the Tamagui field type does not name it.
                  {...{ editable: !renameBusy }}
                  onChangeText={(value) => {
                    setRenameDraft(roomNameEntry(value));
                    if (value.trim()) setRenameError(null);
                  }}
                  onSubmitEditing={() => void handleRenameRoom()}
                  returnKeyType="done"
                  selectTextOnFocus
                  testID="rename-room-input"
                  value={renameDraft}
                />
                </YStack>
                {!validRoomSlug(renameDraft.trim()) && (
                  <T v="meta" color="secondary">{ROOM_SLUG_HINT}</T>
                )}
                <YStack marginTop="2">
                <HullDialogActions actions={[{ disabled: renameBusy, label: "Cancel", onPress: () => {
                      setRenameEditing(false);
                      setRenameError(null);
                    }, variant: "quiet" }, { disabled: renameBusy || !validRoomSlug(renameDraft.trim()), label: renameBusy ? 'Renaming…' : 'Save', loading: renameBusy, onPress: () => void handleRenameRoom(), testID: "apply-room-rename", variant: 'primary' }]} />
                </YStack>
              </YStack>
            )}
            <RoomReviewerActions
              agents={(roomSurface?.members ?? [])
                .filter((member) => member.identity.kind === 'agent')
                .map((member) => member.identity)}
              allowAutoMerge={roomRepository?.allowAutoMerge}
              canManage={canManageWorkspace}
              hasRepository={roomRepository !== null}
              onSaved={(reviewer) => applyRoomReviewer(reviewer ?? undefined)}
              reviewerAgentId={roomSurface?.room.reviewerAgentId}
              roomId={decodedId}
              roomName={displayRoomName}
              updateRoom={(input) => monolithPhoneOperation('updateRoom', input)}
            />
            <HullActionSheetRow
              label="Mute notifications"
              accessibilityLabel={`Mute notifications in this ${ROOM_LABEL} and its ${CORNER_LABEL}s`}
              description="Tags and replies still notify you."
              disabled={pushMuteWorking}
              onPress={() => void togglePushMute()}
              toggle={{
                value: pushMuted,
                disabled: pushMuteWorking,
                onValueChange: () => void togglePushMute(),
              }}
              testID="room-push-mute"
            />
            <HullActionSheetRow
              accessibilityLabel={`View ${formatRoomParticipantTotal(roomParticipantTotal)}`}
              chevron="right"
              disabled={!memberManagement.canOpenRoster}
              label="Members"
              metadata={
                participantsHydrated ? formatRoomParticipantTotal(roomParticipantTotal) : 'Loading'
              }
              onPress={() => {
                setRoomActionsVisible(false);
                openPlace({ kind: 'members', roomId: decodedId }, desktop);
              }}
              testID="room-participant-roster-trigger"
            />
            {canManageWorkspace && (
              <HullActionSheetRow
                accessibilityLabel={`View ${ROOM_LABEL} routines`}
                chevron="right"
                label="Routines"
                onPress={() => {
                  setRoomActionsVisible(false);
                  router.push({
                    pathname: '/beeline/settings/schedules',
                    params: { roomId: decodedId, workspaceId: activeCommunityId },
                  } as unknown as Href);
                }}
                testID="room-schedules-action"
              />
            )}
            {canManageWorkspace && (
              <HullActionSheetRow
                accessibilityLabel={`Delete ${ROOM_LABEL}`}
                destructive
                disabled={roomLifecycleBusy}
                label={roomLifecycleBusy ? 'Deleting…' : `Delete ${ROOM_LABEL}`}
                onPress={() => void handleRoomLifecycle('delete')}
                testID="delete-room-action"
              />
            )}
            <HullActionSheetRow
              accessibilityLabel={`Leave ${ROOM_LABEL}`}
              destructive
              disabled={roomLifecycleBusy}
              label={roomLifecycleBusy ? 'Leaving…' : `Leave ${ROOM_LABEL}`}
              onPress={() => void handleRoomLifecycle('leave')}
              testID="leave-room-action"
            />
            {(renameError || membershipError) && (
              <YStack accessibilityRole="alert" marginHorizontal="6" marginTop="2" padding="2" borderWidth={1} borderColor="strongStroke" backgroundColor="highlight">
                <ErrorBanner inline title={renameError ?? membershipError ?? ''} />
              </YStack>
            )}
        </>}
      </RoomActionsSheet>

      {dmActionsMounted && <HullActionSheetModal
        accessibilityLabel="Close conversation actions"
        onClose={() => setDmActionsVisible(false)}
        testID="dm-actions-sheet"
        title={displayRoomName}
        visible={dmActionsVisible}
      >
        <HullActionSheetRow
          label="Mute notifications"
          accessibilityLabel="Mute notifications from this conversation"
          disabled={pushMuteWorking}
          onPress={() => void togglePushMute()}
          toggle={{
            value: pushMuted,
            disabled: pushMuteWorking,
            onValueChange: () => void togglePushMute(),
          }}
          testID="dm-push-mute"
        />
        {!viewerIsAgent && roomSurface?.viewer.permissions.send && (
          <HullActionSheetRow
            accessibilityLabel="View conversation routines"
            chevron="right"
            label="Routines"
            onPress={() => {
              setDmActionsVisible(false);
              router.push({
                pathname: '/beeline/settings/schedules',
                params: { roomId: decodedId, workspaceId: activeCommunityId },
              } as unknown as Href);
            }}
            testID="dm-schedules-action"
          />
        )}
        {membershipError && (
          <YStack accessibilityRole="alert" marginHorizontal="6" marginTop="2" padding="2" borderWidth={1} borderColor="strongStroke" backgroundColor="highlight">
            <ErrorBanner inline title={membershipError} />
          </YStack>
        )}
        <HullActionSheetCancel
          onPress={() => setDmActionsVisible(false)}
          testID="dm-actions-close"
        />
      </HullActionSheetModal>}

      {cornerActionsVisible && <CornerActionsSheet
        title={headerTitle ?? cornerOwnerDisplay?.name ?? CORNER_TITLE}
        visible={cornerActionsVisible}
        locked={roomSurface?.cornerLocked === true}
        connected={Boolean(transport)}
        onClose={() => setCornerActionsVisible(false)}
        closeCorner={async () => {
          if (!transport) throw new Error('Still connecting. Try again in a moment.');
          await transport.closeCorner(decodedId);
        }}
        setLocked={async (locked) => {
          if (!transport) throw new Error('Still connecting. Try again in a moment.');
          await transport.setCornerLocked(decodedId, locked);
        }}
        onClosed={() => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          handleBack();
        }}
        onSaved={() => readRoom()}
        onError={(error) => {
          readRoom();
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          Modal.alert('Could not complete request', appErrorCopy(error));
        }}
      />}

      {renameMounted && <HullDialog
        actions={[
          {
            disabled: renameBusy,
            label: 'Cancel',
            onPress: () => {
              setRenameEditing(false);
              setRenameError(null);
            },
          },
          {
            busy: renameBusy,
            disabled: renameBusy || !renameDraft.trim(),
            label: renameBusy ? 'Renaming' : 'Apply',
            onPress: () => void handleRenameRoom(),
            testID: 'apply-corner-rename',
            variant: 'primary',
          },
        ]}
        dismissOnBackdrop={!renameBusy}
        onRequestClose={() => {
          if (renameBusy) return;
          setRenameEditing(false);
          setRenameError(null);
        }}
        testID="rename-corner-dialog"
        title={`Rename ${CORNER_LABEL}`}
        visible={isCorner && renameEditing}
      >
        <HullDialogInput
          accessibilityLabel={`New ${CORNER_LABEL} name`}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          // The native field's own prop; the Tamagui field type does not name it.
          {...{ editable: !renameBusy }}
          maxLength={120}
          onChangeText={(value) => {
            setRenameDraft(roomNameEntry(value));
            if (value.trim()) setRenameError(null);
          }}
          onSubmitEditing={() => void handleRenameRoom()}
          returnKeyType="done"
          selectTextOnFocus
          testID="rename-corner-input"
          value={renameDraft}
        />
        {renameError ? (
          <ErrorBanner inline title={renameError} />
        ) : null}
      </HullDialog>}

      {memberManagement.pickerVisible ? (
        <ChatAddSheet roomId={decodedId} sheet={participantPickerKind === 'person' ? 'people' : 'agents'}
          close={() => setParticipantPickerVisible(false)} />
      ) : null}
      {agentConnectVisible && activeCommunityId ? (
        <WorkspaceAddAgentSheet workspaceId={activeCommunityId} close={closeAgentConnect} />
      ) : null}
      {pollMounted && <CreatePollSheet
        draftContext={decodedId}
        visible={createPollVisible}
        busy={createPollBusy}
        onClose={() => setCreatePollVisible(false)}
        onCreate={handleCreatePoll}
      />}

</>; }


function useOpenedSheet(visible: boolean): boolean {
  const opened = React.useRef(false);
  if (visible) opened.current = true;
  return opened.current;
}
