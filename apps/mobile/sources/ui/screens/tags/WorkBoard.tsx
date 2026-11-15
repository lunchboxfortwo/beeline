import React, { useState } from 'react';
import { Card, Input, ListItem, ScrollView, Separator, XStack, YStack } from 'tamagui';
import {
  ChevronDown,
  ChevronRight,
  Columns3,
  Filter,
  List,
  UserRound,
  X,
} from 'lucide-react-native';
import {
  WORK_PRIORITIES,
  type NeedsYouActionView,
  type RoomViewIdentity,
  type WorkBoardView,
  type WorkItemView,
  type WorkPriority,
} from '@beeline/api-contract/phone';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { Btn, Glyph, T } from '@/ui/grammar';
import { WorkPriorityMark, WorkStateMark } from './WorkMarks';

export type WorkBoardActions = {
  open: (item: WorkItemView) => void;
  reply: (item: WorkItemView, text: string) => Promise<void | boolean>;
  decide: (item: WorkItemView, action: NeedsYouActionView | 'merge') => Promise<void | boolean>;
  assign: (item: WorkItemView, identityId: string | null) => Promise<void | boolean>;
};
export function WorkAvatar({ person, size = 24 }: { person: RoomViewIdentity; size?: number }) {
  return (
    <IdentityMark
      kind={person.kind}
      seed={person.pubkey}
      name={person.name}
      face={person.face}
      avatarUrl={person.avatar}
      size={size}
    />
  );
}
export function WorkAssigneePicker({
  people,
  onPick,
}: {
  people: readonly RoomViewIdentity[];
  onPick: (person: RoomViewIdentity | null) => void;
}) {
  return (
    <YStack
      borderWidth={1}
      borderColor="strongStroke"
      borderRadius="md"
      padding="3"
      backgroundColor="raised"
      gap="1"
      testID="work-assignee-picker"
    >
      <T v="heading">Assignee</T>
      {people.map((person) => (
        <ListItem
          key={person.pubkey}
          minHeight={44}
          padding="0"
          gap="2"
          backgroundColor="transparent"
          onPress={() => onPick(person)}
          aria-label={`Assign to ${person.name}`}
        >
          <WorkAvatar person={person} />
          <T flex={1}>{person.name}</T>
        </ListItem>
      ))}
      <ListItem
        minHeight={44}
        padding="0"
        backgroundColor="transparent"
        onPress={() => onPick(null)}
        aria-label="Unassigned"
      >
        <T>Unassigned</T>
      </ListItem>
    </YStack>
  );
}
const stop = (event?: { stopPropagation?: () => void }) => event?.stopPropagation?.();
function source(item: WorkItemView) {
  if ((item.ask?.roomKind ?? item.roomKind) === 'direct') {
    const agent = item.ask?.author ?? item.openedBy;
    return `@${agent.handle?.replace(/^@/, '') ?? agent.name}`;
  }
  const chat = item.chatName.replace(/^#/, '');
  return (item.ask?.roomKind ?? item.roomKind) === 'room'
    ? `#${chat}`
    : `#${chat} ↳ ${item.threadName.replace(/^.*? ↳ /, '')}`;
}
function AskCard({ item, actions }: { item: WorkItemView; actions: WorkBoardActions }) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const ask = item.ask!;
  const question = ask.approval?.kind === 'choice' ? ask.approval.subject : ask.text;
  const choices = ask.approval?.actions?.filter((action) => action.kind !== 'skip-choice') ?? [];
  const run = async (action: () => Promise<void | boolean>) => {
    if (busy) return;
    setBusy(true);
    try {
      if ((await action()) !== false) setReply('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      padding="3"
      gap="2"
      backgroundColor="raised"
      borderWidth={1}
      borderColor="stroke"
      borderRadius="md"
      onPress={() => actions.open(item)}
      accessibilityRole="button"
      aria-label={`Open source ${question}`}
      testID={`work-ask-${item.id}`}
    >
      <XStack gap="2" alignItems="center">
        <WorkStateMark state="needs-you" />
        {ask.author ? <WorkAvatar person={ask.author} /> : null}
        <T v="meta" color="secondary" flex={1}>
          {source(item)}
        </T>
      </XStack>
      <T>{question}</T>
      {ask.approval?.kind === 'merge' ? (
        <Btn
          kind="primary"
          label="Merge"
          disabled={busy}
          onPress={(event) => {
            stop(event);
            void run(() => actions.decide(item, 'merge'));
          }}
        >
          Merge
        </Btn>
      ) : choices.length ? (
        <XStack gap="2" alignItems="center" flexWrap="wrap">
          {choices.map((action, index) => (
            <Btn
              key={index}
              label={action.label}
              disabled={busy}
              kind={
                action.kind === 'choice' && action.optionId === item.recommendedOptionId
                  ? 'primary'
                  : 'secondary'
              }
              flexGrow={1}
              flexBasis="auto"
              paddingHorizontal="3"
              onPress={(event) => {
                stop(event);
                void run(() => actions.decide(item, action));
              }}
            >
              {action.label}
            </Btn>
          ))}
        </XStack>
      ) : !ask.approval || ask.approval.kind === 'choice' ? (
        <XStack gap="2" alignItems="center" onPress={stop}>
          <Input
            flex={1}
            minWidth={0}
            minHeight={44}
            placeholder="Reply…"
            aria-label={`Reply ${item.id}`}
            value={reply}
            onChangeText={setReply}
            onSubmitEditing={() => {
              if (reply.trim()) void run(() => actions.reply(item, reply));
            }}
          />
          <Btn
            kind="quiet"
            label={`Send ${item.id}`}
            paddingHorizontal="2"
            disabled={busy || !reply.trim()}
            onPress={(event) => {
              stop(event);
              void run(() => actions.reply(item, reply));
            }}
          >
            <T v="metaStrong">Send</T>
          </Btn>
        </XStack>
      ) : null}
    </Card>
  );
}
function WorkRow({
  item,
  columns,
  actions,
  assign,
}: {
  item: WorkItemView;
  columns: boolean;
  actions: WorkBoardActions;
  assign: () => void;
}) {
  const avatar = (
    <Btn
      kind="quiet"
      label={`Assign ${item.title}`}
      minWidth={44}
      minHeight={44}
      padding="0"
      onPress={(event) => {
        stop(event);
        assign();
      }}
    >
      {item.assignee ? (
        <WorkAvatar person={item.assignee} size={columns ? 24 : 28} />
      ) : (
        <Glyph icon={UserRound} />
      )}
    </Btn>
  );
  const marks = (
    <>
      <WorkPriorityMark priority={item.priority} />
      <WorkStateMark state={item.state} />
    </>
  );
  return columns ? (
    <Card
      padding="3"
      gap="2"
      backgroundColor="raised"
      borderWidth={1}
      borderColor="stroke"
      borderRadius="md"
      onPress={() => actions.open(item)}
      testID={`work-item-${item.id}`}
    >
      <XStack gap="2" alignItems="center">
        {marks}
        <YStack flex={1} />
        {avatar}
      </XStack>
      <T>{item.title}</T>
      <T v="meta" color="secondary">
        {source(item)}
      </T>
    </Card>
  ) : (
    <XStack
      gap="2"
      alignItems="center"
      paddingVertical="1"
      onPress={() => actions.open(item)}
      testID={`work-item-${item.id}`}
    >
      {marks}
      <YStack flex={1} minWidth={0} gap="1">
        <T v="heading">{item.title}</T>
        <T v="meta" color="secondary">
          {source(item)}
        </T>
      </YStack>
      {avatar}
    </XStack>
  );
}
const pretty = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** Approved v8 board, hosted in the existing Tags tab and application shell. */
export function WorkBoard({
  board,
  desktop,
  actions,
}: {
  board: WorkBoardView;
  desktop: boolean;
  actions: WorkBoardActions;
}) {
  const [columns, setColumns] = useState(true);
  const [expanded, setExpanded] = useState({ backlog: false, done: false });
  const [menu, setMenu] = useState<null | 'filter' | 'chat' | 'assignee' | 'priority'>(null);
  const [chat, setChat] = useState<string | null>(null);
  const [assignee, setAssignee] = useState<string | null>(null);
  const [priority, setPriority] = useState<WorkPriority | null>(null);
  const [assign, setAssign] = useState<WorkItemView | null>(null);
  const columnView = desktop && columns;
  const visible = board.items.filter(
    (item) =>
      (!chat || item.chatId === chat) &&
      (!assignee || item.assignee?.pubkey === assignee) &&
      (!priority || item.priority === priority),
  );
  const sections = [
    {
      name: 'Needs you',
      state: 'needs-you' as const,
      list: visible.filter((i) => i.state === 'needs-you' && i.ask),
      closed: false,
    },
    {
      name: 'In progress',
      state: 'in-progress' as const,
      list: visible.filter(
        (i) =>
          i.state === 'in-progress' ||
          i.state === 'in-review' ||
          (i.state === 'needs-you' && !i.ask),
      ),
      closed: false,
    },
    {
      name: 'Backlog',
      state: 'backlog' as const,
      list: visible.filter((i) => i.state === 'backlog'),
      closed: !expanded.backlog,
    },
    {
      name: 'Done',
      state: 'done' as const,
      list: visible.filter((i) => i.state === 'done'),
      closed: !expanded.done,
    },
  ];
  const choose = (
    title: string,
    options: { id: string; name: string }[],
    onPick: (id: string) => void,
  ) => (
    <YStack
      borderWidth={1}
      borderColor="strongStroke"
      borderRadius="md"
      padding="3"
      backgroundColor="raised"
      gap="1"
    >
      <T v="heading">{title}</T>
      {options.map((option) => (
        <ListItem
          key={option.id}
          minHeight={44}
          padding="0"
          backgroundColor="transparent"
          onPress={() => onPick(option.id)}
          aria-label={`${title} ${option.name}`}
        >
          <T>{option.name}</T>
        </ListItem>
      ))}
    </YStack>
  );
  const chip = (label: string, remove: () => void) => (
    <Btn kind="secondary" label={`Remove ${label} filter`} onPress={remove} paddingHorizontal="2">
      <T v="meta">{label}</T>
      <Glyph icon={X} size={14} />
    </Btn>
  );
  return (
    <YStack flex={1} minHeight={0} testID="work-board">
      <ScrollView keyboardShouldPersistTaps="handled">
        <YStack padding="4">
          <XStack alignItems="center" gap="2" minHeight={44} flexWrap="wrap" marginBottom="2">
            <Btn
              kind="quiet"
              label="Filter"
              paddingHorizontal="0"
              onPress={() => {
                setMenu(menu ? null : 'filter');
                setAssign(null);
              }}
            >
              <Glyph icon={Filter} size={16} />
              <T v="meta">Filter</T>
            </Btn>
            {chat
              ? chip(`#${board.chats.find((c) => c.id === chat)?.name}`, () => setChat(null))
              : null}
            {assignee
              ? chip(
                  assignee === board.viewerId
                    ? 'Me'
                    : (board.people.find((p) => p.pubkey === assignee)?.name ?? assignee),
                  () => setAssignee(null),
                )
              : null}
            {priority ? chip(pretty(priority), () => setPriority(null)) : null}
            <YStack flex={1} />
            {desktop ? (
              <Btn
                kind="quiet"
                label={columns ? 'List view' : 'Columns view'}
                paddingHorizontal="0"
                onPress={() => setColumns(!columns)}
              >
                <Glyph icon={columns ? List : Columns3} size={16} />
                <T v="meta">{columns ? 'List' : 'Columns'}</T>
              </Btn>
            ) : null}
          </XStack>
          <XStack
            gap="3"
            alignItems="flex-start"
            flexDirection={columnView ? 'row' : 'column'}
            width="100%"
            maxWidth={columnView ? undefined : 720}
            alignSelf="center"
            testID="work-sections"
          >
            {sections.map((section) => (
              <YStack
                key={section.state}
                flex={columnView ? 1 : undefined}
                width={columnView ? undefined : '100%'}
                minWidth={0}
                gap="2"
              >
                {!columnView && (section.state === 'backlog' || section.state === 'done') ? (
                  <Separator borderColor="stroke" />
                ) : null}
                <XStack
                  minHeight={44}
                  gap="2"
                  alignItems="center"
                  onPress={() => {
                    if (section.state === 'backlog' || section.state === 'done')
                      setExpanded({ ...expanded, [section.state]: !expanded[section.state] });
                  }}
                  accessibilityRole="button"
                  aria-label={`${section.name} ${section.list.length}`}
                >
                  <Glyph icon={section.closed ? ChevronRight : ChevronDown} size={16} />
                  <WorkStateMark state={section.state} />
                  <T v="heading" color={section.state === 'needs-you' ? 'needsYou' : 'ink'}>
                    {section.name}
                  </T>
                  <T v="meta" color={section.state === 'needs-you' ? 'needsYou' : 'secondary'}>
                    {section.list.length}
                  </T>
                  {section.state === 'done' ? (
                    <T v="meta" color="secondary">
                      Last 7 days
                    </T>
                  ) : null}
                </XStack>
                {!section.closed
                  ? section.list.map((item) =>
                      item.ask ? (
                        <AskCard key={item.id} item={item} actions={actions} />
                      ) : (
                        <WorkRow
                          key={item.id}
                          item={item}
                          columns={columnView}
                          actions={actions}
                          assign={() => {
                            setAssign(item);
                            setMenu(null);
                          }}
                        />
                      ),
                    )
                  : null}
              </YStack>
            ))}
          </XStack>
        </YStack>
      </ScrollView>
      {menu ? (
        <YStack width={280} maxWidth="100%" position="absolute" top={68} left={16} zIndex={100}>
          {menu === 'filter'
            ? choose(
                'Filter',
                [
                  { id: 'chat', name: 'Chat' },
                  { id: 'assignee', name: 'Assignee' },
                  { id: 'priority', name: 'Priority' },
                ],
                (id) => setMenu(id as typeof menu),
              )
            : menu === 'chat'
              ? choose(
                  'Filter chat',
                  [
                    { id: '', name: 'All chats' },
                    ...board.chats.map((c) => ({ id: c.id, name: `#${c.name}` })),
                  ],
                  (id) => {
                    setChat(id || null);
                    setMenu(null);
                  },
                )
              : menu === 'assignee'
                ? choose(
                    'Filter assignee',
                    [
                      { id: '', name: 'Anyone' },
                      ...board.people.map((p) => ({
                        id: p.pubkey,
                        name: p.pubkey === board.viewerId ? 'Me' : p.name,
                      })),
                    ],
                    (id) => {
                      setAssignee(id || null);
                      setMenu(null);
                    },
                  )
                : choose(
                    'Filter priority',
                    [
                      { id: '', name: 'Any priority' },
                      ...WORK_PRIORITIES.map((p) => ({ id: p, name: pretty(p) })),
                    ],
                    (id) => {
                      setPriority((id as WorkPriority) || null);
                      setMenu(null);
                    },
                  )}
        </YStack>
      ) : null}
      {assign ? (
        <YStack
          width={304}
          maxWidth="100%"
          maxHeight="85%"
          position="absolute"
          top={68}
          right={16}
          zIndex={110}
        >
          <ScrollView>
            <WorkAssigneePicker
              people={board.people}
              onPick={(person) => {
                const task = assign;
                setAssign(null);
                void actions.assign(task, person?.pubkey ?? null);
              }}
            />
          </ScrollView>
        </YStack>
      ) : null}
    </YStack>
  );
}
