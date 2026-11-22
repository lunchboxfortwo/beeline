// Plain choice cards proof: the real ChoiceCard (this branch), fed synthetic
// gate rows through the real phone projection (readRoomViewMessage ->
// displayRoomMessage), in the real Tamagui themes and fonts.
// Panel "open" is a gate card stored the old way, with a `consequence` on each
// option. Tapping a choice answers it in place and shows the answered card.
// Web: ?theme=obsidian|bone.
import '../../sources/polyfills/usePressability';
import React, { useEffect, useState } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import { registerRootComponent } from 'expo';
import * as Fonts from 'expo-font';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { TamaguiProvider, Theme, YStack } from 'tamagui';
import { readRoomViewMessage, type ChoiceCardView } from '@beeline/api-contract/phone';
import { tamaguiConfig, themeName } from '@/ui/tamagui.config';
import { displayRoomMessage } from '@/buzz/room-view-presentation';
import { ChoiceCard } from '@/app/(app)/beeline/chat/RoomMessageVariants';

const query = Platform.OS === 'web' ? new URLSearchParams(globalThis.location?.search ?? '') : new URLSearchParams();
const OWNER = '3'.repeat(64);
const agent = { pubkey: 'c'.repeat(64), kind: 'agent' as const, name: 'Ruby', handle: 'ruby', face: 'owl' };
const prompt = "Approve fixes from today's card?";
const createdAt = Math.floor(Date.parse('2026-11-23T09:06:00Z') / 1000);

// Stored before this change: each option still carries a `consequence`.
const storedOpen = {
  choiceId: '4d946fe7-10f6-494e-8314-8e5dfea4c182', mode: 'question', status: 'open', agent, prompt,
  ask: prompt, runId: 'a'.repeat(64),
  options: [
    { optionId: 'A', letter: 'A', label: 'approve_all', consequence: 'Open one fix thread per same-area bundle for every actionable card item.' },
    { optionId: 'B', letter: 'B', label: 'not_now', consequence: "The card's approvals are settled." },
  ],
  electorate: [OWNER], electorateCount: 1, votedCount: 0, responses: [],
};

function row(choice: Record<string, unknown>, id: string) {
  const dto = readRoomViewMessage({
    id, text: `@ruby asked ${prompt}`, presentation: 'card', createdAt, author: agent, choice,
    systemEvent: { kind: 'choice', verb: 'asked', subject: { id: agent.pubkey, kind: 'agent', name: 'Ruby' }, object: { text: prompt } },
  });
  if (!dto) throw new Error('the stored card did not read');
  return displayRoomMessage(dto, OWNER);
}

function answered(card: ChoiceCardView, optionId: string): Record<string, unknown> {
  return { ...card, status: 'answered', selectedOptionId: optionId,
    answeredBy: { pubkey: OWNER, kind: 'human', name: 'lunchboxfortwo', handle: 'lunchboxfortwo' },
    footer: `picked ${optionId} · @lunchboxfortwo`, responses: [{ identityId: OWNER, optionId }], votedCount: 1 };
}

function Label({ children }: { children: string }) {
  return <Text allowFontScaling={false} style={{ color: '#888', fontSize: 12, paddingHorizontal: 16, paddingTop: 16 }}>{children}</Text>;
}

function TapCard() {
  const [picked, setPicked] = useState<string | null>(null);
  const open = row(storedOpen, 'e'.repeat(64));
  const message = picked ? row(answered(open.choice!, picked), 'e'.repeat(64)) : open;
  return (
    <View testID={picked ? 'tap-answered' : 'tap-open'}>
      <ChoiceCard message={message} viewerIsAgent={false} viewerPubkey={OWNER} actionId={null}
        onAnswer={(_choiceId, optionId) => setPicked(optionId)} />
    </View>
  );
}

function Root() {
  const [ready, setReady] = useState(false);
  const dark = query.get('theme') === 'obsidian';
  useEffect(() => {
    Fonts.loadAsync({
      'IBMPlexMono-Regular': require('../../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
      'SpaceGrotesk-Regular': require('../../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
      'SpaceGrotesk-Medium': require('../../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
      'SpaceGrotesk-SemiBold': require('../../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    }).then(() => setReady(true));
  }, []);
  if (!ready) return null;
  const name = themeName(dark ? 'dark' : 'light', 'brass');
  const open = row(storedOpen, 'd'.repeat(64));
  const done = row(answered(open.choice!, 'A'), 'f'.repeat(64));
  return (
    <SafeAreaProvider>
      <TamaguiProvider config={tamaguiConfig} defaultTheme={name}>
        <Theme name={name}>
          <YStack flex={1} backgroundColor="canvas">
            <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24 }}>
              <Label>{`${dark ? 'Obsidian' : 'Bone'} · 1 · open gate (stored with consequence)`}</Label>
              <View testID="open"><ChoiceCard message={open} viewerIsAgent={false} viewerPubkey={OWNER} actionId={null} onAnswer={() => {}} /></View>
              <Label>{`${dark ? 'Obsidian' : 'Bone'} · 2 · answered`}</Label>
              <View testID="answered"><ChoiceCard message={done} viewerIsAgent={false} viewerPubkey={OWNER} actionId={null} onAnswer={() => {}} /></View>
              <Label>{`${dark ? 'Obsidian' : 'Bone'} · 3 · tap a choice`}</Label>
              <TapCard />
            </ScrollView>
          </YStack>
        </Theme>
      </TamaguiProvider>
    </SafeAreaProvider>
  );
}

registerRootComponent(Root);
