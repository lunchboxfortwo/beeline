import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { VoiceCallState } from '@/buzz/use-voice-call';

vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { StyleSheet: { create: (value: unknown) => value }, Platform: { OS: 'android' }, View: host('View'), Text: host('Text'), Image: host('Image'),
    ScrollView: host('ScrollView'), Pressable: host('Pressable') };
});
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('./SurfaceGlyphLoader', () => ({ SurfaceGlyphLoader: 'View' }));
import { IdentityMark } from './IdentityMark';
import { VoiceAgentStrip, VoiceBar } from './VoiceBar';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('renders the same generated agent portrait as other IdentityMark surfaces', async () => {
  const agent = { pubkey: 'ruby', kind: 'agent' as const, name: 'Ruby', face: 'bat', avatar: 'https://proof/v1/agent-avatars/33333333-3333-4333-8333-333333333333' };
  const voice = { agents: [agent], target: null, speaker: null, aim: vi.fn() } as unknown as VoiceCallState;
  let tree: any;
  await act(async () => { tree = create(<>
    <VoiceAgentStrip voice={voice} />
    <IdentityMark kind="agent" seed={agent.pubkey} name={agent.name} face={agent.face} avatarUrl={agent.avatar} />
  </>); });
  try {
    const images = tree.root.findAll((node: any) => node.type === 'Image' && node.props.testID === 'generated-agent-avatar');
    expect(images).toHaveLength(2);
    expect(images[0].props.source).toEqual(images[1].props.source);
    expect(images[0].props.source.uri).toBe(agent.avatar);
  } finally { await act(async () => tree.unmount()); }
});

it('pins with the brass badge, unpins from the same chip, and ends the call from the bar', async () => {
  const agents = [
    { pubkey: 'alan', kind: 'agent' as const, name: 'Alan', face: 'fox' },
    { pubkey: 'jimmy', kind: 'agent' as const, name: 'Jimmy', face: 'owl' },
  ];
  const voice = { agents, target: 'alan', speaker: null, muted: false, humans: 1, connecting: false,
    aim: vi.fn(), toggleMute: vi.fn(), end: vi.fn() } as unknown as VoiceCallState;
  let tree: any;
  await act(async () => { tree = create(<><VoiceAgentStrip voice={voice} /><VoiceBar voice={voice} /></>); });
  try {
    const chip = (label: string) => tree.root.find((node: any) => node.type === 'Button' && node.props['aria-label'] === label);
    expect(tree.root.findAll((node: any) => node.type === 'YStack' && node.props?.testID === 'voice-pin-alan')).toHaveLength(1);
    expect(tree.root.findAll((node: any) => node.type === 'YStack' && node.props?.testID === 'voice-pin-jimmy')).toHaveLength(0);
    chip('Unpin Alan').props.onPress();
    expect(voice.aim).toHaveBeenCalledWith('alan');
    chip('Speak to Jimmy').props.onPress();
    expect(voice.aim).toHaveBeenCalledWith('jimmy');
    const status = tree.root.find((node: any) => node.type === 'XStack' && node.props.testID === 'voice-waveform');
    expect(status.props['aria-label']).toBe('Listening');
    chip('Mute microphone').props.onPress();
    expect(voice.toggleMute).toHaveBeenCalled();
    chip('End call').props.onPress();
    expect(voice.end).toHaveBeenCalled();
  } finally { await act(async () => tree.unmount()); }
});
