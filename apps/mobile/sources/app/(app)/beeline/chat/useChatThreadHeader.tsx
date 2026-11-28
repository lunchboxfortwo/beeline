import { useRecordedWorkItem } from '@/buzz/work-board-store';
import React, { useCallback, useMemo } from 'react';
import { router } from 'expo-router';
import { cornerShortTitle, roomTitle, threadState as threadStateOf, type CornerState, type RoomView, type RoomViewAgentTurn, type RoomViewIdentity } from '@beeline/api-contract/phone';
import { navigateToRoom } from '@/buzz/corner-navigation';
import { openExternalUrl } from '@/utils/open-external-url';
import { Modal } from '@/modal';
import { openPlace } from '@/ui/shell/panel';
import { ThreadTitleBlock, type ThreadHeaderData } from '@/ui/screens/thread/ThreadHeader';
import { threadPrLine } from '@/ui/screens/thread/thread-status';
import { useTitleBlockVisibility } from '@/ui/screens/thread/useTitleBlockVisibility';
import { resolveAgentDisplayIdentity, type DisplayableAgent } from '@/buzz/agent-display';
import { isAgentTurnActive } from '@/buzz/agent-presence';
import { findRoomCornerRow, useRoomCornerRecord } from '@/buzz/room-corner-store';

function resolveActiveTurnAgentName(
  pubkey: string,
  roomSurface: RoomView,
  conversationIdentities?: ReadonlyMap<string, RoomViewIdentity>,
  agentByPubkey?: ReadonlyMap<string, DisplayableAgent>,
): string {
  const identity =
    conversationIdentities?.get(pubkey) ??
    roomSurface.members.find((member) => member.identity.pubkey === pubkey)?.identity;
  const detail = identity
    ? { pubkey: identity.pubkey, displayName: identity.name }
    : agentByPubkey?.get(pubkey);
  return resolveAgentDisplayIdentity(pubkey, detail).name;
}

/**
 * Header B's data for a corner: the server corner state, viewer-specific
 * waiting emphasis, the PR row from `cornerLifecycle`,
 * the objective and the brief. Returns the bar data, whether the title block
 * has scrolled away, the block itself for the transcript's oldest slot, and
 * the full header the bar shows while that block is away.
 */
