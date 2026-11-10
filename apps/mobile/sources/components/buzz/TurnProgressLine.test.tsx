import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { TurnProgressLine,TurnSettledLine } from './TurnProgressLine';
vi.mock('react-native', () => ({ View: 'View', Text: 'Text' }));
vi.mock('./BeelineMarkSpinner', () => ({ MARK_CELL: 18, BeelineMarkSpinner: () => React.createElement('Mark') }));
vi.mock('./Button', () => ({ Button: (props: any) => React.createElement('Button', props) }));
vi.mock('./MonoHull', () => ({ HullLivePulse: (props: any) => props.children }));

it('keeps failure copy on one ellipsizing line and the tappable word separate from it', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const retry = vi.fn(), stopPropagation = vi.fn(); let renderer: any;
  act(() => { renderer = create(<TurnSettledLine line={'Not sent: ' + 'A long server refusal. '.repeat(20)}
    leadingGlyph={false} inset={false} action={{ label: 'Retry', onPress: retry }} testID="failed" />); });
  const texts = renderer.root.findAllByType('Text');
  expect(texts[0].props.numberOfLines).toBe(1);
  expect(texts[0].props.children).toContain('A long server refusal.');
  expect(renderer.root.findAllByType('Mark')).toHaveLength(0);
  const button = renderer.root.findByType('Button');
  expect(button.props.label).toBe('Retry');
  act(() => button.props.onTouchEnd({ stopPropagation }));
  act(() => button.props.onPress({ stopPropagation }));
  expect(stopPropagation).toHaveBeenCalledTimes(2); expect(retry).toHaveBeenCalledTimes(1);
  act(() => renderer.unmount());
});

it('keeps the existing settled-turn mark when no failure-line options are supplied', () => {
  let renderer: any; act(() => { renderer = create(<TurnSettledLine line="Finished" />); });
  expect(renderer.root.findAllByType('Mark')).toHaveLength(1);
  expect(renderer.root.findAllByType('Button')).toHaveLength(0);
  act(() => renderer.unmount());
});


it('renders release preparation in the thinking line without scheduling an execution counter',()=>{
  vi.useFakeTimers();let renderer:any;
  try{
    act(()=>{renderer=create(<TurnProgressLine label="Beebee · updating — downloading the new release…" testID="release"/>);});
    const labels=renderer.root.findAllByType('Text').map((node:any)=>node.props.children);
    expect(labels).toContain('Beebee · updating — downloading the new release…');
    expect(renderer.root.findAll((node:any)=>node.props.testID==='release-elapsed')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  }finally{act(()=>renderer?.unmount());vi.useRealTimers();}
});
