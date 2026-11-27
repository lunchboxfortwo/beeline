import React, { useRef, useState } from 'react';
import { Input, XStack, YStack } from 'tamagui';
import { FileText, Link as LinkIcon, Plus } from 'lucide-react-native';
import {
  normalizeWorkItemLinkUrl,
  parseChatLinkToken,
  threadLinkToken,
  workItemLinkLabel,
  type RoomViewIdentity,
  type WorkItemView,
  type WorkState,
} from '@beeline/api-contract/phone';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { compactRelativeTime } from '@/buzz/relative-time';
import { mediaIdFromUrl } from '@/buzz/artifact';
import { beelineUrlHref } from '@/buzz/beeline-url';
import { cornerHref, roomHref } from '@/buzz/corner-navigation';
import { messageLinkId, openChatMessageLink, openMessageLink } from '@/buzz/message-link';
import { loadWorkBoard } from '@/buzz/work-board-store';
import {
  MonolithPhoneOperationError,
  monolithPhoneOperation,
  phoneOperationFailureReason,
} from '@/sync/transport/monolith-operation';
import { openExternalUrl } from '@/utils/open-external-url';
import { Btn, Glyph, SheetFrame, SheetScroll, T } from '@/ui/grammar';
import { WorkAssigneePicker, WorkAvatar } from './WorkAssigneePicker';
import { WorkStateMark } from './WorkMarks';

const STATE_LABEL = {
  'needs-you': 'Waiting',
  'in-progress': 'In progress',
  'in-review': 'In review',
  backlog: 'Backlog',
  done: 'Done',
};

/** The states a person sets by hand; the others follow the thread's own work. */
const SETTABLE_STATES = ['backlog', 'in-progress', 'done'] as const satisfies readonly WorkState[];