export function useChatThreadHeader({
  isCorner, roomSurface, resolvedChannelName, decodedId, parentChannelId, state,
  objective, isArchived, isDesktop, positions, sourceMessageId,
  conversationIdentities, agentByPubkey,
}: {
  isCorner: boolean;
  sourceMessageId?:string;
  roomSurface: RoomView | null;
  resolvedChannelName: string | null;
  decodedId: string;
  parentChannelId: string | undefined;
  state: CornerState | undefined;
  objective: string;
  isArchived: boolean;
  isDesktop: boolean;
  positions?: Parameters<typeof useTitleBlockVisibility>[1];
  conversationIdentities?: ReadonlyMap<string, RoomViewIdentity>;
  agentByPubkey?: ReadonlyMap<string, DisplayableAgent>;
}) {
  const recordedWorkItem=useRecordedWorkItem(roomSurface?.room.workspaceId,sourceMessageId);
  const corners = useRoomCornerRecord(isCorner ? parentChannelId : undefined);
  const openingRow = corners ? findRoomCornerRow(corners, decodedId) : undefined;
  const openingSummary = corners?.summary?.openCorners.find((corner) => corner.id === decodedId);
  const parentName = roomSurface?.parent?.name ?? corners?.header?.room.name ?? null;
  const title = resolvedChannelName ?? openingRow?.corner.name ?? openingSummary?.name ?? null;
  const cachedState = state ?? openingRow?.state ?? openingSummary?.state;
  const cachedWorkingAgentName = openingRow?.workingAgentName ?? openingSummary?.workingAgentName;
  const threadReason = openingRow?.reason ?? openingSummary?.reason;
  const prUrl = roomSurface?.cornerLifecycle?.pr?.url;
  const hasBrief = Boolean(roomSurface?.cornerBrief);
  const visibility = useTitleBlockVisibility(isCorner, positions);

  // Derive the header's activity label and live working/reviewing state from
  // the thread's own active turns once roomSurface loads, so starting,
  // switching, or ending a turn never waits on or drifts against cached parent rows.
  const { headerState, workingAgentName } = useMemo<{
    headerState: CornerState | undefined;
    workingAgentName: string | undefined;
  }>(() => {
    if (!roomSurface) {
      return { headerState: cachedState, workingAgentName: cachedWorkingAgentName };
    }
    const activeTurns = (roomSurface.latestAgentTurns ?? []).filter(isAgentTurnActive);
    if (!activeTurns.length || isArchived) {
      return { headerState: cachedState, workingAgentName: undefined };
    }
    const nameOf = (pubkey: string) =>
      resolveActiveTurnAgentName(pubkey, roomSurface, conversationIdentities, agentByPubkey);
    const reviewerId =
      roomSurface.room.reviewerAgentId ??
      roomSurface.parent?.reviewerAgentId ??
      corners?.header?.room.reviewerAgentId;
    const implementerId = openingRow?.agent?.pubkey ?? roomSurface.cornerOpenerAgentId;
    const isReviewerTurn = (turn: RoomViewAgentTurn) =>
      reviewerId
        ? turn.agentPubkey === reviewerId
        : cachedState === 'review' &&
          cachedWorkingAgentName !== undefined &&
          nameOf(turn.agentPubkey) === cachedWorkingAgentName;
    const reviewerTurn = activeTurns.find(isReviewerTurn);
    const implementerTurn = implementerId
      ? activeTurns.find((turn) => turn.agentPubkey === implementerId && turn !== reviewerTurn)
      : activeTurns.find((turn) => turn !== reviewerTurn);
    const peerTurn = activeTurns.find((turn) => turn !== implementerTurn && turn !== reviewerTurn);
    const live = threadStateOf({
      ended: isArchived,
      implementerRunning: Boolean(implementerTurn),
      reviewerActive: Boolean(reviewerTurn),
      checksRunning: cachedState === 'review' && !reviewerTurn,
      decisionOpen: cachedState === 'waiting',
      backlog: threadReason === 'backlog',
      peerRunning: Boolean(peerTurn),
      implementer: implementerTurn?.agentPubkey,
      reviewer: reviewerTurn?.agentPubkey,
      peer: peerTurn?.agentPubkey,
    });
    return {
      headerState: live.state,
      workingAgentName: 'agent' in live && live.agent ? nameOf(live.agent) : undefined,
    };
  }, [
    agentByPubkey,
    cachedState,
    cachedWorkingAgentName,
    conversationIdentities,
    corners?.header?.room.reviewerAgentId,
    isArchived,
    openingRow?.agent?.pubkey,
    roomSurface,
    threadReason,
  ]);

  const thread = useMemo<ThreadHeaderData | undefined>(() => {
    if (!isCorner) return undefined;
    const prLine = threadPrLine(roomSurface?.cornerLifecycle, isArchived);
    return {
      workingAgentName,
      chatTag: parentName ? (roomTitle(parentName) ?? null) : null,
      repositoryHomepageIcon: roomSurface?.room.homepageIcon,
      title: cornerShortTitle(parentName, title, decodedId),
      ...(headerState ? { state: headerState } : isArchived ? threadStateOf({ ended: true }) : {}),
      ...(threadReason ? { reason: threadReason } : {}),
      workItem:recordedWorkItem??roomSurface?.workItem,
      people:roomSurface?.members.map(member=>member.identity),
      ...(prLine ? { prLine } : {}),
      ...(objective.trim() ? { objective: objective.trim() } : {}),
    };
  }, [workingAgentName, decodedId, isArchived, isCorner, objective, parentName, title, roomSurface?.cornerLifecycle, roomSurface?.room.homepageIcon, roomSurface?.workItem, recordedWorkItem, roomSurface?.members, headerState, threadReason]);

  const openBrief = useMemo(
    () => (isCorner && hasBrief ? () => openPlace({ kind: 'brief', roomId: decodedId }, isDesktop) : undefined),
    [decodedId, hasBrief, isCorner, isDesktop],
  );
  const openPr = useMemo(() => (prUrl ? () => {
    void openExternalUrl(prUrl).catch(() => {
      Modal.alert('Could not open pull request', 'Open the PR from GitHub instead.');
    });
  } : undefined), [prUrl]);
  const openParentChat = useCallback(() => {
    if (parentChannelId) navigateToRoom(router, parentChannelId);
  }, [parentChannelId]);

  // Memoized: the transcript is a memo boundary and must not repaint for a fresh element.
  const { blockRef, onBlockLayout } = visibility;
  const titleBlock = useMemo(() => (thread ? (
    <ThreadTitleBlock h={thread} openBrief={openBrief} openPr={openPr} inset={false}
      blockRef={blockRef} onBlockLayout={onBlockLayout} />
  ) : null), [blockRef, onBlockLayout, openBrief, openPr, thread]);
  const expandedBlock = useMemo(() => (thread && visibility.expanded ? (
    <ThreadTitleBlock h={thread} openBrief={openBrief} openPr={openPr} />
  ) : null), [openBrief, openPr, thread, visibility.expanded]);

  return {
    thread,
    collapsed: visibility.collapsed,
    expandedBlock,
    expand: visibility.expand,
    barRef: visibility.barRef,
    onBarLayout: visibility.onBarLayout,
    openParentChat,
    titleBlock,
  };
}
