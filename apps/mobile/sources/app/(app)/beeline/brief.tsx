import React from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { BriefScreen } from '@/ui/screens/thread/BriefScreen';

/** The thread's brief on a phone; desktop opens the same screen in the right panel. */
export default function BriefRoute() {
  useLatencyRouteFrame('/beeline/brief');
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const close = () => {
    if (router.canGoBack()) router.back();
    else if (roomId) router.replace({ pathname: '/beeline/chat/[channelId]', params: { channelId: roomId } } as never);
    else router.replace('/beeline/channels' as never);
  };
  return <BriefScreen roomId={roomId ?? ''} close={close} />;
}
