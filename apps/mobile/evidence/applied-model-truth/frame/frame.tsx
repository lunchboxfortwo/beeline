// Proof frame: the production Members screen and agent profile, fed with the
// views the server returns for Emberus before and after this change.
import React from 'react';
// @ts-expect-error Standalone browser frame uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { TamaguiProvider, Theme, YStack, XStack } from 'tamagui';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { tamaguiConfig, themeName } from '@/ui/tamagui.config';
import { MembersScreen } from '@/ui/screens/members/MembersScreen';
import { AgentProfileScreen } from '@/ui/screens/profiles/AgentProfileScreen';
import { fixture } from './data';

const params = new URLSearchParams(location.search);
const mode = params.get('theme') === 'bone' ? 'light' : 'dark';
const name = themeName(mode, 'brass');
(globalThis as any).__frame = fixture(params.get('state') === 'after');
const page = params.get('page') ?? 'both';
createRoot(document.getElementById('root')!).render(
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 1280, height: 900 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
  <TamaguiProvider config={tamaguiConfig} defaultTheme={name}>
    <Theme name={name}>
      <XStack backgroundColor="$background" minHeight="100vh" flexWrap="wrap">
        {page !== 'profile' ? <YStack flex={1} minWidth={360} height="100vh"><MembersScreen roomId="room" close={() => {}} /></YStack> : null}
        {page !== 'members' ? <YStack flex={1} minWidth={360} height="100vh"><AgentProfileScreen agentId="emberus" workspaceId="w" close={() => {}} /></YStack> : null}
      </XStack>
    </Theme>
  </TamaguiProvider>
  </SafeAreaProvider>,
);
