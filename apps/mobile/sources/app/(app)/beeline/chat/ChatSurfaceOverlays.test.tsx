import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({}));
vi.mock('tamagui', () => ({ YStack: 'YStack' }));
vi.mock('expo-haptics', () => ({}));
vi.mock('expo-router', () => ({ router: {} }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/sync/transport', () => ({}));
vi.mock('@/buzz/app-error-copy', () => ({ appErrorCopy: vi.fn() }));
vi.mock('@/buzz/agent-display', () => ({}));
vi.mock('@/buzz/room-participants', () => ({ formatRoomParticipantTotal: vi.fn() }));
vi.mock('@/buzz/message-reply', () => ({ agentActivityReplyExcerpt: vi.fn(), canBeginReply: () => false }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: vi.fn() }));
vi.mock('@/components/buzz/ErrorBanner', () => ({ ErrorBanner: 'ErrorBanner' }));
vi.mock('@/components/buzz/CornerActionsSheet', () => ({ CornerActionsSheet: 'CornerActionsSheet' }));
vi.mock('@/components/buzz/AttachmentPickerSheet', () => ({ AttachmentPickerSheet: 'AttachmentPickerSheet' }));
vi.mock('@/components/buzz/ForwardMessagePickerSheet', () => ({ ForwardMessagePickerSheet: 'ForwardMessagePickerSheet' }));
vi.mock('@/components/buzz/ForwardCornerSheet', () => ({ ForwardCornerSheet: 'ForwardCornerSheet' }));
vi.mock('@/components/buzz/MessageReactionStrip', () => ({ MessageReactionStrip: 'MessageReactionStrip' }));
vi.mock('@/components/buzz/HullActionSheet', () => ({ HullActionSheetModal: 'Sheet', HullActionSheetRow: 'Row', HullActionSheetCancel: 'Cancel' }));
vi.mock('@/components/buzz/RoomRepositoryChoice', () => ({ RoomActionsSheet: () => null }));
vi.mock('@/components/buzz/RoomReviewerActions', () => ({ RoomReviewerActions: 'RoomReviewerActions' }));
vi.mock('@/components/buzz/HullDialog', () => ({ HullDialog: 'Dialog', HullDialogInput: 'Input', HullDialogActions: 'Actions' }));
vi.mock('@/components/buzz/CreatePollSheet', () => ({ CreatePollSheet: 'PollSheet' }));
vi.mock('@/ui/screens/members/ChatAddSheets', () => ({ ChatAddSheet: 'ChatAddSheet', WorkspaceAddAgentSheet: 'WorkspaceAddAgentSheet' }));
vi.mock('@/ui/shell/panel', () => ({ openPlace: vi.fn() }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/ui/grammar', () => ({ T: 'T' }));
const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async (_text: string) => true) }));
vi.mock('expo-clipboard', () => clipboard);
import { ChatSurfaceOverlays } from './ChatSurfaceOverlays';

it('OPEN-SHEET-1: skips unopened sheets and retains an opened sheet through dismissal', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const props = { memberManagement: {}, outbox: { states: new Map() }, renameDraft: '',
    roomSurface: null, setDmActionsVisible: vi.fn() } as unknown as React.ComponentProps<typeof ChatSurfaceOverlays>;
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(<ChatSurfaceOverlays {...props} />); });
  for (const type of ['Sheet', 'Dialog', 'PollSheet', 'ForwardMessagePickerSheet', 'ForwardCornerSheet']) {
    expect(tree.root.findAllByType(type)).toHaveLength(0);
  }
  act(() => tree.update(<ChatSurfaceOverlays {...props} dmActionsVisible />));
  const sheet = tree.root.findByType('Sheet');
  expect(sheet.props.visible).toBe(true);
  act(() => sheet.props.onClose());
  expect(props.setDmActionsVisible).toHaveBeenCalledWith(false);
  act(() => tree.update(<ChatSurfaceOverlays {...props} dmActionsVisible={false} />));
  expect(tree.root.findByType('Sheet')).toBe(sheet);
  expect(sheet.props.visible).toBe(false);
  act(() => tree.unmount());
});

it('COPY-LINK-1: the message menu copies the message as ¶author-N and confirms it', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const showCopyToast = vi.fn();
  const setMessageActionsTarget = vi.fn();
  const target = { id: 'm1', text: 'Send button stays grey', isUser: false, timestamp: 1, chatSeq: 2773,
    authorIdentity: { pubkey: 'p', name: 'Candy', handle: 'candy', kind: 'agent' } };
  const props = { memberManagement: {}, outbox: { states: new Map(), current: () => new Map() }, renameDraft: '',
    roomSurface: null, canDeleteMessage: () => false,
    setMessageActionsTarget, showCopyToast, messageActionsTarget: target } as unknown as React.ComponentProps<typeof ChatSurfaceOverlays>;
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(<ChatSurfaceOverlays {...props} />); });
  const row = tree.root.findByProps({ testID: 'message-copy-link-action' });
  expect(row.props).toMatchObject({ label: 'Copy link', metadata: '¶candy-2773' });
  await act(async () => { row.props.onPress(); });
  expect(setMessageActionsTarget).toHaveBeenCalledWith(null);
  expect(clipboard.setStringAsync).toHaveBeenCalledExactlyOnceWith('¶candy-2773');
  expect(showCopyToast).toHaveBeenCalledWith('Copied ¶candy-2773');

  // A row the server has not numbered (still sending) offers no link.
  act(() => tree.update(<ChatSurfaceOverlays {...props} messageActionsTarget={{ ...target, chatSeq: undefined } as never} />));
  expect(tree.root.findAllByProps({ testID: 'message-copy-link-action' })).toHaveLength(0);
  act(() => tree.unmount());
});

