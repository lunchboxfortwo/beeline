/** Room route: header, transcript, and composer are the open, not a last-message pixel. */
import React, { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { ParamListBase } from '@react-navigation/native';
import { roomTransitionWork } from '@/buzz/room-transition-work';
import { useLocalSearchParams } from 'expo-router';
import { markRoomOpen } from '@/buzz/room-open-trace';
import { RoomPresentationContext } from '@/buzz/room-presentation-context';
import { RoomOpenTraceOverlay } from '@/components/buzz/RoomOpenTraceOverlay';
import type { NotificationAnchor } from './useChatRoute';
import { BuzzChatSurface } from './_chat-surface';
import {
  useRoomSurfaceSession,
  type RoomSurfaceSessionBindings,
} from './useRoomSurfaceSession';

const RoomSurface = memo(function RoomSurface(props: React.ComponentProps<typeof BuzzChatSurface>) {
  return <BuzzChatSurface {...props} />;
}, (previous, next) =>
  previous.anchor === next.anchor &&
  previous.bindingsRef === next.bindingsRef &&
  (Object.keys(previous.session) as Array<keyof typeof previous.session>).every(
    (key) => Object.is(previous.session[key], next.session[key]),
  ));

export default function BuzzChat() {
  const { channelId, notificationResponseId, notificationMessageId, notificationTarget } =
    useLocalSearchParams<NotificationAnchor & { channelId: string }>();
  const anchor = useMemo(() => ({ notificationResponseId, notificationMessageId, notificationTarget }),
    [notificationResponseId, notificationMessageId, notificationTarget]);
  const decodedId = channelId ? decodeURIComponent(channelId) : '';
  // Expo can reuse this route when a deep link replaces only its parameters.
  // The session refs, transcript window and composer must belong to one Room.
  return (
    <RoomVisit
      key={decodedId}
      channelId={decodedId}
      anchor={anchor}
    />
  );
}

function RoomVisit({
  channelId: decodedId,
  anchor,
}: {
  channelId: string;
  anchor: NotificationAnchor;
}) {
  const isFocused = useIsFocused();
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  useLayoutEffect(() => {
    let finish: (() => void) | undefined;
    const start = navigation.addListener('transitionStart', () => {
      finish ??= roomTransitionWork.begin();
    });
    const end = navigation.addListener('transitionEnd', () => {
      finish?.();
      finish = undefined;
    });
    return () => {
      start();
      end();
      finish?.();
    };
  }, [navigation]);
  const bindingsRef = useRef<RoomSurfaceSessionBindings>({
    resetTranscript: () => undefined,
    restoreOutboxMessages: () => undefined,
    dismissOptimisticMessage: () => undefined,
    observeRoomSurface: () => undefined,
  });

  useLayoutEffect(() => {
    if (!isFocused || !decodedId) return;
    markRoomOpen('route-mount', decodedId);
  }, [decodedId, isFocused]);

  const session = useRoomSurfaceSession({
    channelId: decodedId,
    isFocused,
    notificationResponseId: anchor.notificationResponseId,
    bindingsRef,
  });

  return (
    <RoomPresentationContext.Provider value={session.liveDraftStore}>
      <RoomSurface anchor={anchor} session={session} bindingsRef={bindingsRef} />
      <RoomOpenTraceOverlay />
    </RoomPresentationContext.Provider>
  );
}
