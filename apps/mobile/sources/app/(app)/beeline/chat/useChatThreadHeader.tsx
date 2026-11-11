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

/**
 * Header B's data for a corner: the server corner state, the running count
 * (this RoomView's working agent turns), the PR row from `cornerLifecycle`,
 * the objective and the brief. Returns the bar data, whether the title block
 * has scrolled away, and the block itself for the transcript's oldest slot.
 */
export function useChatThreadHeader({
  isCorner, roomSurface, resolvedChannelName, decodedId, parentChannelId, state, running,
  objective, isArchived, isDesktop, positions,
}: {
  isCorner: boolean;
  roomSurface: RoomView | null;
  resolvedChannelName: string | null;
  decodedId: string;
  parentChannelId: string | undefined;
  state: CornerState | undefined;
  running: number;
  objective: string;
  isArchived: boolean;
  isDesktop: boolean;
  positions?: { subscribe(listener: () => void): () => void };
}) {
  const parentName = roomSurface?.parent?.name?.trim() ? roomSurface.parent.name : null;
  const prUrl = roomSurface?.cornerLifecycle?.pr?.url;
  const hasBrief = Boolean(roomSurface?.cornerBrief);
  const visibility = useTitleBlockVisibility(isCorner, positions);

  const thread = useMemo<ThreadHeaderData | undefined>(() => {
    if (!isCorner) return undefined;
    const prLine = threadPrLine(roomSurface?.cornerLifecycle, isArchived);
    return {
      chatTag: parentName ? (roomTitle(parentName) ?? null) : null,
      title: cornerShortTitle(parentName, resolvedChannelName, decodedId),
      ...(state ? { state } : isArchived ? { state: 'archived' as const } : {}),
      running,
      ...(prLine ? { prLine } : {}),
      ...(objective.trim() ? { objective: objective.trim() } : {}),
    };
  }, [decodedId, isArchived, isCorner, objective, parentName, resolvedChannelName, roomSurface?.cornerLifecycle, running, state]);

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
    <ThreadTitleBlock h={thread} openBrief={openBrief} openPr={openPr}
      blockRef={blockRef} onBlockLayout={onBlockLayout} />
  ) : null), [blockRef, onBlockLayout, openBrief, openPr, thread]);

  return {
    thread,
    collapsed: visibility.collapsed,
    barRef: visibility.barRef,
    onBarLayout: visibility.onBarLayout,
    openBrief,
    openParentChat,
    titleBlock,
  };
}
