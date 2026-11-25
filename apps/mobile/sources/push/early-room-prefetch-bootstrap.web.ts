import { getEffectiveRelayUrl, loadBuzzViewerPubkey } from '@/auth/buzz-identity-storage';
import { loadActiveCommunityId } from '@/buzz/community-storage';
import { readChatList } from '@/buzz/chat-list-store';
import { restoreStoredSurface, surfaceAddress } from '@/buzz/surface-storage';
import { isChatListView } from '@beeline/buzz-client';
import { prefetchPushRoom } from './push-room-prefetch';

// Start the landing route's scoped read while Expo Router mounts. The deck
// observes the same registry and the Room claims the same read as a list tap.
async function readLandingRoute() {
  if (typeof window === 'undefined' || !window.__beelineLaunchLive) return;
  const { pathname, searchParams } = new URL(window.location.href);
  const room = /^\/beeline\/chat\/([^/]+)\/?$/.exec(pathname);
  if (room) {
    const roomId = decodeURIComponent(room[1]!);
    prefetchPushRoom(searchParams.get('notificationResponseId') ?? `room-open:${roomId}`, roomId);
  } else if (pathname === '/' || pathname.replace(/\/$/, '') === '/beeline/channels') {
    const viewerPubkey = await loadBuzzViewerPubkey();
    if (!viewerPubkey) return;
    const workspaceId = searchParams.get('communityId') ?? await loadActiveCommunityId(viewerPubkey);
    if (!workspaceId) return;
    const relayUrl = await getEffectiveRelayUrl();
    const address = surfaceAddress(relayUrl, viewerPubkey, '/workspace/:id/chats', { workspaceId });
    if (!restoreStoredSurface(address, isChatListView))
      await readChatList({ relayUrl, viewerPubkey, workspaceId });
  }
}

void readLandingRoute().catch(() => {});
