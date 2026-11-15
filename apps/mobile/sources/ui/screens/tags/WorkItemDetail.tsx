import React, { useRef, useState } from 'react';
import { Input, XStack, YStack } from 'tamagui';
import { FileText, Link as LinkIcon, Plus } from 'lucide-react-native';
import type { WorkItemView } from '@beeline/api-contract/phone';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { compactRelativeTime } from '@/buzz/relative-time';
import { mediaIdFromUrl } from '@/buzz/artifact';
import { loadWorkBoard } from '@/buzz/work-board-store';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { openExternalUrl } from '@/utils/open-external-url';
import { Btn, Glyph, SheetFrame, SheetScroll, T } from '@/ui/grammar';
import { WorkStateMark } from './WorkMarks';

const STATE_LABEL = {
  'needs-you': 'Waiting',
  'in-progress': 'In progress',
  'in-review': 'In review',
  backlog: 'Backlog',
  done: 'Done',
};

/** Shared phone/desktop detail. Server responses own the stream and attachments. */
export function WorkItemDetail({
  item,
  workspaceId,
  viewerId,
  desktop,
  now,
}: {
  item: WorkItemView;
  workspaceId: string;
  viewerId: string;
  desktop: boolean;
  now: number;
}) {
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const busy = useRef({ note: false, attachment: false });
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
          placeholder: 'https://',
          confirmText: 'Add',
        });
        if (!entered?.trim()) return;
        const url = new URL(entered.trim());
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
        await monolithPhoneOperation('attachToWorkItem', {
          ...address,
          attachment: { kind: 'link', name: url.hostname, url: url.href },
        });
      }
      await refresh();
    } catch {
      /* Existing connection feedback owns failures. */
    } finally {
      busy.current.attachment = false;
      setAttaching(false);
    }
  };
  return (
    <YStack gap="3">
      <SheetScroll>
        <YStack gap="3">
          <XStack gap="2" alignItems="center">
            <WorkStateMark state={item.state} idle={item.idle} />
            <T v="meta" color="secondary">
              {item.idle ? 'Idle' : STATE_LABEL[item.state]}
            </T>
          </XStack>
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
                    else void openExternalUrl(attachment.url);
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
      <XStack gap="2" alignItems="flex-end">
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
