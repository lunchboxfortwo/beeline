import { appErrorCopy } from '@/buzz/app-error-copy';
import React, { useCallback } from 'react';
import * as Haptics from 'expo-haptics';
import { router, type Href } from 'expo-router';
import { Modal } from '@/modal';
import { leaveRoomWithConfirmation } from '@/buzz/room-leave';
import { BuzzRigTransport } from '@/sync/transport';
import { roomTitle } from '@beeline/api-contract/phone';
import { CORNER_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { ROOM_SLUG_HINT, validRoomSlug } from '@/buzz/room-name';

type Props = [
  transport: BuzzRigTransport | null,
  activeCommunityId: string | null,
  canManageWorkspace: boolean,
  setMembershipError: React.Dispatch<React.SetStateAction<string | null>>,
  decodedId: string,
  setParticipantPickerVisible: React.Dispatch<React.SetStateAction<boolean>>,
  setRoomActionsVisible: (visible: boolean) => void | undefined,
  roomLifecycleBusy: boolean,
  setRoomLifecycleBusy: React.Dispatch<React.SetStateAction<boolean>>,
  displayRoomName: string,
  roomSurface: import("@beeline/api-contract/phone").RoomView | null,
  readRoom: () => void,
  renameBusy: boolean,
  setRenameEditing: React.Dispatch<React.SetStateAction<boolean>>,
  setRenameError: React.Dispatch<React.SetStateAction<string | null>>,
  renameDraft: string,
  isCorner: boolean,
  canRenameTitle: boolean,
  setRenameBusy: React.Dispatch<React.SetStateAction<boolean>>,
  renameTextDraft: import("@/buzz/text-draft-store").TextDraft<string>,
  applyRoomName: (name: string, expected?: string) => void,
];

export function useChatMembershipActions([
  transport, activeCommunityId, canManageWorkspace, setMembershipError, decodedId, setParticipantPickerVisible,
  setRoomActionsVisible, roomLifecycleBusy, setRoomLifecycleBusy, displayRoomName,
  roomSurface, readRoom, renameBusy, setRenameEditing, setRenameError, renameDraft, isCorner,
  canRenameTitle, setRenameBusy, renameTextDraft, applyRoomName,
]: Props): [
  closeRoomActions: () => void,
  handleConnectAgent: () => void,
  handleRenameRoom: () => Promise<void>,
  handleRoomLifecycle: (action: "delete" | "leave") => Promise<void>,
] {


  // A NEW agent: the pairing command lives on the Members page. An agent
  // already in the Workspace is a checkbox row in the picker itself.
  const handleConnectAgent = useCallback(() => {
    setParticipantPickerVisible(false);
    router.push({
      pathname: '/beeline/members',
      params: {
        ...(activeCommunityId ? { communityId: activeCommunityId } : {}),
        action: 'add-agent',
      },
    } as Href);
  }, [activeCommunityId]);


  const returnToRoomList = useCallback(() => {
    router.replace({
      pathname: '/beeline/channels',
      ...(activeCommunityId ? { params: { communityId: activeCommunityId } } : {}),
    });
    // Let the accepted destination render before cleaning up this departing Room.
    React.startTransition(() => {
      setRoomActionsVisible(false);
    });
  }, [activeCommunityId]);


  const handleRoomLifecycle = useCallback(
    async (action: 'delete' | 'leave') => {
      if (!transport || (action === 'delete' && !canManageWorkspace) || roomLifecycleBusy) return;
      const deleting = action === 'delete';
      setRoomLifecycleBusy(true);
      setMembershipError(null);
      try {
        if (deleting) {
          const confirmed = await Modal.confirm(
            `Delete ${displayRoomName}?`,
            `This ${ROOM_LABEL} and its workspace data will be permanently deleted.`,
            {
              cancelText: 'Cancel',
              confirmText: `Delete ${ROOM_LABEL}`,
              destructive: true,
            },
          );
          if (!confirmed) return;
          await transport.deleteRoom(decodedId);
        } else {
          const title = roomTitle(displayRoomName) ?? displayRoomName;
          const left = await leaveRoomWithConfirmation(
            title,
            roomSurface?.leaveDeletesRoom === true,
            (confirmDelete) => transport.leaveRoom(decodedId, confirmDelete),
          );
          if (!left) return;
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        returnToRoomList();
      } catch (err) {
        readRoom();
        setMembershipError(
          appErrorCopy(err, `Could not ${deleting ? 'delete' : 'leave'} ${ROOM_LABEL}.`),
        );
      } finally {
        React.startTransition(() => setRoomLifecycleBusy(false));
      }
    },
    [
      decodedId,
      displayRoomName,
      canManageWorkspace,
      roomSurface?.leaveDeletesRoom,
      returnToRoomList,
      roomLifecycleBusy,
      transport,
    ],
  );


  /** One dismissal for the Room actions sheet: the scrim, the Cancel row and
   *  the hardware back all land here, and a rename in flight holds it open. */
  const closeRoomActions = useCallback(() => {
    if (renameBusy) return;
    setRenameEditing(false);
    setRenameError(null);
    setRoomActionsVisible(false);
  }, [renameBusy]);


  const handleRenameRoom = useCallback(async () => {
    const name = renameDraft.trim();
    const kindLabel = isCorner ? CORNER_LABEL : ROOM_LABEL;
    if (!name) {
      setRenameError(`${kindLabel} name cannot be empty.`);
      return;
    }
    if (!isCorner && !validRoomSlug(name)) {
      setRenameError(ROOM_SLUG_HINT);
      return;
    }
    if (!transport || !canRenameTitle || renameBusy) return;

    setRenameBusy(true);
    setRenameError(null);
    const clearSubmitted = renameTextDraft.capture(false);
    const previousName = roomSurface?.room.name;
    applyRoomName(name);
    try {
      const client = await transport.ensureClient();
      await client.renameChannel(decodedId, name);
      clearSubmitted();
      setRenameEditing(false);
      setRoomActionsVisible(false);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      if (previousName) applyRoomName(previousName, name);
      setRenameError(appErrorCopy(err, `Could not rename ${kindLabel}.`));
    } finally {
      setRenameBusy(false);
    }
  }, [applyRoomName, canRenameTitle, decodedId, isCorner, renameBusy, renameDraft, renameTextDraft, roomSurface?.room.name, transport]);
  return [
    closeRoomActions, handleConnectAgent, handleRenameRoom,
    handleRoomLifecycle, ];
}
