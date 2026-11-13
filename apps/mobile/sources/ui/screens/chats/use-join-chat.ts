import { useCallback, useState } from 'react';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { joinableTitle } from './chat-tree-model';

/**
 * Join a public chat (the Slack model): today's `addRoomMember` with the
 * viewer's own id, then read the list again and open the chat.
 */
export function useJoinChat(
  viewer: string | null | undefined,
  refresh: () => void,
  open: (roomId: string) => void,
  fail: (copy: string) => void,
) {
  const [joining, setJoining] = useState<string | null>(null);
  const join = useCallback(async (roomId: string, name: string) => {
    if (!viewer) return;
    setJoining(roomId);
    try {
      await monolithPhoneOperation('addRoomMember', { roomId, memberId: viewer });
      refresh();
      open(roomId);
    } catch (caught) {
      fail(appErrorCopy(caught, `Could not join ${joinableTitle(name)}.`));
    } finally {
      setJoining(null);
    }
  }, [fail, open, refresh, viewer]);
  return { joining, join };
}