it('DM-CLOSE-1: the direct-message sheet offers Close conversation through closeChat', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const handleRoomLifecycle = vi.fn(async () => undefined);
  const props = { memberManagement: {}, outbox: { states: new Map() }, renameDraft: '',
    roomSurface: null, setDmActionsVisible: vi.fn(), dmActionsVisible: true, handleRoomLifecycle } as unknown as React.ComponentProps<typeof ChatSurfaceOverlays>;
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(<ChatSurfaceOverlays {...props} />); });
  const row = tree.root.findByProps({ testID: 'dm-close-action' });
  expect(row.props.label).toBe('Close conversation');
  act(() => row.props.onPress());
  expect(handleRoomLifecycle).toHaveBeenCalledExactlyOnceWith('close');
  act(() => tree.update(<ChatSurfaceOverlays {...props} roomLifecycleBusy />));
  expect(tree.root.findByProps({ testID: 'dm-close-action' }).props.disabled).toBe(true);
  act(() => tree.unmount());
});

it('BOOKMARK-RETIRED-1: the message sheet offers no Bookmark', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const target = { id: 'm1', text: 'hello', isUser: true, timestamp: 1, chatSeq: 3,
    authorIdentity: { pubkey: 'p', name: 'Maya', handle: 'maya', kind: 'human' } };
  const props = { memberManagement: {}, outbox: { states: new Map(), current: () => new Map() }, renameDraft: '',
    roomSurface: null, canDeleteMessage: () => true, messageActionsTarget: target } as unknown as React.ComponentProps<typeof ChatSurfaceOverlays>;
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(<ChatSurfaceOverlays {...props} />); });
  const rows = tree.root.findAllByType('Row').map((row: any) => row.props.testID);
  expect(rows).toEqual(['message-report-action', 'message-copy-action', 'message-copy-link-action',
    'message-select-action', 'message-forward-action', 'message-delete-action']);
  act(() => tree.unmount());
});

it('saves a top-level chat message to Backlog with originMessageId and hides Save to backlog in threads and DMs', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const { monolithPhoneOperation } = await import('@/sync/transport/monolith-operation');
  vi.mocked(monolithPhoneOperation).mockReset();
  vi.mocked(monolithPhoneOperation).mockResolvedValueOnce(undefined);
  const showCopyToast = vi.fn();
  const readRoom = vi.fn();
  const setMessageActionsTarget = vi.fn();
  const target = { id: 'msg-1', relayId: 'msg-1', text: 'Fix drag and drop on Tasks\nWith cleanup', isUser: true, timestamp: 1,
    authorIdentity: { pubkey: 'p', name: 'Maya', handle: 'maya', kind: 'human' } };
  const props = {
    decodedId: 'chat-1',
    isCorner: false,
    isDirectMessage: false,
    memberManagement: {},
    outbox: { states: new Map(), current: () => new Map() },
    renameDraft: '',
    roomSurface: null,
    canDeleteMessage: () => false,
    setMessageActionsTarget,
    showCopyToast,
    readRoom,
    messageActionsTarget: target,
  } as unknown as React.ComponentProps<typeof ChatSurfaceOverlays>;
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(<ChatSurfaceOverlays {...props} />); });
  const row = tree.root.findByProps({ testID: 'message-save-backlog-action' });
  expect(row.props.label).toBe('Save to backlog');
  await act(async () => { row.props.onPress(); });
  expect(setMessageActionsTarget).toHaveBeenCalledWith(null);
  expect(monolithPhoneOperation).toHaveBeenCalledWith(
    'updateWorkItem',
    expect.objectContaining({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
      roomId: 'chat-1',
      title: 'Fix drag and drop on Tasks',
      objective: 'Fix drag and drop on Tasks\nWith cleanup',
      state: 'backlog',
      originMessageId: 'msg-1',
    }),
  );
  expect(showCopyToast).toHaveBeenCalledWith('Saved to backlog');
  expect(readRoom).toHaveBeenCalled();

  act(() => tree.update(<ChatSurfaceOverlays {...props} isCorner />));
  expect(tree.root.findAllByProps({ testID: 'message-save-backlog-action' })).toHaveLength(0);
  act(() => tree.update(<ChatSurfaceOverlays {...props} isDirectMessage />));
  expect(tree.root.findAllByProps({ testID: 'message-save-backlog-action' })).toHaveLength(0);
  act(() => tree.unmount());
});
