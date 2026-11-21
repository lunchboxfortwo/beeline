import { useRecordedWorkItem } from '@/buzz/work-board-store';
import React, { useCallback, useMemo } from 'react';
import { router } from 'expo-router';
import { cornerShortTitle, roomTitle, type CornerState, type RoomView } from '@beeline/api-contract/phone';
import { navigateToRoom } from '@/buzz/corner-navigation';
import { openExternalUrl } from '@/utils/open-external-url';
import { Modal } from '@/modal';
import { openPlace } from '@/ui/shell/panel';
import { ThreadTitleBlock, type ThreadHeaderData } from '@/ui/screens/thread/ThreadHeader';
import { threadPrLine } from '@/ui/screens/thread/thread-status';
import { useTitleBlockVisibility } from '@/ui/screens/thread/useTitleBlockVisibility';
import { findRoomCornerRow, useRoomCornerRecord } from '@/buzz/room-corner-store';

/**
 * Header B's data for a corner: the server corner state, viewer-specific
 * waiting emphasis, the PR row from `cornerLifecycle`,
 * the objective and the brief. Returns the bar data, whether the title block
 * has scrolled away, the block itself for the transcript's oldest slot, and
 * the full header the bar shows while that block is away.
 */
export function useChatThreadHeader({
  isCorner, roomSurface, resolvedChannelName, decodedId, parentChannelId, state,
  objective, isArchived, isDesktop, positions,sourceMessageId, viewerPubkey,
}: {
  isCorner: boolean;
  viewerPubkey?: string;
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
}) {
  const recordedWorkItem=useRecordedWorkItem(roomSurface?.room.workspaceId,sourceMessageId);
  const corners = useRoomCornerRecord(isCorner ? parentChannelId : undefined);
  const openingRow = corners ? findRoomCornerRow(corners, decodedId) : undefined;
  const openingSummary = corners?.summary?.openCorners.find((corner) => corner.id === decodedId);
  const parentName = roomSurface?.parent?.name ?? corners?.header?.room.name ?? null;
  const title = resolvedChannelName ?? openingRow?.corner.name ?? openingSummary?.name ?? null;
  const threadState = state ?? openingRow?.state ?? openingSummary?.state;
  const threadReason = openingRow?.reason ?? openingSummary?.reason;
  const threadBlocker = openingRow?.blocker ?? openingSummary?.blocker;
  const prUrl = roomSurface?.cornerLifecycle?.pr?.url;
  const hasBrief = Boolean(roomSurface?.cornerBrief);
  const visibility = useTitleBlockVisibility(isCorner, positions);

  const thread = useMemo<ThreadHeaderData | undefined>(() => {
    if (!isCorner) return undefined;
    const prLine = threadPrLine(roomSurface?.cornerLifecycle, isArchived);
    return {
      chatTag: parentName ? (roomTitle(parentName) ?? null) : null,
      repositoryHomepageIcon: roomSurface?.room.homepageIcon,
      title: cornerShortTitle(parentName, title, decodedId),
      ...(threadState ? { state: threadState } : isArchived ? { state: 'archived' as const } : {}),
      ...(threadReason ? { reason: threadReason } : {}),
      ...(threadBlocker ? { blocker: threadBlocker } : {}),
      ...(viewerPubkey ? { viewer: viewerPubkey } : {}),
      workItem:recordedWorkItem??roomSurface?.workItem,
      people:roomSurface?.members.map(member=>member.identity),
      ...(prLine ? { prLine } : {}),
      ...(objective.trim() ? { objective: objective.trim() } : {}),
    };
  }, [decodedId, isArchived, isCorner, objective, parentName, title, roomSurface?.cornerLifecycle, roomSurface?.room.homepageIcon, roomSurface?.workItem, recordedWorkItem, roomSurface?.members, threadState, threadBlocker, threadReason, viewerPubkey]);

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
