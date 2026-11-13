import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useEffect, useRef, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { YStack } from 'tamagui';
import { CornerDownRight, Plus } from 'lucide-react-native';
import { cornerShortTitle, roomTitle } from '@beeline/api-contract/phone';
import { loadBuzzIdentity, peekBuzzViewerContext } from '@/auth/buzz-identity-storage';
import { CORNER_LABEL } from '@/buzz/vocabulary';
import { CornerOpenRow } from '@/components/buzz/CornerOpenToast';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { BuzzRigTransport } from '@/sync/transport';
import { cornerHref, roomHref } from '@/buzz/corner-navigation';
import { openRoomListCorner } from '@/buzz/room-list-new-corner';
import type { CornerOpenAttempt } from '@/buzz/open-random-corner';
import { phoneOperationFailureReason } from '@/sync/transport/monolith-operation';
import { Modal } from '@/modal';
import { useRoomCorners } from '@/buzz/use-room-corners';
import { Btn, Copy, Glyph, Screen } from '@/ui/grammar';
import { ThreadLine } from '@/ui/screens/thread/ThreadLine';

/**
 * A chat's active threads on their own page. Reached from older links,
 * notification stacks and `/corners`; the chat's "Threads · N active"
 * drop-down is the everyday way in, and finished threads live in chat info.
 */
export default function BuzzCorners() {
  useLatencyRouteFrame('/beeline/corners/[roomId]');
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const decodedId = roomId ? decodeURIComponent(roomId) : '';
  // The Room's one corner record: rows the Room lane already heard paint with no read.
  const corners = useRoomCorners(decodedId || undefined);
  const surface = corners.view ?? null;
  useLatencyRouteFrame('/beeline/corners/[roomId]', surface !== null, true);
  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    void loadBuzzIdentity().then((identity) => {
      if (!identity) router.replace('/beeline/onboarding');
    });
  }, []);

  const name = surface?.room.name ?? null;
  const title = name ? (roomTitle(name) ?? name) : 'Threads';
  const back = () => {
    if (router.canGoBack()) router.back();
    else if (decodedId) router.replace(roomHref(decodedId));
    else router.replace('/beeline/channels');
  };

  const createCorner = async (attempt?: CornerOpenAttempt) => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      const identity = await loadBuzzIdentity();
      if (!identity) throw new Error('Beeline identity is unavailable');
      await openRoomListCorner({
        roomId: decodedId,
        attempt,
        createCorner: (parentId, cornerTitle, cornerId) =>
          new BuzzRigTransport(identity).createHumanCorner(parentId, cornerTitle, undefined, true, cornerId),
        openCorner: (cornerId, cornerTitle) =>
          router.push(cornerHref(cornerId, decodedId, cornerTitle, 'corners')),
        retry: (failed) => void createCorner(failed),
      });
    } catch (reason) {
      Modal.alert(`Could not open ${CORNER_LABEL}`, phoneOperationFailureReason(reason));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const rows = corners.openRows;
  const viewer = peekBuzzViewerContext()?.viewerPubkey;
  const more = corners.record?.nextOpen ? Math.max(0, (corners.record.summary?.cornerCount ?? 0) - rows.length) : 0;
  return (
    <Screen
      title={name ? `${title} · Threads` : title}
      back={back}
      testID="room-corners"
      right={surface ? (
        <Btn kind="icon" label={`New ${CORNER_LABEL}`} disabled={creating} onPress={() => void createCorner()} testID="room-corners-new">
          <Glyph icon={Plus} />
        </Btn>
      ) : undefined}
    >
      <CornerOpenRow roomId={decodedId} />
      {!surface && !corners.error ? <SurfaceGlyphLoader testID="changes-loader" /> : null}
      {corners.error ? <Copy quiet testID="room-corners-error">{corners.error}</Copy> : null}
      {surface ? (
        <YStack testID="room-corners-list">
          {rows.map((row) => (
            <ThreadLine avatarUrl={row.corner.avatar} faviconUrl={row.corner.favicon} key={row.corner.id} title={cornerShortTitle(name, row.corner.name, row.corner.id)} state={row.state}
              blocker={row.blocker} reason={row.reason} viewer={viewer}
              onPress={() => router.push(cornerHref(row.corner.id, decodedId, row.corner.name, 'corners'))}
              testID={`thread-row-${row.corner.id}`} />
          ))}
          {corners.record?.nextOpen ? (
            <Btn kind="quiet" label="More threads" justifyContent="flex-start" gap="2"
              onPress={() => void corners.loadMoreOpen()} testID="room-corners-more">
              <Glyph icon={CornerDownRight} size={16} />
              <Copy small quiet>{more ? `${more} more` : 'More'}</Copy>
            </Btn>
          ) : null}
        </YStack>
      ) : null}
    </Screen>
  );
}
