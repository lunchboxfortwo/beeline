import React, { useRef, useState } from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
vi.mock('./chat-surface-values', () => ({ NO_SELECTED_MENTIONS: new Map(), COMPOSER_MIN_HEIGHT: 26 }));
vi.mock('react-native', () => ({ TextInput: 'input', Platform: { OS: 'web' } }));
vi.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: vi.fn() }));
vi.mock('@/buzz/github-access-surface', () => ({ readGitHubAccess: vi.fn() }));
vi.mock('@/sync/transport', () => ({ BuzzRigTransport: class {} }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/buzz/viewer-conversation', () => ({ publishViewerConversation: vi.fn(), removeViewerConversation: vi.fn() }));
vi.mock('@/buzz/host-scheduler', () => ({ yieldToNextPaint: async () => undefined }));
import { useChatComposerSend } from './useChatComposerSend';
import { useSendConfirmationState } from './send-confirmation';
import { selectComposerAckPresentation } from '@/buzz/room-indicators';

it.each([false, true])('SEND-CONFIRM-1 paints the optimistic row before acceptance and keeps failure feedback (reply=%s)', async (reply) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let accept!: (result: object) => void;
  const receipt = new Promise<object>(resolve => { accept = resolve; });
  const event = { id: 'signed-message', created_at: 100 };
  const compose = vi.fn(async () => event);
  const transport = { composeMessage: compose, composeReplyMessage: compose };
  const outbox = { enqueue: vi.fn(async (_event: unknown, _row: unknown) => undefined), send: vi.fn(() => receipt), get: () => true };
  let inputRef!: React.RefObject<string>;
  let send!: ReturnType<typeof useChatComposerSend>[0];
  const draft = { value: 'Hello agent', captureMessage: () => () => { draft.value = ''; return true; } };
  const no = () => undefined;
  const reference = { channelId: 'room', eventId: 'parent', rootId: 'parent' };
  const replyTarget = reply ? { messageId: 'parent', authorName: 'Captain', isAgent: false,
    preview: 'Original message', reference } : null;
  function Harness() {
    const confirmation = useSendConfirmationState();
    const [sending, setSending] = useState(false);
    const [delivery, setDelivery] = useState<'sending' | 'delivered' | 'failed' | null>(null);
    const [messages, setMessages] = useState<ChatDisplayMessage[]>([]);
    const inFlight = useRef(false);
    const input = useRef(draft.value);
    inputRef = input;
    const args = [draft, input, replyTarget, { current: [] }, inFlight, false,
      [], { current: new Map() }, () => no, { current: new Map() }, [], true,
      { current: () => outbox }, true, confirmation.setReceivedSteer, confirmation.setPendingAck,
      setSending, true, setDelivery, null, 'viewer', { remove: no }, { request: no }, no,
      (rows: ChatDisplayMessage[]) => setMessages(current => [...current, ...rows]), true, null,
      false, null, no, null, [], transport, null, no,
      (id: string) => setMessages(current => current.filter(message => message.id !== id)), {}, 'room',
      (from: string, to: string) => setMessages(current => current.map(message => message.id === from ? { ...message, id: to } : message)),
      { current: draft }, { current: 0 }, { current: null }, no, no, no, no, no, no, no, null,
      no, () => false, undefined, 'viewer', undefined, {}, 0, {}, new Map(), no, no];
    [send] = useChatComposerSend(args as unknown as Parameters<typeof useChatComposerSend>[0]);
    const ack = selectComposerAckPresentation({ isCorner: true, now: Date.now(),
      ...(confirmation.pendingAck ? { pendingAckSentAt: confirmation.pendingAck.sentAt,
        externalHandles: confirmation.pendingAck.externalHandles } : {}) });
    return <output data-sending={sending} data-delivery={delivery}>
      {messages.map(message => <p key={message.id}>{message.text}</p>)}
      <span>{ack?.label ?? ''}</span>
    </output>;
  }
  let tree!: ReturnType<typeof create>;
  try {
    act(() => { tree = create(<Harness />); });
    let pending!: ReturnType<typeof send>;
    await act(async () => { pending = send(); });
    expect(tree.root.findByType('p').props.children).toBe('Hello agent');
    expect(tree.root.findByType('span').props.children).toBe('sending…');
    expect(outbox.enqueue).toHaveBeenCalledOnce();
    expect(outbox.enqueue.mock.calls[0]?.[1]).toMatchObject(reply ? { reply: reference } : {});
    await act(async () => { accept({ externalAgentHandles: ['atlas'] }); await pending; });
    expect(tree.root.findByType('span').props.children).toBe('Sent to @atlas');
    expect(tree.root.findByType('output').props['data-sending']).toBe(false);
    expect(draft.value).toBe('');
    // A preparation failure keeps the next draft and reports failed delivery.
    draft.value = 'Keep this draft';
    inputRef.current = draft.value;
    transport.composeMessage.mockRejectedValueOnce(new Error('signing failed'));
    await act(async () => { await send(); });
    expect(tree.root.findAllByType('p')).toHaveLength(1);
    expect(tree.root.findByType('span').props.children).toBe('');
    expect(tree.root.findByType('output').props['data-delivery']).toBe('failed');
    expect(draft.value).toBe('Keep this draft');
  } finally { act(() => tree.unmount()); }
});
