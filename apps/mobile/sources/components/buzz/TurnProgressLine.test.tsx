import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { TurnProgressLine, TurnSettledLine } from './TurnProgressLine';
vi.mock('tamagui', () => ({ XStack: 'XStack', YStack: 'YStack', Spinner: 'Spinner' }));
vi.mock('@/ui/grammar', () => ({ T: (props: any) => React.createElement('T', props) }));
vi.mock('./TurnLineFrame', () => ({ TurnLineBar: (props: any) => React.createElement('Bar', props), TurnBandSlot: 'Slot' }));
vi.mock('./BeelineMarkSpinner', () => ({ BeelineMarkSpinner: () => React.createElement('Mark') }));

const texts = (renderer: any): unknown[] => renderer.root.findAllByType('T').map((node: any) => node.props.children);

it('keeps failure copy on one ellipsizing line and the tappable word separate from it', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const retry = vi.fn(), stopPropagation = vi.fn(); let renderer: any;
  act(() => { renderer = create(<TurnSettledLine line={'Not sent: ' + 'A long server refusal. '.repeat(20)}
    leadingGlyph={false} inset={false} action={{ label: 'Retry', onPress: retry }} testID="failed" />); });
  const line = renderer.root.find((node: any) => node.props.testID === 'failed-line');
  expect(line.props.numberOfLines).toBe(1);
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
