import React from 'react';
import { createRoot } from 'react-dom/client';
import { TamaguiProvider, Theme, YStack, XStack } from 'tamagui';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { tamaguiConfig } from '../../sources/ui/tamagui.config';
import { T } from '../../sources/ui/grammar';
import { ThreadBar, ThreadTitleBlock } from '../../sources/ui/screens/thread/ThreadHeader';
import { ThreadLine } from '../../sources/ui/screens/thread/ThreadLine';
import { TurnProgressLine } from '../../sources/components/buzz/TurnProgressLine';
import { TurnStepsLine } from '../../sources/components/buzz/ActivityTimeline';
const params = new URLSearchParams(location.search);
const theme = params.get('theme') ?? 'dark_brass';
const after = params.get('version') === 'after';
const h = { chatTag: '#beeline', title: 'live-turn-status', state: after ? 'working' as const : 'idle' as const,
  ...(after ? { workingAgentName: 'Ruby' } : {}), objective: 'Keep agent work visible until the session ends.' };
function Scene() {
  const [steps, setSteps] = React.useState(after ? 2 : 0);
  (globalThis as any).finishStep = () => setSteps(n => n + 1);
  return <SafeAreaProvider><TamaguiProvider config={tamaguiConfig} defaultTheme={theme}><Theme name={theme}>
    <YStack minHeight="100vh" backgroundColor="canvas">
      <ThreadBar h={h} collapsed openChat={() => {}} safeTop={false} />
      <YStack width="100%" maxWidth={720} alignSelf="center" flex={1}>
        <ThreadTitleBlock h={h} />
        <YStack padding="4" gap="4" flex={1}>
          <YStack gap="1"><T v="meta" color="secondary">lunchboxfortwo</T><T v="body">Keep showing that the agent is working.</T></YStack>
          <YStack gap="1"><T v="meta" color="secondary">Ruby</T><T v="body">The reply is posted. I’m checking the remaining changes.</T>
            <TurnStepsLine testID="live-steps" items={Array.from({ length: steps }, (_, i) => ({ kind: 'tool' as const,
              id: `step-${i}`, title: ['Read source', 'Run checks', 'Check result'][i] ?? 'Read result', toolKind: 'read', status: 'completed' }))} />
          </YStack>
        </YStack>
        {after ? <TurnProgressLine label="Ruby is working" startedAt={1} testID="working-line" /> : null}
        <YStack margin="4" padding="3" borderWidth={1} borderColor="stroke" borderRadius="sm"><T v="body" color="secondary">Message #beeline</T></YStack>
        <YStack padding="4" borderTopWidth={1} borderColor="stroke"><T v="meta" color="secondary">Threads</T>
          <ThreadLine title="live-turn-status" state={after ? "working" : "idle"} workingAgentName={after ? 'Ruby' : undefined} onPress={() => {}} testID="thread-row" />
        </YStack>
      </YStack>
    </YStack>
  </Theme></TamaguiProvider></SafeAreaProvider>;
}
createRoot(document.getElementById('root')!).render(<Scene />);
