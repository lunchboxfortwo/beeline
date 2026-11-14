import * as React from 'react';
import type { RoomView } from '@beeline/buzz-client';
import type { DesktopWorkPaneContent } from '@/buzz/desktop-workbench-state';
import { useSurfaceFocus } from '@/buzz/use-surface-focus';
import { DesktopArtifactPane } from '@/components/buzz/DesktopArtifactPane';
import { ComputerSessionViewer } from '@/components/buzz/ComputerSession';
import { DesktopViewerPane } from './DesktopViewerPane';

/** The desktop pane contains only an explicitly opened artifact or browser. */
export function DesktopRoomInspector({ room, content, onClose }: {
  room: RoomView;
  content: DesktopWorkPaneContent;
  onClose(): void;
}) {
  const focused = useSurfaceFocus();
  return <DesktopViewerPane>
    {content.kind === 'artifact' ? (
      <DesktopArtifactPane {...content.artifact}
        roomId={content.artifact.roomId ?? room.room.id} onClose={onClose} />
    ) : (
      <ComputerSessionViewer session={content.session} active={focused} onClose={onClose}
        roomId={room.room.id} agentHandle={content.session.agentHandle} />
    )}
  </DesktopViewerPane>;
}
