import React, { useEffect, useState, useMemo } from 'react';
import { type RoomRepository, type ChatListItem } from '@beeline/buzz-client';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { activeChannelAtCursor, channelSuggestionCandidates, filterChannelSuggestions, type ChannelSuggestion } from '@/buzz/channel-suggestions';
import { useRoomCorners } from '@/buzz/use-room-corners';
import { roomOpenCornerRows } from '@/buzz/room-corner-store';
import { activeMentionAtCursor, filterMentionCandidates } from '@/buzz/room-participants';
import { useStarPrompt } from '@/components/buzz/StarPromptCard';
import { isAgentTurnActive } from '@/buzz/agent-presence';
import { sameElementRefs, useStable } from '@/buzz/use-stable';
import { roomMemberManagementState } from '@/buzz/room-member-management';
import { type RoomRosterParticipant } from '@/buzz/room-participants';
import { CHANNEL_MENTION_OPTION, SYSTEM_MENTION_OPTION } from './chat-surface-values';

type Props = [
  inputSelection: { start: number; end: number; },
  inputText: string,
  describedRoomParticipants: RoomRosterParticipant[],
  composerFocused: boolean,
  dismissedMentionKey: string | null,
  isDirectMessage: boolean,
  parentChannelId: string | undefined,
  decodedId: string,
  roomClient: import("@/sync/transport/room-view-client").RoomViewClient | null,
  workspaceChats: readonly ChatListItem[],
  roomSurface: import("@beeline/api-contract/phone").RoomView | null,
  presenceReconnectGrace: Record<string, number>,
  unprojectedMessages: ChatDisplayMessage[],
  participantsHydrated: boolean,
  participantPickerVisible: boolean,
  combinedMessages: ChatDisplayMessage[],
  roomRepository: RoomRepository | null,
];

