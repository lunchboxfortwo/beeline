import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ rows: [] as unknown[], noop: () => {} }));
vi.mock('expo-router', () => ({ router: { push: fixture.noop } }));
vi.mock('@/buzz/room-message-records', () => ({ useRoomMessageRecords: () => [fixture.rows, fixture.rows] }));
vi.mock('@/buzz/room-send-frame', () => ({ useRoomSendFrame: () => ({
  frame: { optimistic: fixture.rows }, append: fixture.noop, reconcile: fixture.noop,
  remove: fixture.noop, clear: fixture.noop,
}) }));
vi.mock('@/buzz/room-message-store', () => ({
  createTranscriptRowFolder: () => () => ({ rows: fixture.rows, hostIds: new Map() }),
  foldTranscriptRows: () => ({ rows: fixture.rows }),
}));
vi.mock('@/buzz/use-new-message-control', () => ({ useUnreadLineControl: () => ({ dividerMessageId: null, retire: fixture.noop }) }));
vi.mock('@/buzz/use-room-workflow-run', () => ({ useRoomWorkflowRun: () => ({}) }));
vi.mock('@/ui/shell/panel', () => ({ openPlace: fixture.noop }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/components/buzz/Ledger', () => ({ LedgerHistoryLine: (props: any) => React.createElement('HistoryLine', props) }));
vi.mock('@/ui/screens/transcript/TranscriptLine', () => ({ TranscriptLine: (props: any) => React.createElement('TranscriptLine', props, props.children) }));
vi.mock('@/ui/screens/transcript/cards/WorkflowRunCard', () => ({ WorkflowRunCard: (props: any) => React.createElement('WorkflowRunCard', props) }));
import { useChatTranscriptHistory } from './useChatTranscriptHistory';

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
async function renderHistory(history: string, newer: string, jump?: string) {
  const retry = vi.fn();
  function Transcript() {
    const args = [null, 'room', fixture.rows, fixture.rows, 'viewer', { project: () => fixture.rows, reset: fixture.noop },
      null, fixture.rows, { current: 0 }, 0, true, { current: {} }, fixture.noop, { current: () => null }, 'viewer', false,
      null, 50, undefined, 'design', fixture.noop, { current: true }, retry,
      jump ? { messageId: 'older', status: jump } : null, {}, retry, newer, retry, history] as unknown as Parameters<typeof useChatTranscriptHistory>[0];
    const result = useChatTranscriptHistory(args);
    return <>{result[20]}{result[21]}</>;
  }
  let tree: any;
  await act(async () => { tree = create(<Transcript />); });
  const lines = tree.root.findAllByType('HistoryLine').map((node: any) => node.props);
  await act(async () => tree.unmount());
  return { lines, retry };
}
it.each([
  ['error', 'idle', undefined], ['idle', 'error', undefined], ['idle', 'idle', 'error'],
])('never adds failed-read copy or Retry for history=%s newer=%s jump=%s', async (history, newer, jump) => {
  const { lines, retry } = await renderHistory(history!, newer!, jump);
  expect(lines).toEqual([]); expect(retry).not.toHaveBeenCalled();
});
it('retains loading and confirmed missing-message explanations, with no beginning marker', async () => {
  expect((await renderHistory('loading', 'idle')).lines.map((line: any) => line.text)).toEqual(['Loading earlier messages…']);
  expect((await renderHistory('complete', 'loading')).lines.map((line: any) => line.text)).toEqual(['Loading later messages…']);
  expect((await renderHistory('idle', 'idle', 'missing')).lines.map((line: any) => line.text)).toEqual(['That message is no longer available']);
});
