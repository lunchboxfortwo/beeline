import React, { useMemo, useRef, useState } from 'react';
import { Input, ListItem, ScrollView, XStack, YStack } from 'tamagui';
import { ChevronRight, X } from 'lucide-react-native';
import type {
  NeedsYouActionView,
  RoomViewIdentity,
  WorkBoardView,
  WorkItemView,
} from '@beeline/api-contract/phone';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { compactRelativeTime } from '@/buzz/relative-time';
import { Btn, Glyph, HEIGHT, SheetFrame, T } from '@/ui/grammar';
import { TabHeader, useScrolledUnder } from '@/ui/shell/TabHeader';
import { WorkStateMark } from './WorkMarks';

export type WorkBoardActions = {
  open: (item: WorkItemView) => void;
  reply: (item: WorkItemView, text: string) => Promise<void | boolean>;
  decide: (item: WorkItemView, action: NeedsYouActionView | 'merge') => Promise<void | boolean>;
  assign: (item: WorkItemView, identityId: string | null) => Promise<void | boolean>;
  clear: (item: WorkItemView) => Promise<void | boolean>;
  clearAll: () => Promise<void | boolean>;
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
/** `#chat ↳ thread` for a thread, `#chat` for a chat, `@agent` for a DM. */
function source(item: WorkItemView) {
  if ((item.ask?.roomKind ?? item.roomKind) === 'direct') {
    const agent = item.ask?.author ?? item.openedBy;
    return `@${agent.handle?.replace(/^@/, '') ?? agent.name}`;
  }
  const chat = item.chatName.replace(/^#/, '');
  return (item.ask?.roomKind ?? item.roomKind) === 'corner'
    ? `#${chat} ↳ ${item.threadName.replace(/^.*? ↳ /, '')}`
    : `#${chat}`;
}
/** One Needs you row: the thread itself, with its first ask and how many wait there. */
function AskCard({ item, actions }: { item: WorkItemView; actions: WorkBoardActions }) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const ask = item.ask!;
  const question = ask.approval?.kind === 'choice' ? ask.approval.subject : ask.text;
  const choices = ask.approval?.actions?.filter((action) => action.kind !== 'skip-choice') ?? [];
  const count = item.askIds?.length ?? 1;
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
    <YStack
      marginHorizontal="3"
      marginVertical="1"
      padding="3"
      gap="2"
      backgroundColor="raised"
      borderWidth={1}
      borderColor="stroke"
      borderRadius="md"
      onPress={() => actions.open(item)}
      accessibilityRole="button"
      aria-label={`Open ${source(item)}`}
      testID={`work-ask-${item.id}`}
    >
      <XStack gap="2" alignItems="center">
        <WorkStateMark state="needs-you" />
        <T v="meta" color="secondary" flex={1} numberOfLines={1}>
          {source(item)}
        </T>
        {count > 1 ? (
          <YStack borderWidth={1} borderColor="stroke" borderRadius="full" paddingHorizontal="2">
            <T v="meta" color="secondary">{`${count} asks`}</T>
          </YStack>
        ) : null}
        <Btn
          kind="quiet"
          label={`Clear ${source(item)}`}
          minHeight={0}
          padding="0"
          hitSlop={12}
          disabled={busy}
          onPress={(event) => {
            stop(event);
            void run(() => actions.clear(item));
          }}
          testID={`work-clear-${item.id}`}
        >
          <Glyph icon={X} size={14} />
        </Btn>
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
          <T v="meta" color="primaryInk">
            Merge
          </T>
        </Btn>
      ) : choices.length ? (
        <XStack gap="2" alignItems="stretch" flexWrap="wrap">
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
              flexBasis={0}
              paddingHorizontal="3"
              onPress={(event) => {
                stop(event);
                void run(() => actions.decide(item, action));
              }}
            >
              <T
                v="meta"
                textAlign="center"
                color={
                  action.kind === 'choice' && action.optionId === item.recommendedOptionId
                    ? 'primaryInk'
                    : 'ink'
                }
              >
                {action.label}
              </T>
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
    </YStack>
  );
}
/** Backlog, In progress and Done rows: status glyph, the name, the assignee at the right. */
function WorkRow({ item, onPress }: { item: WorkItemView; onPress: () => void }) {
  return (
    <ListItem
      minHeight={44}
      paddingHorizontal="4"
      paddingVertical="2"
      gap="3"
      backgroundColor="transparent"
      onPress={onPress}
      accessibilityRole="button"
      aria-label={item.title}
      testID={`work-item-${item.id}`}
    >
      <WorkStateMark state={item.state} idle={item.idle} />
      <T flex={1} numberOfLines={1}>
        {item.title}
      </T>
      {item.assignee ? <WorkAvatar person={item.assignee} /> : null}
    </ListItem>
  );
}
function SectionHead({
  title,
  count,
  note,
  open,
  onToggle,
  right,
  testID,
}: {
  title: string;
  count: number;
  note?: string;
  open?: boolean;
  onToggle?: () => void;
  right?: React.ReactNode;
  testID: string;
}) {
  return (
    <ListItem
      minHeight={44}
      paddingHorizontal="4"
      paddingTop="3"
      paddingBottom="0"
      gap="2"
      backgroundColor="transparent"
      onPress={onToggle}
      disabled={!onToggle}
      accessibilityRole={onToggle ? 'button' : undefined}
      aria-expanded={onToggle ? open : undefined}
      aria-label={`${title} ${count}`}
      testID={testID}
    >
      <T v="metaStrong" color="secondary">
        {title}
      </T>
      <T v="meta" color="secondary" flex={1}>
        {note ? `${count} · ${note}` : count}
      </T>
      {right ?? (onToggle && !open ? <Glyph icon={ChevronRight} size={14} /> : null)}
    </ListItem>
  );
}
const STATE_LABEL = {
  'needs-you': 'Waiting',
  'in-progress': 'In progress',
  'in-review': 'In review',
  backlog: 'Backlog',
  done: 'Done',
} as const;
/** The tap sheet: objective and details live here, never on the row. */
function WorkSheet({
  item,
  people,
  now,
  close,
  actions,
}: {
  item: WorkItemView | null;
  people: readonly RoomViewIdentity[];
  now: number;
  close: () => void;
  actions: WorkBoardActions;
}) {
  const [assigning, setAssigning] = useState(false);
  // The sheet keeps its last item while it slides away.
  const last = useRef(item);
  if (item) last.current = item;
  const shown = last.current;
  const where = shown ? source(shown) : '';
  const waiting = !shown
    ? ''
    : shown.assignee?.name ??
      (shown.state === 'backlog' ? 'Nothing · not started' : 'Nobody');
  const facts: [string, string][] = shown
    ? [
        ['Added by', shown.openedBy.name],
        ['Added in', where],
        ['Age', compactRelativeTime(shown.createdAt, now)],
      ]
    : [];
  return (
    <SheetFrame
      open={Boolean(item)}
      close={() => {
        setAssigning(false);
        close();
      }}
      title={shown?.title ?? ''}
      testID="work-sheet"
    >
      {shown ? (
        <YStack gap="3">
          <XStack gap="2" alignItems="center">
            <WorkStateMark state={shown.state} idle={shown.idle} />
            <T v="meta" color="secondary">
              {shown.idle ? 'Idle' : STATE_LABEL[shown.state]}
            </T>
          </XStack>
          {shown.objective ? <T testID="work-sheet-objective">{shown.objective}</T> : null}
          <YStack>
            {facts.map(([label, value]) => (
              <XStack
                key={label}
                minHeight={44}
                alignItems="center"
                gap="3"
                borderTopWidth={1}
                borderColor="stroke"
              >
                <T v="meta" color="secondary" flex={1}>
                  {label}
                </T>
                <T v="meta">{value}</T>
              </XStack>
            ))}
            <ListItem
              minHeight={44}
              padding="0"
              gap="3"
              borderTopWidth={1}
              borderColor="stroke"
              backgroundColor="transparent"
              onPress={() => setAssigning(!assigning)}
              accessibilityRole="button"
              aria-label="Change assignee"
              testID="work-sheet-assignee"
            >
              <T v="meta" color="secondary" flex={1}>
                Waiting on
              </T>
              <T v="meta">{waiting}</T>
            </ListItem>
          </YStack>
          {assigning ? (
            <WorkAssigneePicker
              people={people}
              onPick={(person) => {
                setAssigning(false);
                close();
                void actions.assign(shown, person?.pubkey ?? null);
              }}
            />
          ) : null}
          <Btn
            label={`Open ${where}`}
            onPress={() => {
              close();
              actions.open(shown);
            }}
            testID="work-sheet-open"
          >
            <T v="body">{`Open ${shown.roomKind === 'corner' ? shown.threadName.replace(/^.*? ↳ /, '') : where}`}</T>
          </Btn>
        </YStack>
      ) : null}
    </SheetFrame>
  );
}
type Menu = null | 'filter' | 'chat' | 'assignee';
/** The Tasks screen: only what needs you on top, then the work in flight. */
export function WorkBoard({
  board,
  desktop,
  actions,
  now = Date.now(),
}: {
  board: WorkBoardView;
  desktop: boolean;
  actions: WorkBoardActions;
  now?: number;
}) {
  const [open, setOpen] = useState({ progress: true, backlog: true, done: false });
  const [menu, setMenu] = useState<Menu>(null);
  const [chat, setChat] = useState<string | null>(null);
  const [assignee, setAssignee] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkItemView | null>(null);
  const [clearing, setClearing] = useState(false);
  const { scrolled, scrollProps } = useScrolledUnder();
  const visible = board.items.filter(
    (item) =>
      (!chat || item.chatId === chat || item.roomId === chat) &&
      (!assignee || item.assignee?.pubkey === assignee),
  );
  const needs = visible.filter((item) => item.ask);
  const progress = visible.filter(
    (item) =>
      !item.ask &&
      (item.state === 'in-progress' || item.state === 'in-review' || item.state === 'needs-you'),
  );
  const backlog = visible.filter((item) => item.state === 'backlog');
  const done = visible.filter((item) => item.state === 'done');
  const filter = useMemo(
    () => (
      <Btn
        kind="secondary"
        label="Filter"
        minHeight={0}
        paddingHorizontal="3"
        paddingVertical="1"
        onPress={() => setMenu((current) => (current ? null : 'filter'))}
        testID="work-filter"
      >
        <T v="meta">Filter</T>
      </Btn>
    ),
    [],
  );
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
  const rows = (list: WorkItemView[]) =>
    list.map((item) => <WorkRow key={item.id} item={item} onPress={() => setDetail(item)} />);
  return (
    <YStack flex={1} minHeight={0} testID="work-board">
      {desktop ? (
        <XStack justifyContent="flex-end" paddingHorizontal="4" paddingTop="3">
          {filter}
        </XStack>
      ) : (
        <TabHeader workspaceName={board.workspaceName} scrolled={scrolled} actions={filter} />
      )}
      {chat || assignee ? (
        <XStack gap="2" paddingHorizontal="4" paddingTop="2" flexWrap="wrap">
          {chat
            ? chip(`#${board.chats.find((c) => c.id === chat)?.name ?? ''}`, () => setChat(null))
            : null}
          {assignee
            ? chip(
                assignee === board.viewerId
                  ? 'Me'
                  : (board.people.find((p) => p.pubkey === assignee)?.name ?? assignee),
                () => setAssignee(null),
              )
            : null}
        </XStack>
      ) : null}
      <ScrollView flex={1} minHeight={0} keyboardShouldPersistTaps="handled" {...scrollProps}>
        <YStack width="100%" maxWidth={720} alignSelf="center" paddingBottom="8" testID="work-sections">
          {needs.length ? (
            <>
              <SectionHead
                title="Needs you"
                count={needs.length}
                testID="work-section-needs-you"
                right={
                  <Btn
                    kind="quiet"
                    label="Clear all"
                    minHeight={0}
                    padding="0"
                    hitSlop={12}
                    disabled={clearing}
                    onPress={() => {
                      setClearing(true);
                      void actions.clearAll().finally(() => setClearing(false));
                    }}
                    testID="work-clear-all"
                  >
                    <T v="meta" color="secondary">
                      Clear all
                    </T>
                  </Btn>
                }
              />
              {needs.map((item) => (
                <AskCard key={item.id} item={item} actions={actions} />
              ))}
            </>
          ) : null}
          <SectionHead
            title="In progress"
            count={progress.length}
            open={open.progress}
            onToggle={() => setOpen((current) => ({ ...current, progress: !current.progress }))}
            testID="work-section-in-progress"
          />
          {open.progress ? rows(progress) : null}
          <SectionHead
            title="Backlog"
            count={backlog.length}
            open={open.backlog}
            onToggle={() => setOpen((current) => ({ ...current, backlog: !current.backlog }))}
            testID="work-section-backlog"
          />
          {open.backlog ? rows(backlog) : null}
          <SectionHead
            title="Done"
            count={done.length}
            note="last 7 days"
            open={open.done}
            onToggle={() => setOpen((current) => ({ ...current, done: !current.done }))}
            testID="work-section-done"
          />
          {open.done ? rows(done) : null}
        </YStack>
      </ScrollView>
      {menu ? (
        <YStack
          width={280}
          maxWidth="100%"
          position="absolute"
          top={HEIGHT.control + 24}
          right={16}
          zIndex={100}
        >
          {menu === 'filter'
            ? choose(
                'Filter',
                [
                  { id: 'chat', name: 'Chat' },
                  { id: 'assignee', name: 'Assignee' },
                ],
                (id) => setMenu(id as Menu),
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
              : choose(
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
                )}
        </YStack>
      ) : null}
      <WorkSheet
        item={detail}
        people={board.people}
        now={now}
        close={() => setDetail(null)}
        actions={actions}
      />
    </YStack>
  );
}
