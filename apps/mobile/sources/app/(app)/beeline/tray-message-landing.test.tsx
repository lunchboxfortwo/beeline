import React from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { NeedsYouApprovalKind } from '@beeline/api-contract/phone';
import type { RoomViewMessage } from '@beeline/buzz-client';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { useRoomMessageStore } from '@/buzz/room-message-store';
import { createTranscriptScrollController } from '@/buzz/transcript-scroll-controller';
import { useChatTranscriptLanding } from './chat/useChatTranscriptLanding';
import { ask, press, renderTags, serve, state } from '@/test/fixtures/tray.test-support';

vi.mock('@/buzz/activity-timeline', () => ({ buildTurnActivity: vi.fn() }));
vi.mock('@/components/buzz/ConversationComposer', () => ({ COMPOSER_MAX_INPUT_HEIGHT: 100, COMPOSER_SINGLE_LINE_INPUT_HEIGHT: 40 }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@/buzz/room-bottom-chrome', () => ({ PHONE_TRANSCRIPT_TAIL_PADDING: 40 }));

it.each([
  { label: 'routed request', source: { roomId: 'origin', messageId: 'earlier-request', label: '#beeline' } },
  { label: 'routed thread', source: { roomId: 'origin', label: '#beeline' } },
  { label: 'free-text question' },
  { label: 'blocked report' },
  { label: 'needs-decision report' },
  ...(['choice', 'grant', 'write-access', 'squire', 'connector', 'sign-in'] satisfies NeedsYouApprovalKind[]).map(kind => ({
    label: `${kind} approval`,
    approval: { kind, actor: 'Jellybean', ask: 'asks', subject: 'How would you like to clear the Cloudflare challenge?', literal: false },
  })),
] as const)('opens the $label card at its asking message outside the loaded window', async variant => {
  const item = ask({
    source: 'source' in variant ? variant.source : undefined,
    ask: { ...ask().ask!, approval: 'approval' in variant ? variant.approval : undefined },
  });
  serve([item]);
  const tray = await renderTags();
  await press(tray, 'Open ' + (item.source?.label ?? '#beeline ↳ latency-coverage'));
  // The fixture only substitutes the route serializer, retaining the actual
  // card press and TrayScreen.open action. Feed its destination into chat.
  const destination = state.push.mock.lastCall![0] as { roomId: string; messageId: string };
  const row = (id: string, createdAt: number): RoomViewMessage => ({
    id, text: id, createdAt, presentation: 'message',
    author: { pubkey: 'agent', kind: 'agent', name: 'Jellybean' },
  });
  const target = row(item.ask!.messageId, 2);
  const earlier = row('earlier-request', 1);
  const newer = Array.from({ length: 80 }, (_, n) => row(`newer-${n}`, n + 3));
  const all = [earlier, target, ...newer];
  const client = {
    history: vi.fn(),
    historyAround: vi.fn(async (_room: string, id: string) => ({
      roomId: destination.roomId, messages: all.slice(all.findIndex(m => m.id === id)),
    })),
  };
  const frames: Array<() => void> = [];
  let history!: ReturnType<typeof useRoomMessageStore>;
  let rows: ChatDisplayMessage[] = [];
  const scroll = vi.fn(() => true);
  const controller = createTranscriptScrollController<ChatDisplayMessage>({
    rows: () => rows,
    rowIndex: (request, messages) => messages.findIndex(m => m.id === request.messageId),
    list: () => ({ toRow: scroll, toEstimatedRow() {}, toNewest() {}, toOffset() {}, shiftBy() {} }),
    holdsLanding: () => !history.attached,
    onScrolled: () => history.endJump(),
    schedule: callback => { frames.push(callback); },
  });
  const noop = () => {};
  function Chat() {
    history = useRoomMessageStore({
      roomId: destination.roomId, tailMessages: newer.slice(-30), roomClient: client, enabled: true, initialVisibleCount: 30,
    });
    rows = [...(history.attached ? newer.slice(-30) : history.rows)].reverse().map(m => ({
      id: m.id, text: m.text, timestamp: m.createdAt, isUser: false,
    }));
    const handled = React.useRef<string | null>(null);
    useChatTranscriptLanding([
      controller, noop, false, noop, rows, history.jump, false, newer[50]!.id,
      destination.messageId ?? '', destination.roomId, noop, { subscribeCommit: () => noop }, { call: null },
      [...rows].reverse(), 'card-tap', destination.messageId, undefined, handled, { current: new Map() },
      () => true, client, 'viewer', { room: { id: destination.roomId } }, history.jumpTo,
      !history.attached, history.newerStatus, { current: null }, history.loadNewer,
    ] as unknown as Parameters<typeof useChatTranscriptLanding>[0]);
    React.useLayoutEffect(() => controller.observeLayout(), [history.rows]);
    return null;
  }
  let chat: ReturnType<typeof create>;
  try {
    await act(async () => { chat = create(<Chat />); });
    await act(async () => { while (frames.length) frames.shift()!(); });
    expect(scroll).toHaveBeenLastCalledWith(rows.findIndex(m => m.id === target.id), target.id, 'top');
    expect(client.historyAround).toHaveBeenCalledExactlyOnceWith(item.ask!.roomId, target.id);
    expect(rows.some(m => m.id === target.id)).toBe(true);
    act(() => controller.observeVisibleRows([rows.find(m => m.id === target.id)!]));
    expect(controller.isHoldingLanding()).toBe(true);
  } finally {
    await act(async () => chat?.unmount());
  }
});