/** Shared phone/desktop detail. Server responses own the stream and attachments. */
export function WorkItemDetail({
  item,
  workspaceId,
  viewerId,
  desktop,
  now,
  people,
  onAssign,
}: {
  item: WorkItemView;
  workspaceId: string;
  viewerId: string;
  desktop: boolean;
  now: number;
  people?: readonly RoomViewIdentity[];
  onAssign?: (item: WorkItemView, identityId: string | null) => Promise<void | boolean>;
}) {
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [changingState, setChangingState] = useState(false);
  const [changingAssignee, setChangingAssignee] = useState(false);
  const [pickingAssignee, setPickingAssignee] = useState(false);
  const busy = useRef({ note: false, attachment: false, state: false, assignee: false });
  const address = { roomId: item.roomId, id: item.id };
  const refresh = () => loadWorkBoard(workspaceId, true);
  const send = async () => {
    if (!note.trim() || busy.current.note) return;
    busy.current.note = true;
    setSending(true);
    const sent = note;
    try {
      await monolithPhoneOperation('addWorkNote', { ...address, text: sent });
      setNote((current) => (current === sent ? '' : current));
      await refresh();
    } catch {
      /* The shared connection owner handles transport failures; keep the draft. */
    } finally {
      busy.current.note = false;
      setSending(false);
    }
  };
  const changeState = async (state: WorkState) => {
    if (item.roomArchived || state === item.state || busy.current.state) return;
    busy.current.state = true;
    setChangingState(true);
    try {
      await monolithPhoneOperation('updateWorkItem', { ...address, state });
      await refresh();
    } catch {
      /* The shared connection owner handles transport failures. */
    } finally {
      busy.current.state = false;
      setChangingState(false);
    }
  };
  const changeAssignee = async (assigneeId: string | null) => {
    if (item.roomArchived || assigneeId === (item.assignee?.pubkey ?? null) || busy.current.assignee) {
      return;
    }
    busy.current.assignee = true;
    setChangingAssignee(true);
    try {
      if (onAssign) {
        await onAssign(item, assigneeId);
      } else {
        await monolithPhoneOperation('updateWorkItem', { ...address, assigneeId });
        await refresh();
      }
    } catch {
      /* The shared connection owner handles transport failures. */
    } finally {
      busy.current.assignee = false;
      setChangingAssignee(false);
    }
  };
  const attach = async (kind: 'file' | 'link') => {
    if (busy.current.attachment) return;
    busy.current.attachment = true;
    setAttaching(true);
    try {
      if (kind === 'file') {
        const [DocumentPicker, { readFileBytes }] = await Promise.all([
          import('expo-document-picker'),
          import('@/utils/readFileBytes'),
        ]);
        const picked = await DocumentPicker.getDocumentAsync({
          copyToCacheDirectory: true,
          multiple: false,
          type: '*/*',
        });
        const asset = picked.canceled ? undefined : picked.assets[0];
        if (!asset) return;
        const uploaded = await monolithPhoneOperation('uploadMedia', {
          bytes: await readFileBytes(asset.uri),
          mimeType: asset.mimeType ?? 'application/octet-stream',
          name: asset.name,
        });
        const objectId = mediaIdFromUrl(uploaded.url);
        if (!objectId) return;
        await monolithPhoneOperation('attachToWorkItem', {
          ...address,
          attachment: { kind: 'file', name: asset.name, objectId },
        });
      } else {
        const { Modal } = await import('@/modal');
        const entered = await Modal.prompt('Add link', undefined, {
          placeholder: 'https:// or Beeline link',
          confirmText: 'Add',
        });
        if (!entered?.trim()) return;
        const url = normalizeWorkItemLinkUrl(entered);
        if (!url) {
          Modal.alert(
            'Invalid link',
            'Enter an http(s) URL or a Beeline place or message link.',
          );
          return;
        }
        await monolithPhoneOperation('attachToWorkItem', {
          ...address,
          attachment: { kind: 'link', name: workItemLinkLabel(url), url },
        });
      }
      await refresh();
    } catch (error) {
      if (error instanceof MonolithPhoneOperationError) {
        const { Modal } = await import('@/modal');
        Modal.alert('Could not attach link', phoneOperationFailureReason(error));
      }
    } finally {
      busy.current.attachment = false;
      setAttaching(false);
    }
  };
  return (
    <YStack gap="3" flexShrink={1} minHeight={0}>
      <SheetScroll>
        <YStack gap="3">
          <XStack gap="2" alignItems="center">
            <WorkStateMark state={item.state} idle={item.idle} />
            <T v="meta" color="secondary">
              {item.idle ? 'Idle' : STATE_LABEL[item.state]}
            </T>
          </XStack>
          {!item.roomArchived ? (
            <XStack
              gap="2"
              flexWrap="wrap"
              role="radiogroup"
              aria-label="State"
              testID="work-state-picker"
            >
              {SETTABLE_STATES.map((state) => (
                <Btn
                  key={state}
                  kind={item.state === state ? 'accent' : 'secondary'}
                  label={STATE_LABEL[state]}
                  role="radio"
                  aria-checked={item.state === state}
                  disabled={changingState}
                  onPress={() => {
                    void changeState(state);
                  }}
                  testID={`work-state-${state}`}
                >
                  <T v="meta" color={item.state === state ? 'needsYou' : 'ink'}>
                    {STATE_LABEL[state]}
                  </T>
                </Btn>
              ))}
            </XStack>
          ) : null}
          {!item.roomArchived && people && people.length > 0 ? (
            <YStack gap="2">
              <XStack gap="2" alignItems="center" testID="work-assignee-row">
                <T v="meta" color="secondary">
                  Assignee
                </T>
                <Btn
                  kind="secondary"
                  label={item.assignee ? `Change assignee ${item.assignee.name}` : 'Assign'}
                  disabled={changingAssignee}
                  onPress={() => setPickingAssignee((current) => !current)}
                  testID="work-assignee-toggle"
                >
                  <XStack gap="2" alignItems="center">
                    {item.assignee ? <WorkAvatar person={item.assignee} size={20} /> : null}
                    <T v="meta">{item.assignee ? item.assignee.name : 'Unassigned'}</T>
                  </XStack>
                </Btn>
              </XStack>
              {pickingAssignee ? (
                <WorkAssigneePicker
                  people={people}
                  onPick={(person) => {
                    setPickingAssignee(false);
                    void changeAssignee(person?.pubkey ?? null);
                  }}
                />
              ) : null}
            </YStack>
          ) : item.assignee ? (
            <XStack gap="2" alignItems="center" testID="work-assignee-row">
              <T v="meta" color="secondary">
                Assignee
              </T>
              <WorkAvatar person={item.assignee} size={20} />
              <T v="meta">{item.assignee.name}</T>
            </XStack>
          ) : null}
          {item.objective ? <T testID="work-sheet-objective">{item.objective}</T> : null}
          <YStack gap="2">
            <T v="meta" color="secondary">
              Attachments
            </T>
            <XStack gap="2" flexWrap="wrap" alignItems="center">
              {(item.attachments ?? []).map((attachment) => (
                <Btn
                  key={attachment.id}
                  kind="secondary"
                  label={attachment.name}
                  onPress={() => {
                    if (attachment.kind === 'file')
                      void import('@/components/buzz/ArtifactCard').then(({ openArtifactViewer }) =>
                        openArtifactViewer(attachment.file, desktop),
                      );
                    else if (messageLinkId(attachment.url))
                      void openMessageLink(attachment.url).catch(() => undefined);
                    else if (parseChatLinkToken(attachment.url))
                      void (async () => {
                        const [
                          { loadBuzzIdentity, getEffectiveRelayUrl },
                          { RoomViewClient },
                          { router },
                        ] = await Promise.all([
                          import('@/auth/buzz-identity-storage'),
                          import('@/sync/transport/room-view-client'),
                          import('expo-router'),
                        ]);
                        const identity = await loadBuzzIdentity();
                        if (!identity) return;
                        const view = await new RoomViewClient({
                          identity,
                          baseUrl: await getEffectiveRelayUrl(),
                        }).resolveChatLinks(item.roomId, [attachment.url]);
                        const resolved = view.links[0];
                        if (!resolved || resolved.kind === 'private') return;
                        if (resolved.kind === 'thread')
                          router.navigate(
                            cornerHref(resolved.roomId, resolved.parentRoomId, resolved.name),
                          );
                        else
                          openChatMessageLink(resolved, (href) => {
                            router.navigate(href);
                          });
                      })().catch(() => undefined);
                    else if (/^#beeline\/([^\s/()<>]+)$/.test(attachment.url)) {
                      const place = /^#beeline\/([^\s/()<>]+)$/.exec(attachment.url)![1]!;
                      void (async () => {
                        const { router } = await import('expo-router');
                        if (
                          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                            place,
                          )
                        ) {
                          router.navigate(roomHref(place, workspaceId));
                          return;
                        }
                        const [
                          { loadBuzzIdentity, getEffectiveRelayUrl },
                          { RoomViewClient },
                        ] = await Promise.all([
                          import('@/auth/buzz-identity-storage'),
                          import('@/sync/transport/room-view-client'),
                        ]);
                        const identity = await loadBuzzIdentity();
                        if (!identity) return;
                        const client = new RoomViewClient({
                          identity,
                          baseUrl: await getEffectiveRelayUrl(),
                        });
                        const resolved = (
                          await client.resolveChatLinks(item.roomId, [threadLinkToken(place)])
                        ).links[0];
                        if (resolved?.kind === 'thread') {
                          router.navigate(
                            cornerHref(resolved.roomId, resolved.parentRoomId, resolved.name),
                          );
                          return;
                        }
                        const list = await client.chats(workspaceId);
                        const chat = list.chats.find(
                          (entry) => entry.room.name.toLowerCase() === place.toLowerCase(),
                        );
                        if (chat) router.navigate(roomHref(chat.room.id, workspaceId));
                      })().catch(() => undefined);
                    } else if (/^(?:https?|beeline):/i.test(attachment.url)) {
                      const href = beelineUrlHref(attachment.url);
                      if (href) {
                        void import('expo-router')
                          .then(({ router }) => router.navigate(href))
                          .catch(() => undefined);
                      } else {
                        void openExternalUrl(attachment.url);
                      }
                    }
                  }}
                >
                  <Glyph
                    icon={attachment.kind === 'file' ? FileText : LinkIcon}
                    size={16}
                    color="ink"
                  />
                  <T v="meta">{attachment.name}</T>
                </Btn>
              ))}
              <Btn
                kind="quiet"
                label="Add"
                disabled={attaching}
                testID="work-attachment-add"
                onPress={() => {
                  void import('@/modal').then(({ Modal }) =>
                    Modal.actionSheet('Add attachment', [
                      {
                        text: 'File',
                        onPress: () => {
                          void attach('file');
                        },
                      },
                      {
                        text: 'Link',
                        onPress: () => {
                          void attach('link');
                        },
                      },
                    ]),
                  );
                }}
              >
                <Glyph icon={Plus} size={16} color="ink" />
                <T v="meta">Add</T>
              </Btn>
            </XStack>
          </YStack>
          <YStack gap="2">
            <T v="meta" color="secondary">
              Activity
            </T>
            {(item.entries ?? []).map((entry) => (
              <XStack
                key={entry.id}
                gap="2"
                paddingVertical="1"
                borderTopWidth={1}
                borderColor="stroke"
                alignItems="flex-start"
              >
                <IdentityMark
                  kind={entry.author.kind}
                  seed={entry.author.pubkey}
                  name={entry.author.name}
                  face={entry.author.face}
                  avatarUrl={entry.author.avatar}
                  size={24}
                />
                <YStack flex={1} minWidth={0}>
                  <T v="meta">
                    <T v="metaStrong">
                      {entry.author.pubkey === viewerId ? 'You' : entry.author.name}
                    </T>
                    {entry.kind === 'note' ? ': ' : ' '}
                    {entry.text}
                  </T>
                  <T v="meta" color="secondary">
                    {compactRelativeTime(entry.createdAt, now)}
                  </T>
                </YStack>
              </XStack>
            ))}
          </YStack>
        </YStack>
      </SheetScroll>
      <XStack gap="2" alignItems="flex-end" flexShrink={0}>
        <Input
          flex={1}
          minWidth={0}
          minHeight={44}
          multiline
          value={note}
          onChangeText={setNote}
          placeholder="Add a note…"
          aria-label="Add a note"
          testID="work-note-input"
        />
        <Btn
          kind="quiet"
          label="Send"
          disabled={!note.trim() || sending}
          onPress={() => {
            void send();
          }}
          testID="work-note-send"
        >
          <T v="meta">Send</T>
        </Btn>
      </XStack>
    </YStack>
  );
}

export function WorkSheet({
  item,
  close,
  ...props
}: {
  item: WorkItemView | null;
  close: () => void;
  workspaceId: string;
  viewerId: string;
  desktop: boolean;
  now: number;
  people?: readonly RoomViewIdentity[];
  onAssign?: (item: WorkItemView, identityId: string | null) => Promise<void | boolean>;
}) {
  const last = useRef(item);
  if (item) last.current = item;
  const shown = last.current;
  return (
    <SheetFrame open={Boolean(item)} close={close} title={shown?.title ?? ''} testID="work-sheet">
      {shown ? <WorkItemDetail key={shown.id} item={shown} {...props} /> : null}
    </SheetFrame>
  );
}
