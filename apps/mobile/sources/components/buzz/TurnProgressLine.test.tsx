import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { TurnProgressLine, TurnSettledLine } from './TurnProgressLine';
vi.mock('tamagui', () => ({ XStack: 'XStack', YStack: 'YStack', ListItem: 'ListItem', ScrollView: 'ScrollView', Spinner: 'Spinner' }));
vi.mock('@/ui/grammar', () => ({ useStep: () => () => 8, T: (props: any) => React.createElement('T', props) }));
vi.mock('./TurnLineFrame', () => ({ TurnLineBar: (props: any) => React.createElement('Bar', props), TurnBandSlot: 'Slot' }));
vi.mock('./BeelineMarkSpinner', () => ({ BeelineMarkSpinner: () => React.createElement('Mark') }));

vi.mock('./IdentityMark', () => ({ IdentityMark: 'IdentityMark' }));
vi.mock('./Button', () => ({ Button: 'Button' }));

const texts = (renderer: any): unknown[] => renderer.root.findAllByType('T').map((node: any) => node.props.children);

it('wraps failure reasons and keeps Retry on the same baseline', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const retry = vi.fn(), stopPropagation = vi.fn(); let renderer: any;
  act(() => { renderer = create(<TurnSettledLine line={'Not sent: ' + 'A long server refusal. '.repeat(20)}
    leadingGlyph={false} inset={false} multiline action={{ label: 'Retry', onPress: retry }} testID="failed" />); });
  const line = renderer.root.find((node: any) => node.props.testID === 'failed-line');
  expect(line.props.numberOfLines).toBeUndefined();
  expect(line.props.flexShrink).toBe(1);
  const row = renderer.root.findAllByType('XStack')[0];
  expect(row.props.height).toBeUndefined();
  expect(row.props.alignItems).toBe('baseline');
  expect(line.props.children).toContain('A long server refusal.');
  expect(renderer.root.findAllByType('Mark')).toHaveLength(0);
  const action = renderer.root.find((node: any) => node.props.testID === 'failed-retry');
  expect(action.props.children).toBe('Retry');
  act(() => action.props.onPressIn({ stopPropagation }));
  act(() => action.props.onPress({ stopPropagation }));
  expect(stopPropagation).toHaveBeenCalledTimes(2); expect(retry).toHaveBeenCalledTimes(1);
  act(() => renderer.unmount());
});

it('keeps the existing settled-turn mark when no failure-line options are supplied', () => {
  let renderer: any; act(() => { renderer = create(<TurnSettledLine line="Finished" />); });
  expect(renderer.root.findAllByType('Mark')).toHaveLength(1);
  expect(texts(renderer)).toEqual(['Finished']);
  expect(renderer.root.findAllByType('T')[0].props.numberOfLines).toBe(1);
  act(() => renderer.unmount());
});

it('renders release preparation in the thinking line without scheduling an execution counter', () => {
  vi.useFakeTimers(); let renderer: any;
  try {
    act(() => { renderer = create(<TurnProgressLine label="Beebee · updating — downloading the new release…" testID="release" />); });
    expect(texts(renderer)).toContain('Beebee · updating — downloading the new release…');
    expect(renderer.root.findAll((node: any) => node.props.testID === 'release-elapsed')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally { act(() => renderer?.unmount()); vi.useRealTimers(); }
});

it('is one small line: a brass spinner, "Name thinking…" and a plain Stop', () => {
  const stop = vi.fn(); let renderer: any;
  act(() => { renderer = create(<TurnProgressLine label="Jimmy thinking…" onStop={stop} testID="turn" />); });
  expect(renderer.root.findByType('Spinner').props.color).toBe('needsYou');
  const label = renderer.root.find((node: any) => node.props.testID === 'turn-label');
  expect(label.props.children).toBe('Jimmy thinking…');
  expect(label.props.color).toBe('needsYou');
  const stopWord = renderer.root.find((node: any) => node.props.testID === 'turn-stop');
  expect(stopWord.props.children).toBe('Stop');
  act(() => stopWord.props.onPress());
  expect(stop).toHaveBeenCalledTimes(1);
  act(() => renderer.update(<TurnProgressLine label="Jimmy thinking…" onStop={stop} stopping testID="turn" />));
  expect(renderer.root.find((node: any) => node.props.testID === 'turn-stop').props.onPress).toBeUndefined();
  act(() => renderer.unmount());
});

it('shows nothing to press for someone who may not stop the turn', () => {
  let renderer: any;
  act(() => { renderer = create(<TurnProgressLine label="Jimmy · starting…" testID="turn" />); });
  expect(renderer.root.findAll((node: any) => node.props.testID === 'turn-stop')).toHaveLength(0);
  expect(texts(renderer)).toEqual(['Jimmy · starting…']);
  act(() => renderer.unmount());
});

const agents = ['Ruby', 'Jellybean', 'Grunt', 'Bee'].map((name, i) => ({pubkey: name, name, startedAt: 100 + i * 20, stop: {agentPubkey: name, requestId: `request-${i}`}}));
it('overlaps two avatars and exposes each elapsed counter and individual Stop on tap', async () => {
  vi.useFakeTimers(); vi.setSystemTime(200_000);
  const stop = vi.fn(async (_stop: {agentPubkey:string;requestId:string}) => true); let tree: any;
  try {
    act(() => { tree = create(<TurnProgressLine agents={agents.slice(0,2)} label="Ruby, Jellybean brewing…" startedAt={100} onStopAgent={stop} testID="group"/>); });
    expect(tree.root.findAllByType('IdentityMark')).toHaveLength(2);
    expect(tree.root.findByProps({testID:'stop-all-agents'}).props.label).toBe('Stop');
    act(() => tree.root.findByProps({testID:'working-agents-toggle'}).props.onPress());
    expect(tree.root.findByProps({testID:'stop-all-agents'}).props.label).toBe('Stop all');
    const list = tree.root.findByProps({testID:'working-agents-list'});
    expect(list.findAllByType('T').map((node:any)=>node.props.children)).toEqual(['Ruby','1m 40s','Jellybean','1m 20s']);
    await act(async () => tree.root.findByProps({testID:'stop-agent-Jellybean'}).props.onPress());
    expect(stop).toHaveBeenCalledExactlyOnceWith(agents[1].stop);
    expect(tree.root.findByProps({testID:'stop-agent-Jellybean'}).props.disabled).toBe(true);
    expect(tree.root.findByProps({testID:'stop-agent-Ruby'}).props.disabled).toBe(false);
    await act(async () => tree.root.findByProps({testID:'stop-all-agents'}).props.onPress());
    expect(stop.mock.calls.map(call=>call[0])).toEqual([agents[1].stop,agents[0].stop]);
  } finally { act(()=>tree?.unmount()); vi.useRealTimers(); }
});
it('caps four agents at three avatars, counts the remainder and retries a failed Stop', async () => {
  const stop = vi.fn(async () => false); let tree:any;
  act(() => { tree=create(<TurnProgressLine agents={agents} label="4 agents brewing…" onStopAgent={stop}/>); });
  expect(tree.root.findAllByType('IdentityMark')).toHaveLength(3);
  expect(texts(tree)).toContainEqual(['+',1]);
  act(() => tree.root.findByProps({testID:'working-agents-toggle'}).props.onPress());
  await act(async () => tree.root.findByProps({testID:'stop-agent-Bee'}).props.onPress());
  expect(tree.root.findByProps({testID:'stop-agent-Bee'}).props.disabled).toBe(false);
  act(()=>tree.unmount());
});