export function useChatComposerSuggestions([
  inputSelection, inputText,
  describedRoomParticipants, composerFocused, dismissedMentionKey, isDirectMessage, parentChannelId,
  decodedId, roomClient, workspaceChats, roomSurface, presenceReconnectGrace, unprojectedMessages,
  participantsHydrated, participantPickerVisible, combinedMessages, roomRepository,
]: Props): [
  directMessageListItem: ChatListItem | null,
  isReadOnlyDirectMessage: boolean,
  messages: ChatDisplayMessage[],
  activeAgentTurns: import("@beeline/api-contract/phone").RoomViewAgentTurn[],
  pendingCornerRequest: ChatDisplayMessage | undefined,
  pendingTargetBranchProposal: ChatDisplayMessage | undefined,
  agentTurnMarkers: readonly import("@beeline/api-contract/phone").RoomViewAgentTurn[],
  activeAgentTurn: import("@beeline/api-contract/phone").RoomViewAgentTurn,
  starPrompt: ReturnType<typeof useStarPrompt>,
  activeMention: import("@/buzz/room-participants").ActiveMention | null,
  activeChannel: import("@/buzz/channel-suggestions").ActiveChannel | null,
  mentionMenuVisible: boolean,
  mentionSuggestions: { matches: RoomRosterParticipant[]; overflow: number; },
  channelMenuVisible: boolean,
  channelSuggestions: { matches: ChannelSuggestion[]; overflow: number; },
  suggestionCount: number,
  mentionMenuKey: string | null,
  channelMenuKey: string | null,
  memberManagement: { canOpenRoster: boolean; pickerVisible: boolean; },
] {

  const activeMention = useMemo(
    () =>
      inputSelection.start === inputSelection.end
        ? activeMentionAtCursor(inputText, inputSelection.start)
        : null,
    [inputSelection.end, inputSelection.start, inputText],
  );

  const mentionMenuKey = activeMention
    ? `${inputText}:${activeMention.start}:${activeMention.end}`
    : null;

  const mentionCandidateRoster = useMemo(
    () => [CHANNEL_MENTION_OPTION, ...describedRoomParticipants, SYSTEM_MENTION_OPTION],
    [describedRoomParticipants],
  );

  const mentionSuggestions = useMemo(
    () =>
      activeMention
        ? filterMentionCandidates(
            mentionCandidateRoster,
            activeMention.query,
          )
        : { matches: [], overflow: 0 },
    [activeMention, mentionCandidateRoster],
  );

  const mentionMenuVisible = Boolean(
    composerFocused &&
    mentionMenuKey &&
    mentionMenuKey !== dismissedMentionKey &&
    mentionSuggestions.matches.length > 0,
  );

  const activeChannel = useMemo(
    () =>
      inputSelection.start === inputSelection.end
        ? activeChannelAtCursor(inputText, inputSelection.start)
        : null,
    [inputSelection.end, inputSelection.start, inputText],
  );

  const channelMenuKey = activeChannel
    ? `#${inputText}:${activeChannel.start}:${activeChannel.end}`
    : null;

  // The current Room's open corners from its corner record, held once the
  // first `#` opens the menu; frames keep it current from then on.
  const channelCornerRoomId = isDirectMessage ? null : (parentChannelId ?? decodedId);

  const [channelCornersRoomId, setChannelCornersRoomId] = useState<string | null>(null);

  useEffect(() => {
    if (activeChannel && channelCornerRoomId && roomClient) setChannelCornersRoomId(channelCornerRoomId);
  }, [activeChannel, channelCornerRoomId, roomClient]);

  const channelCornerRecord = useRoomCorners(
    channelCornersRoomId === channelCornerRoomId ? (channelCornerRoomId ?? undefined) : undefined,
    roomClient,
  );

  const channelCorners = useMemo(() => {
    const view = channelCornerRecord.view;
    if (!view || !channelCornerRecord.record) return null;
    return {
      roomId: view.room.id,
      room: { name: view.room.name },
      corners: roomOpenCornerRows(channelCornerRecord.record).map((item) => ({
        id: item.corner.id,
        name: item.corner.name,
        activityAt: item.latestMessage?.createdAt ?? item.stateAt,
      })),
    };
  }, [channelCornerRecord.record, channelCornerRecord.view]);

  const channelSuggestions = useMemo(() => {
    if (!activeChannel) return { matches: [], overflow: 0 };
    const corners = channelCorners?.roomId === channelCornerRoomId ? channelCorners : null;
    return filterChannelSuggestions(
      channelSuggestionCandidates(
        workspaceChats
          .filter((item) => !item.directMessage)
          .map((item) => ({
            id: item.room.id,
            name: item.room.name,
            repositoryName: item.repositoryName,
          })),
        corners?.room ?? null,
        corners?.corners ?? [],
      ),
      activeChannel.query,
    );
  }, [activeChannel, channelCorners, channelCornerRoomId, workspaceChats]);

  const channelMenuVisible = Boolean(
    composerFocused &&
    channelMenuKey &&
    channelMenuKey !== dismissedMentionKey &&
    channelSuggestions.matches.length > 0,
  );

  const suggestionCount = mentionMenuVisible
    ? mentionSuggestions.matches.length
    : channelMenuVisible
      ? channelSuggestions.matches.length
      : 0;

  // The latest signed lifecycle receipt is server-indexed. Draft/thought
  // overlays carry content only and can neither start nor extend a turn.
  const agentTurnMarkers = useMemo(
    () => roomSurface?.latestAgentTurns ?? [],
    [roomSurface?.latestAgentTurns],
  );

  // Every agent answering right now, not just the first: two agents asked in
  // one message run two concurrent turns and each owns its own live lane.
  const rawActiveAgentTurns = useMemo(
    () => agentTurnMarkers.filter(isAgentTurnActive),
    [agentTurnMarkers],
  );

  // A filter rebuilds its array on every presence tick even when it selected
  // the same receipts, and this feeds the transcript projection.
  const activeAgentTurns = useStable(rawActiveAgentTurns, sameElementRefs);

  // The composer's thinking line and its settled summary are ONE line, so they
  // read the first of them; the transcript and the gold ring take them all.
  const activeAgentTurn = activeAgentTurns[0];

  const messages = unprojectedMessages;

  const directMessageListItem = useMemo(
    () => workspaceChats.find((item) => item.room.id === decodedId && item.directMessage) ?? null,
    [decodedId, workspaceChats],
  );

  const memberManagement = roomMemberManagementState({
    isDirectMessage,
    participantsHydrated,
    pickerRequested: participantPickerVisible,
  });

  // An @system notification DM (release or Workspace lifecycle): the server
  // never lets anyone but @system post into it (viewer.permissions.send is
  // false there and only there for a direct message, since a DM can never be
  // archived).
  const isReadOnlyDirectMessage = isDirectMessage && roomSurface?.viewer.permissions.send === false;

  const starPrompt = useStarPrompt(decodedId, Boolean(roomSurface) && !isReadOnlyDirectMessage);

  const pendingCornerRequest = useMemo(() => {
    for (let index = combinedMessages.length - 1; index >= 0; index -= 1) {
      const message = combinedMessages[index];
      if (
        message.writePermission?.status === 'pending' &&
        message.writePermission.repository &&
        message.writePermission.purpose !== 'squire-spending'
      ) {
        return message;
      }
    }
    return undefined;
  }, [combinedMessages]);

  const pendingTargetBranchProposal = useMemo(() => {
    for (let index = combinedMessages.length - 1; index >= 0; index -= 1) {
      const message = combinedMessages[index];
      if (
        message.targetBranchProposal &&
        roomRepository?.targetBranch !== message.targetBranchProposal.to
      ) {
        return message;
      }
    }
    return undefined;
  }, [combinedMessages, roomRepository?.targetBranch]);

  return [
    directMessageListItem, isReadOnlyDirectMessage, messages, activeAgentTurns,
    pendingCornerRequest, pendingTargetBranchProposal, agentTurnMarkers, activeAgentTurn, starPrompt,
    activeMention, activeChannel,
    mentionMenuVisible, mentionSuggestions, channelMenuVisible, channelSuggestions, suggestionCount,
    mentionMenuKey, channelMenuKey, memberManagement,
  ];
}
