import React, { useEffect, useRef, useState } from 'react';
import { Input, ListItem, XStack, YStack } from 'tamagui';
import type { RoomViewIdentity } from '@beeline/api-contract/phone';
import { createWorkItemId } from '@/buzz/work-item-id';
import { Btn, SheetFrame, SheetScroll, T } from '@/ui/grammar';
import { WorkAssigneePicker, WorkAvatar } from './WorkAssigneePicker';

export type CreateWorkTaskInput = {
  id: string;
  roomId: string;
  title: string;
  objective?: string;
  assigneeId?: string | null;
};

export function NewTaskSheet({
  open,
  close,
  chats,
  people,
  defaultChatId,
  onCreate,
}: {
  open: boolean;
  close: () => void;
  chats: readonly { readonly id: string; readonly name: string }[];
  people: readonly RoomViewIdentity[];
  defaultChatId: string | null;
  onCreate: (input: CreateWorkTaskInput) => Promise<void | boolean>;
}) {
  const resolveDefaultChat = () =>
    (defaultChatId && chats.some((c) => c.id === defaultChatId) ? defaultChatId : chats[0]?.id) ?? '';
  const [roomId, setRoomId] = useState(resolveDefaultChat);
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [pickingChat, setPickingChat] = useState(false);
  const [pickingAssignee, setPickingAssignee] = useState(false);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    if (!open) return;
    setRoomId(
      (defaultChatId && chats.some((c) => c.id === defaultChatId) ? defaultChatId : chats[0]?.id) ?? '',
    );
    setTitle('');
    setObjective('');
    setAssigneeId(null);
    setPickingChat(false);
    setPickingAssignee(false);
    setSaving(false);
    busy.current = false;
  }, [open, defaultChatId, chats]);

  const selectedChat = chats.find((c) => c.id === roomId);
  const selectedAssignee = assigneeId ? people.find((p) => p.pubkey === assigneeId) ?? null : null;

  const submit = async () => {
    const cleanTitle = title.trim();
    if (!cleanTitle || !roomId || busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      const cleanObjective = objective.trim();
      const result = await onCreate({
        id: createWorkItemId(),
        roomId,
        title: cleanTitle,
        ...(cleanObjective ? { objective: cleanObjective } : {}),
        ...(assigneeId !== null ? { assigneeId } : {}),
      });
      if (result !== false) close();
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return (
    <SheetFrame open={open} close={close} title="New task" testID="new-task-sheet">
      <YStack gap="3" flexShrink={1} minHeight={0}>
        <SheetScroll>
          <YStack gap="3">
            <YStack gap="1">
              <T v="meta" color="secondary">
                Chat
              </T>
              <Btn
                kind="secondary"
                label={selectedChat ? `Chat #${selectedChat.name}` : 'Choose chat'}
                disabled={saving || chats.length <= 1}
                onPress={() => {
                  setPickingAssignee(false);
                  setPickingChat((current) => !current);
                }}
                testID="new-task-chat-toggle"
              >
                <T v="meta">{selectedChat ? `#${selectedChat.name}` : 'Choose chat'}</T>
              </Btn>
              {pickingChat ? (
                <YStack
                  borderWidth={1}
                  borderColor="strongStroke"
                  borderRadius="md"
                  padding="3"
                  backgroundColor="raised"
                  gap="1"
                  testID="new-task-chat-picker"
                >
                  {chats.map((c) => (
                    <ListItem
                      key={c.id}
                      minHeight={44}
                      padding="0"
                      backgroundColor="transparent"
                      onPress={() => {
                        setRoomId(c.id);
                        setPickingChat(false);
                      }}
                      aria-label={`Select chat #${c.name}`}
                    >
                      <T>{`#${c.name}`}</T>
                    </ListItem>
                  ))}
                </YStack>
              ) : null}
            </YStack>
            <YStack gap="1">
              <T v="meta" color="secondary">
                Title
              </T>
              <Input
                minHeight={44}
                placeholder="Task title"
                aria-label="Task title"
                value={title}
                onChangeText={setTitle}
                testID="new-task-title"
              />
            </YStack>
            <YStack gap="1">
              <T v="meta" color="secondary">
                Objective
              </T>
              <Input
                minHeight={44}
                multiline
                placeholder="Optional objective"
                aria-label="Objective"
                value={objective}
                onChangeText={setObjective}
                testID="new-task-objective"
              />
            </YStack>
            {people.length > 0 ? (
              <YStack gap="1">
                <T v="meta" color="secondary">
                  Assignee
                </T>
                <Btn
                  kind="secondary"
                  label={selectedAssignee ? `Assignee ${selectedAssignee.name}` : 'Choose assignee'}
                  disabled={saving}
                  onPress={() => {
                    setPickingChat(false);
                    setPickingAssignee((current) => !current);
                  }}
                  testID="new-task-assignee-toggle"
                >
                  <XStack gap="2" alignItems="center">
                    {selectedAssignee ? <WorkAvatar person={selectedAssignee} size={20} /> : null}
                    <T v="meta">{selectedAssignee ? selectedAssignee.name : 'Unassigned'}</T>
                  </XStack>
                </Btn>
                {pickingAssignee ? (
                  <WorkAssigneePicker
                    people={people}
                    onPick={(person) => {
                      setAssigneeId(person?.pubkey ?? null);
                      setPickingAssignee(false);
                    }}
                  />
                ) : null}
              </YStack>
            ) : null}
          </YStack>
        </SheetScroll>
        <XStack gap="2" justifyContent="flex-end" flexShrink={0}>
          <Btn
            kind="quiet"
            label="Cancel"
            disabled={saving}
            onPress={close}
            testID="new-task-cancel"
          >
            <T v="meta">Cancel</T>
          </Btn>
          <Btn
            kind="primary"
            label="Create task"
            disabled={saving || !title.trim() || !roomId}
            onPress={() => {
              void submit();
            }}
            testID="new-task-submit"
          >
            Create task
          </Btn>
        </XStack>
      </YStack>
    </SheetFrame>
  );
}
