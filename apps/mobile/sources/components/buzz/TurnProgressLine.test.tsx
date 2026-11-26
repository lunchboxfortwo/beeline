import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { TurnProgressLine, TurnSettledLine } from './TurnProgressLine';
vi.mock('tamagui', () => ({ XStack: 'XStack', YStack: 'YStack', ListItem: 'ListItem', ScrollView: 'ScrollView' }));
vi.mock('@/ui/grammar', () => ({ useStep: () => () => 8, T: (props: any) => React.createElement('T', props), Spinner: 'Spinner' }));
vi.mock('./TurnLineFrame', () => ({ TurnLineBar: (props: any) => React.createElement('Bar', props), TurnBandSlot: 'Slot' }));

vi.mock('./IdentityMark', () => ({ IdentityMark: 'IdentityMark' }));
vi.mock('./Button', () => ({ Button: 'Button' }));

const texts = (renderer: any): unknown[] => renderer.root.findAllByType('T').map((node: any) => node.props.children);

it('wraps failure reasons and keeps Retry on the same baseline', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const retry = vi.fn(), stopPropagation = vi.fn(); let renderer: any;
  act(() => { renderer = create(<TurnSettledLine line={'Not sent: ' + 'A long server refusal. '.repeat(20)}
    inset={false} multiline action={{ label: 'Retry', onPress: retry }} testID="failed" />); });
  const line = renderer.root.find((node: any) => node.props.testID === 'failed-line');
  expect(line.props.numberOfLines).toBeUndefined();
  expect(line.props.flexShrink).toBe(1);
  const row = renderer.root.findAllByType('XStack')[0];
  expect(row.props.height).toBeUndefined();
  expect(row.props.alignItems).toBe('baseline');
  expect(line.props.children).toContain('A long server refusal.');
  expect(renderer.root.findAllByType('Spinner')).toHaveLength(0);
  const action = renderer.root.find((node: any) => node.props.testID === 'failed-retry');
  expect(action.props.children).toBe('Retry');
  act(() => action.props.onPressIn({ stopPropagation }));
  act(() => action.props.onPress({ stopPropagation }));
  expect(stopPropagation).toHaveBeenCalledTimes(2); expect(retry).toHaveBeenCalledTimes(1);
  act(() => renderer.unmount());
});

