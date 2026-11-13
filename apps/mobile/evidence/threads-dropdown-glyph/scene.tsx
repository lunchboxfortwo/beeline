import React from 'react';
import { createRoot } from 'react-dom/client';
import { TamaguiProvider, Theme, YStack, XStack } from 'tamagui';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { tamaguiConfig } from '../../sources/ui/tamagui.config';
import { Copy } from '../../sources/ui/grammar';
import { RepositoryMark } from '../../sources/components/buzz/RepositoryMark';
import { ThreadsDropdown } from '../../sources/ui/screens/chat/ThreadsDropdown';
import avatar from '../../sources/assets/images/icon.png';
const theme = new URLSearchParams(location.search).get('theme') ?? 'dark_brass';
createRoot(document.getElementById('root')!).render(
 <SafeAreaProvider><TamaguiProvider config={tamaguiConfig} defaultTheme={theme}><Theme name={theme}>
  <YStack minHeight="100vh" backgroundColor="canvas" paddingTop="6">
   <XStack padding="4" gap="3" alignItems="center" testID="room-header"><RepositoryMark avatarUrl={avatar}/><YStack><Copy strong>#beeline</Copy><Copy small quiet>Beeline project</Copy></YStack></XStack>
   <ThreadsDropdown roomId="beeline" chatName="beeline" openThread={()=>{}} {...{repositoryAvatar:avatar,repositoryFavicon:avatar}}/>
   <YStack padding="4" gap="3"><Copy small quiet>Today</Copy><Copy>Threads keep their own glyph. The Room keeps its project avatar.</Copy></YStack>
  </YStack>
 </Theme></TamaguiProvider></SafeAreaProvider>
);
