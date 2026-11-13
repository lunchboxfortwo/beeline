// Controlled send and history proof entry for the one-artifact-card change. Not imported
// by the shipped app. It sends a picked image through the production hook,
// composer and row, then projects a history DTO without decoration.
// Run through Expo web; see
// README.md.
import 'react-native-get-random-values';
import '@/polyfills/arrayFindLast';
import * as SplashScreen from 'expo-splash-screen';
import * as Font from 'expo-font';
import { Asset } from 'expo-asset';
import React, { useEffect, useState, useRef } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { registerRootComponent } from 'expo';
import { ExpoRoot } from 'expo-router';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { beelineThemes } from '@/buzz/groknight';
import { setAppDisplay, useAppMode } from '@/display';
import { T } from '@/ui/grammar';
import { GrammarProvider } from '@/ui/GrammarProvider';
import { useChatComposerSend } from '@/app/(app)/beeline/chat/useChatComposerSend';
import { ChatSurfaceComposer } from '@/app/(app)/beeline/chat/ChatSurfaceComposer';
import { OrdinaryLedgerMessage } from '@/app/(app)/beeline/chat/RoomMessageVariants-ordinary-ledger-message';
import { displayRoomMessage, type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { observeArtifactRows, setArtifactViewportActive } from '@/buzz/artifact-viewport';
import { monolithSession } from '@/auth/monolith-session';
import { LiveConnection } from '@/sync/transport/live-connection';
import type { AttachmentReference } from '@beeline/buzz-client';

StyleSheet.configure({
  themes: {
    bone: { buzz: beelineThemes.bone, dark: false },
    obsidian: { buzz: beelineThemes.obsidian, dark: true },
  },
  settings: { initialTheme: 'bone' as never },
});

setAppDisplay('light');

// Controlled transport boundary; production send, composer, row, card and image
// byte owner remain in the bundle. No real account or production write is used.
const no = () => undefined;
const id = '11111111-1111-4111-8111-111111111111';
const viewer = 'a'.repeat(64);
const imageUrl = require('./shot.png');
let releaseUpload: () => void = no;
const uploaded = new Promise<void>(resolve => { releaseUpload = resolve; });
const picked = { uri: 'file:///shot.png', name: 'shot.png', mimeType: 'image/png', size: 14936, source: 'photo' as const };
const file: AttachmentReference = { url: `/v1/media/${id}`, name: picked.name, mimeType: picked.mimeType, size: picked.size };
monolithSession.identityId = async () => viewer;
monolithSession.fetch = async () => {
  const uri = Asset.fromModule(imageUrl).uri;
  return fetch(uri);
};
LiveConnection.prototype.request = (async (name: string) => {
  if (name === 'readMediaMetadata') return { objectId: id, sha256: '7599e91176e143dacc92c06ba5c38c5805ddd1abcb0b2addb6a145885ebf0351', mimeType: file.mimeType, size: file.size, expiresAt: Date.now() + 3600000 };
  if (name === 'reportDiagnostics') return {};
  throw new Error(`Unexpected proof operation: ${name}`);
}) as LiveConnection['request'];
setArtifactViewportActive('ONE-SHAPE', true);

function Proof() {
  const mode = useAppMode();
  const [phase, setPhase] = useState('picked');
  const [messages, setMessages] = useState<ChatDisplayMessage[]>([]);
  const [pendingAttachments, setAttachments] = useState([picked]);
  const [sending, setSending] = useState(false);
  const [height, setHeight] = useState(26);
  const [text, setText] = useState('');
  const draft = useRef({ value: '', captureMessage: () => () => true }).current;
  const input = useRef('');
  const inFlight = useRef(false);
  const composerRef = useRef(null);
  const revision = useRef(0);
  const pendingRef = useRef(pendingAttachments); pendingRef.current = pendingAttachments;
  const add = (rows: readonly ChatDisplayMessage[]) => setMessages(current => [...current.filter(message => !rows.some(row => row.id === message.id)), ...rows]);
  const remove = (id: string) => setMessages(current => current.filter(message => message.id !== id));
  const transport = {
    ensureClient: async () => ({}),
    composeMessage: async () => ({ id: 'signed-message', created_at: 100 }),
    readHistory: async () => [{ id: 'signed-message', text: '', createdAt: 100,
      author: { pubkey: viewer, kind: 'human' as const, name: 'Kai' },
      presentation: 'message' as const, attachments: [{ ...file }] }],
  };
  const uploader = {
    state: () => undefined, subscribe: () => no, start: no, retain: no,
    uploadAll: async () => { setPhase('sending'); await uploaded; return [file]; },
  };
  const outbox = {
    enqueue: async () => undefined, get: () => true,
    send: async () => {
      const message = { id: 'signed-message', text: '', isUser: true, pubkey: viewer, timestamp: 100, attachments: [{ ...file, kind: 'artifact' as const }] };
      add([message]); setPhase('settled'); return {};
    },
  };
  const args = [draft, input, null, pendingRef, inFlight, false,
    [], { current: new Map() }, () => no, { current: new Map() }, [], false,
    { current: () => outbox }, true, no, no, setSending, false, no, { viewer: { identity: { pubkey: viewer, kind: 'human', name: 'Kai' } } }, viewer,
    { remove: no }, { request: no }, no, add, true, null, false, null, no, null, [], transport, null, no,
    remove, uploader, 'room',
    (from: string, to: string) => setMessages(current => current.map(message => message.id === from ? { ...message, id: to } : message)),
    { current: draft }, revision, composerRef, no, setHeight, no, setAttachments, no, no, no, null,
    no, () => true, undefined, viewer, undefined, {}, 0, {}, new Map(), no, no];
  const [send] = useChatComposerSend(args as unknown as Parameters<typeof useChatComposerSend>[0]);
  useEffect(() => { observeArtifactRows('ONE-SHAPE', messages.map(message => message.id)); }, [messages]);
  useEffect(() => { void SplashScreen.hideAsync(); }, []);
  useEffect(() => { UnistylesRuntime.setTheme((mode === 'dark' ? 'obsidian' : 'bone') as never); }, [mode]);
  const composerProps = {
    desktopExperience: false, pendingAttachments, sending, attachmentUploader: uploader,
    composerTagHandles: new Set(), voice: {}, roomSurface: { members: [], room: { name: 'one-shape' } },
    composerInputRevisionRef: revision, composerInputRevision: 0, composerRef,
    composerHeight: height, setComposerHeight: setHeight, inputText: text, inputTextRef: input,
    setInputText: setText, setInputSelection: no, handleSend: send,
    replacePendingAttachments: setAttachments, isDirectMessage: true,
  } as unknown as React.ComponentProps<typeof ChatSurfaceComposer>;
  return <View style={{ flex: 1 }}>
    <View style={{ padding: 16, gap: 8 }}>
      <T testID="proof-phase">ONE-SHAPE · {mode} · {phase}</T>
      <Pressable onPress={() => setAppDisplay(mode === 'dark' ? 'light' : 'dark')}><T>Switch theme</T></Pressable>
      <Pressable onPress={() => releaseUpload()}><T>Resolve upload</T></Pressable>
      <Pressable onPress={async () => {
        // Controlled history DTO deliberately lacks all artifact decoration.
        setMessages((await transport.readHistory()).map(row => displayRoomMessage(row, viewer)));
        setPhase('refreshed without decoration');
      }}><T>Refresh history without decoration</T></Pressable>
    </View>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      {messages.map(message => <OrdinaryLedgerMessage key={message.id} message={message}
        viewerPubkey={viewer} personName="Kai" participantsHydrated speakerWorking={false}
        continued={false} firstBylineOfDay={false} participantHandles={[]}
        channelIndex={{ rooms: [], corners: [] }} deliveryFailed={false}
        onChannelReference={no} onReply={no} onCopy={no} onDismiss={no} />)}
    </ScrollView>
    <ChatSurfaceComposer {...composerProps} />
  </View>;
}

function Root() {
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    void Font.loadAsync({
      'SpaceGrotesk-Regular': require('@/assets/fonts/SpaceGrotesk-Regular.ttf'),
      'SpaceGrotesk-Medium': require('@/assets/fonts/SpaceGrotesk-Medium.ttf'),
      'SpaceGrotesk-SemiBold': require('@/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
      'IBMPlexMono-Regular': require('@/assets/fonts/IBMPlexMono-Regular.ttf'),
    }).then(() => setFontsReady(true));
  }, []);
  if (!fontsReady) return <View style={{ flex: 1, backgroundColor: '#FAFAF9' }} />;
  return <GrammarProvider><Proof /></GrammarProvider>;
}

const context = Object.assign(() => ({ default: Root }), {
  keys: () => ['./index.tsx'], resolve: (key: string) => key, id: 'ONE-SHAPE',
});
registerRootComponent(() => <ExpoRoot context={context as never} />);
