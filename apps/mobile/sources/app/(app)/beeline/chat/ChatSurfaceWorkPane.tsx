import React from 'react';
import { DesktopRoomInspector } from '@/components/DesktopRoomInspector';
import type { RoomView } from '@beeline/api-contract/phone';
import type { DesktopWorkPaneContent } from '@/buzz/desktop-workbench-state';

export function ChatSurfaceWorkPane({ desktopWorkPaneMounted, displayedDesktopWorkPaneContent, closeDesktopWorkPane }: {
  desktopWorkPaneMounted: RoomView | null;
  displayedDesktopWorkPaneContent: DesktopWorkPaneContent | null;
  closeDesktopWorkPane(): void;
}) {
  return desktopWorkPaneMounted && displayedDesktopWorkPaneContent ? <DesktopRoomInspector
    room={desktopWorkPaneMounted} content={displayedDesktopWorkPaneContent} onClose={closeDesktopWorkPane}
  /> : null;
}