it('leaves a finished turn without a mark: the words say it', () => {
  let renderer: any; act(() => { renderer = create(<TurnSettledLine line="Finished" />); });
  expect(renderer.root.findAllByType('Spinner')).toHaveLength(0);
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

it('is one small line: the ring spinner, "Name thinking…" and a plain Stop', () => {
  const stop = vi.fn(); let renderer: any;
  act(() => { renderer = create(<TurnProgressLine label="Jimmy thinking…" onStop={stop} testID="turn" />); });
  expect(renderer.root.findByType('Spinner').props.testID).toBe('turn-glyph');
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
it.each([0, 1, 3])('keeps the spinner and agent avatars together for %i working agents', (count) => {
  let tree: any;
  act(() => { tree = create(<TurnProgressLine agents={agents.slice(0, count)} label="Working…" />); });
  expect(tree.root.findAllByType('Spinner')).toHaveLength(1);
  expect(tree.root.findAllByType('IdentityMark')).toHaveLength(count);
  act(() => tree.unmount());
});

it.each([1, 2, 3, 4])('keeps full-size avatar wrappers and the compact footprint for %i working agents', (count) => {
  let tree: any;
  act(() => { tree = create(<TurnProgressLine agents={agents.slice(0, count)} label="Working…" />); });
  try {
    const marks = tree.root.findAllByType('IdentityMark');
    expect(marks.map((mark: any) => mark.props.seed)).toEqual(agents.slice(0, Math.min(count, 3)).map(agent => agent.pubkey));
    marks.forEach((mark: any, index: number) => {
      expect(mark.props.size).toBe(20);
      expect(mark.parent.props).toMatchObject({
        position: 'relative',
        zIndex: index,
        width: 24,
        height: 24,
        flexShrink: 0,
        marginLeft: index === 0 ? 0 : -8,
        backgroundColor: 'canvas',
        borderWidth: 2,
        borderColor: 'canvas',
        borderRadius: 'md',
      });
    });
    if (count > 3) {
      const stack = marks[2].parent.parent;
      expect(stack.children.slice(0, 3)).toEqual(marks.map((mark: any) => mark.parent));
      expect(stack.children[3].props).toMatchObject({ children: ['+', 1], marginLeft: '1' });
    }
  } finally {
    act(() => tree.unmount());
  }
});

it('exposes each elapsed counter and individual Stop on tap', async () => {
  vi.useFakeTimers(); vi.setSystemTime(200_000);
  const stop = vi.fn(async (_stop: {agentPubkey:string;requestId:string}) => true); let tree: any;
  try {
    act(() => { tree = create(<TurnProgressLine agents={agents.slice(0,2)} label="Ruby, Jellybean brewing…" startedAt={100} onStopAgent={stop} testID="group"/>); });
    expect(tree.root.findAllByType('IdentityMark')).toHaveLength(2);
    expect(tree.root.findByProps({testID:'stop-all-agents'}).props.label).toBe('Stop');
    const groupStop = tree.root.findByProps({testID:'stop-all-agents'});
    expect(groupStop.props.accessibilityLabel).toBe('Choose an agent to stop');
    act(() => groupStop.props.onPress());
    expect(stop).not.toHaveBeenCalled();
    expect(tree.root.findByProps({testID:'stop-all-agents'}).props.accessibilityLabel).toBe('Stop all working agents');
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

it('toggles the picker from the names and stops a single remaining agent directly', () => {
  const stopGroupAgent = vi.fn();
  const stopRemaining = vi.fn();
  let tree: any;
  act(() => { tree = create(<TurnProgressLine agents={agents} label="Working…" onStopAgent={stopGroupAgent} />); });

  const toggle = tree.root.findByProps({ testID: 'working-agents-toggle' });
  act(() => toggle.props.onPress());
  expect(toggle.props['aria-expanded']).toBe(true);
  act(() => toggle.props.onPress());
  expect(tree.root.findAllByProps({ testID: 'working-agents-list' })).toHaveLength(0);
  act(() => toggle.props.onPress());
  act(() => tree.update(<TurnProgressLine agents={agents.slice(0, 1)} label="Ruby working…"
    onStop={stopRemaining} onStopAgent={stopGroupAgent} testID="turn" />));
  expect(tree.root.findAllByProps({ testID: 'working-agents-list' })).toHaveLength(0);
  expect(tree.root.findAllByProps({ testID: 'stop-all-agents' })).toHaveLength(0);
  act(() => tree.root.findByProps({ testID: 'turn-stop' }).props.onPress());
  expect(stopRemaining).toHaveBeenCalledTimes(1);
  expect(stopGroupAgent).not.toHaveBeenCalled();
  act(() => tree.unmount());
});

it('stops every eligible agent only after an explicit Stop all', async () => {
  const stop = vi.fn(async () => true);
  const group = [agents[0], { ...agents[1], stop: undefined }, agents[2]];
  let tree: any;
  act(() => { tree = create(<TurnProgressLine agents={group} label="Working…" onStopAgent={stop} />); });
  const button = tree.root.findByProps({ testID: 'stop-all-agents' });
  act(() => button.props.onPress());
  expect(stop).not.toHaveBeenCalled();
  expect(tree.root.findAllByProps({ testID: 'stop-agent-Jellybean' })).toHaveLength(0);
  await act(async () => button.props.onPress());
  expect(stop.mock.calls).toEqual([[agents[0].stop], [agents[2].stop]]);
  expect(button.props.disabled).toBe(true);
  act(() => tree.unmount());
});
