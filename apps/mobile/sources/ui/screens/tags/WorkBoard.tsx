import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { Input, ListItem, ScrollView, Separator, XStack, YStack } from 'tamagui';
import { ChevronDown, ChevronRight, CornerDownRight, Filter, Plus, X } from 'lucide-react-native';
import type {
  NeedsYouActionView,
  WorkBoardView,
  WorkItemView,
} from '@beeline/api-contract/phone';
import { MonoMarkdown } from '@/components/buzz/MonoMarkdown';
import { Btn, Glyph, HEIGHT, T, TypedView } from '@/ui/grammar';
import { TabHeader, useScrolledUnder } from '@/ui/shell/TabHeader';
import { compactRelativeTime } from '@/buzz/relative-time';
import { NewTaskSheet, type CreateWorkTaskInput } from './NewTaskSheet';
import { WorkAssigneePicker, WorkAvatar } from './WorkAssigneePicker';
import { WorkSheet } from './WorkItemDetail';
import { WorkStateMark } from './WorkMarks';
import {
  canDragWorkItem,
  clampScrollOffset,
  edgeAutoScrollDelta,
  projectBoundsForScroll,
  resolveDropSectionForTouch,
  sectionTargetState,
  shouldMoveWorkItem,
  webDragSourceProps,
  webDropTargetProps,
  type DropSectionKey,
  type DropWorkState,
  type SectionBounds,
} from './work-board-dnd';

export { WorkAssigneePicker, WorkAvatar } from './WorkAssigneePicker';
export type { CreateWorkTaskInput } from './NewTaskSheet';

export type WorkBoardActions = {
  open: (item: WorkItemView) => void;
  reply: (item: WorkItemView, text: string) => Promise<void | boolean>;
  decide: (item: WorkItemView, action: NeedsYouActionView) => Promise<void | boolean>;
  assign: (item: WorkItemView, identityId: string | null) => Promise<void | boolean>;
  move?: (item: WorkItemView, state: DropWorkState) => Promise<void | boolean>;
  create?: (input: CreateWorkTaskInput) => Promise<void | boolean>;
  clear: (item: WorkItemView) => Promise<void | boolean>;
  clearAll: () => Promise<void | boolean>;
};
const stop = (event?: { stopPropagation?: () => void }) => event?.stopPropagation?.();
/** `#chat ↳ thread` for a thread, `#chat` for a chat, `@agent` for a DM. */
function source(item: WorkItemView) {
  if(item.source) return item.source.label;
  if ((item.ask?.roomKind ?? item.roomKind) === 'direct') {
    const agent = item.ask?.author ?? item.openedBy;
    return `@${agent.handle?.replace(/^@/, '') ?? agent.name}`;
  }
  const chat = item.chatName.replace(/^#/, '');
  return (item.ask?.roomKind ?? item.roomKind) === 'corner'
    ? `#${chat} ↳ ${item.threadName.replace(/^.*? ↳ /, '')}`
    : `#${chat}`;
}
/** Each Needs you row owns one question and its answer buttons. */
function AskCard({ item, actions, now, desktop }: { item: WorkItemView; actions: WorkBoardActions; now: number; desktop: boolean }) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const ask = item.ask!;
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
        <WorkAvatar person={ask.author ?? item.openedBy} />
        <T v="metaStrong" flexShrink={1} numberOfLines={1}>
          {(ask.author ?? item.openedBy).name}
        </T>
        <T v="meta" color="secondary" flex={1} minWidth={desktop ? 56 : undefined} numberOfLines={1}>
          {source(item)}
        </T>
        <T v="meta" color="secondary">{compactRelativeTime(ask.createdAt, now)}</T>
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
      {item.brief && (!ask.approval || ask.approval.kind === 'choice') ? (
        // Question and brief are enough to decide; the full message is one tap away.
        <YStack gap="1">
          <T v="heading">{ask.approval?.subject ?? ask.text}</T>
          <T>{item.brief}</T>
        </YStack>
      ) : (
        <>
          <TypedView view={MonoMarkdown} markdown={ask.text} />
          {ask.approval?.kind === 'choice' && !ask.text.includes(ask.approval.subject) ? (
            <T>{ask.approval.subject}</T>
          ) : null}
        </>
      )}
      {choices.length ? (
        <XStack gap="2" alignItems="stretch" flexWrap="wrap">
          {choices.map((action, index) => (
            <Btn
              key={index}
              label={action.label}
              disabled={busy}
              kind="secondary"
              flexGrow={1}
              flexBasis="auto"
              paddingHorizontal="3"
              onPress={(event) => {
                stop(event);
                void run(() => actions.decide(item, action));
              }}
            >
              <T
                v="meta"
                textAlign="center"
                color="ink"
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
/** The assignee column, held open when a task has none so every state mark stays in one column. */
const AVATAR = 24;
/**
 * A Backlog, In progress or Done row: ↳ and the name, then its state mark in the board's mark
 * column, then the assignee. The mark opens the task sheet, where the state changes.
 */
function WorkRow({
  item,
  onPress,
  onState,
  canDrag,
  dragging,
  enableWebDrag,
  onDragStart,
  onDragEnd,
}: {
  item: WorkItemView;
  onPress: () => void;
  onState: () => void;
  canDrag: boolean;
  dragging: boolean;
  enableWebDrag: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const dragProps = webDragSourceProps(canDrag && enableWebDrag, item.id, onDragStart, onDragEnd);
  return (
    <XStack
      alignItems="center"
      paddingLeft="4"
      paddingRight="4"
      gap="2"
      opacity={dragging ? 0.5 : 1}
      testID={`work-row-${item.id}`}
      {...dragProps}
    >
      <ListItem
        flex={1}
        minWidth={0}
        minHeight={44}
        padding="0"
        paddingVertical="2"
        gap="3"
        backgroundColor="transparent"
        onPress={onPress}
        onLongPress={canDrag ? onDragStart : undefined}
        accessibilityRole="button"
        aria-label={item.title}
        testID={`work-item-${item.id}`}
      >
        <Glyph icon={CornerDownRight} size={16} />
        <T v="meta" flex={1} numberOfLines={1}>
          {item.title}
        </T>
      </ListItem>
      <Btn kind="icon" label={`Change state of ${item.title}`} onPress={onState} testID={`work-state-mark-${item.id}`}>
        <WorkStateMark state={item.state} idle={item.idle} />
      </Btn>
      <YStack width={AVATAR} height={AVATAR} flexShrink={0}>
        {item.assignee ? <WorkAvatar person={item.assignee} size={AVATAR} /> : null}
      </YStack>
    </XStack>
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
      marginTop="3"
      paddingHorizontal="4"
      paddingVertical="0"
      gap="2"
      backgroundColor="transparent"
      onPress={onToggle}
      accessibilityRole={onToggle ? 'button' : undefined}
      aria-expanded={onToggle ? open : undefined}
      aria-label={`${title} ${count}`}
      testID={testID}
    >
      {/* An empty phone section keeps the chevron's width, so the titles stay in line. */}
      {onToggle ? <Glyph icon={open ? ChevronDown : ChevronRight} size={14} /> : open !== undefined ? <YStack width={14} /> : null}
      <T v="metaStrong">
        {title}
      </T>
      {right ? (
        <>
          <T v="meta" color="secondary" flex={1}>
            {note ? `${count} · ${note}` : count}
          </T>
          {right}
        </>
      ) : (
        <>
          {/* A list section's count sits in its rows' state-mark column. */}
          <T v="meta" color="secondary" flex={1}>
            {note ?? ''}
          </T>
          <XStack width={HEIGHT.control} justifyContent="center" testID={`${testID}-count`}>
            <T v="meta" color="secondary">{String(count)}</T>
          </XStack>
          <YStack width={AVATAR} />
        </>
      )}
    </ListItem>
  );
}
type Menu = null | 'filter' | 'chat' | 'assignee';
/** A thread's own row opens that thread; Backlog and other stored tasks open the sheet. */
const hasThread = (item: WorkItemView) => item.roomKind === 'corner' && item.id === item.roomId;
type MeasurableHost = {
  measureInWindow?: (cb: (x: number, y: number, width: number, height: number) => void) => void;
};

type ScrollableHost = MeasurableHost & {
  scrollTo?: (options: { y: number; animated?: boolean }) => void;
};

const AUTO_SCROLL_INTERVAL_MS = 32;

/** The Tasks screen: only what needs you on top, then the work in flight. On a
 * phone the other sections start collapsed; desktop columns always stay open. */
export function WorkBoard({
  board,
  desktop,
  actions,
  now = Date.now(),
  initialChatId,
}: {
  board: WorkBoardView;
  desktop: boolean;
  actions: WorkBoardActions;
  now?: number;
  initialChatId?: string;
}) {
  const [open, setOpen] = useState({
    progress: false,
    backlog: Boolean(initialChatId),
    done: false,
  });
  const [menu, setMenu] = useState<Menu>(null);
  const [chat, setChat] = useState<string | null>(initialChatId ?? null);
  const [assignee, setAssignee] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkItemView | null>(null);
  const [creating, setCreating] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<DropSectionKey | null>(null);
  const draggingIdRef = useRef<string | null>(null);
  const dragOverRef = useRef<DropSectionKey | null>(null);
  const scrollRef = useRef<ScrollableHost | null>(null);
  const scrollViewport = useRef<SectionBounds | null>(null);
  /** Authoritative vertical scroll offset: owned by onScroll at rest and by auto-scroll during drag. */
  const scrollOffsetY = useRef(0);
  const dragStartScrollY = useRef(0);
  const scrollContentHeight = useRef(0);
  const lastTouchPageY = useRef<number | null>(null);
  const autoScrollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const boardRef = useRef<MeasurableHost | null>(null);
  const dragStartBoardWindowY = useRef<number | null>(null);
  const sectionRefs = useRef<Partial<Record<DropSectionKey, MeasurableHost | null>>>({});
  const dragStartSectionBounds = useRef<Partial<Record<DropSectionKey, SectionBounds>>>({});
  const sectionLayouts = useRef<Partial<Record<DropSectionKey, SectionBounds>>>({});
  const { scrolled, scrollProps } = useScrolledUnder();

  const updateDragOver = (next: DropSectionKey | null) => {
    dragOverRef.current = next;
    setDragOver((current) => (current === next ? current : next));
  };

  const stopAutoScroll = () => {
    if (autoScrollTimer.current !== null) {
      clearInterval(autoScrollTimer.current);
      autoScrollTimer.current = null;
    }
  };

  useEffect(() => () => stopAutoScroll(), []);

  const resolveCurrentTouchTarget = (pageY: number | null | undefined): DropSectionKey | null => {
    if (typeof pageY !== 'number') return null;
    const scrolledSinceStart = scrollOffsetY.current - dragStartScrollY.current;
    return resolveDropSectionForTouch({
      pageY,
      windowBounds: projectBoundsForScroll(dragStartSectionBounds.current, scrolledSinceStart),
      boardLayouts: sectionLayouts.current,
      boardWindowY:
        dragStartBoardWindowY.current !== null
          ? dragStartBoardWindowY.current - scrolledSinceStart
          : null,
    });
  };

  const refreshHoverTarget = (pageY: number | null) => {
    if (typeof pageY !== 'number') return;
    updateDragOver(resolveCurrentTouchTarget(pageY));
  };

  const measureDropTargetsAtDragStart = () => {
    dragStartScrollY.current = scrollOffsetY.current;
    dragStartSectionBounds.current = {};
    dragStartBoardWindowY.current = null;
    scrollRef.current?.measureInWindow?.((_x, y, _width, height) => {
      if (height > 0) scrollViewport.current = { y, height };
    });
    boardRef.current?.measureInWindow?.((_x, y) => {
      dragStartBoardWindowY.current = y;
      refreshHoverTarget(lastTouchPageY.current);
    });
    for (const key of ['progress', 'backlog', 'done'] as const) {
      sectionRefs.current[key]?.measureInWindow?.((_x, y, _width, height) => {
        dragStartSectionBounds.current[key] = { y, height };
        refreshHoverTarget(lastTouchPageY.current);
      });
    }
  };

  const stepAutoScroll = () => {
    if (!draggingIdRef.current) {
      stopAutoScroll();
      return;
    }
    const viewport = scrollViewport.current;
    const delta = edgeAutoScrollDelta({ pageY: lastTouchPageY.current, viewport });
    if (!delta || !viewport) {
      stopAutoScroll();
      return;
    }
    const contentHeight = Math.max(
      scrollContentHeight.current,
      ...(['progress', 'backlog', 'done'] as const).map((key) => {
        const box = sectionLayouts.current[key];
        return box ? box.y + box.height : 0;
      }),
    );
    const nextY = clampScrollOffset(scrollOffsetY.current + delta, contentHeight, viewport.height);
    if (nextY === scrollOffsetY.current) {
      stopAutoScroll();
      return;
    }
    scrollOffsetY.current = nextY;
    scrollRef.current?.scrollTo?.({ y: nextY, animated: false });
    refreshHoverTarget(lastTouchPageY.current);
  };

  const syncAutoScroll = (pageY: number | undefined) => {
    lastTouchPageY.current = typeof pageY === 'number' ? pageY : null;
    const delta = edgeAutoScrollDelta({
      pageY: lastTouchPageY.current,
      viewport: scrollViewport.current,
    });
    if (!delta) {
      stopAutoScroll();
      return;
    }
    if (autoScrollTimer.current === null) {
      stepAutoScroll();
      if (
        draggingIdRef.current &&
        edgeAutoScrollDelta({ pageY: lastTouchPageY.current, viewport: scrollViewport.current })
      ) {
        autoScrollTimer.current = setInterval(stepAutoScroll, AUTO_SCROLL_INTERVAL_MS);
      }
    }
  };

  useEffect(() => {
    if (!initialChatId) return;
    setChat(initialChatId);
    setOpen((current) => (current.backlog ? current : { ...current, backlog: true }));
  }, [initialChatId]);

  const canMove = Boolean(actions.move);
  const enableWebDrag = desktop || Platform.OS === 'web';
  const draggedItem = draggingId ? board.items.find((item) => item.id === draggingId) ?? null : null;
  const finishDrag = () => {
    stopAutoScroll();
    lastTouchPageY.current = null;
    draggingIdRef.current = null;
    setDraggingId(null);
    updateDragOver(null);
  };
  const startDrag = (item: WorkItemView) => {
    if (!canDragWorkItem(item, canMove)) return;
    draggingIdRef.current = item.id;
    if (!desktop) measureDropTargetsAtDragStart();
    setDraggingId(item.id);
  };
  const dropOn = (target: DropSectionKey, transferredId?: string) => {
    const id = transferredId || draggingIdRef.current || draggingId;
    finishDrag();
    if (!id || !actions.move) return;
    const item = board.items.find((entry) => entry.id === id);
    if (!item || !shouldMoveWorkItem(item, target)) return;
    void actions.move(item, sectionTargetState(target));
  };
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
  const canCreate = Boolean(actions.create) && board.chats.length > 0;
  const headerActions = useMemo(
    () => (
      <XStack gap="1" alignItems="center">
        {canCreate ? (
          desktop ? (
            <Btn
              kind="secondary"
              label="New task"
              paddingHorizontal="3"
              onPress={() => setCreating(true)}
              testID="work-new-task"
            >
              <Glyph icon={Plus} size={16} color="ink" />
              <T v="meta">New task</T>
            </Btn>
          ) : (
            <Btn
              kind="icon"
              label="New task"
              onPress={() => setCreating(true)}
              testID="work-new-task"
            >
              <Glyph icon={Plus} />
            </Btn>
          )
        ) : null}
        <Btn
          kind="icon"
          label="Filter"
          onPress={() => setMenu((current) => (current ? null : 'filter'))}
          testID="work-filter"
        >
          <Glyph icon={Filter} />
        </Btn>
      </XStack>
    ),
    [canCreate, desktop],
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
    list.map((item) => {
      const draggable = canDragWorkItem(item, canMove);
      return (
        <WorkRow
          key={item.id}
          item={item}
          onPress={() => {
            if (draggingId) {
              finishDrag();
              return;
            }
            if (hasThread(item)) actions.open(item);
            else setDetail(item);
          }}
          onState={() => setDetail(item)}
          canDrag={draggable}
          dragging={draggingId === item.id}
          enableWebDrag={enableWebDrag}
          onDragStart={() => {
            startDrag(item);
          }}
          onDragEnd={finishDrag}
        />
      );
    });
  const sections = [
    { key: 'progress', title: 'In progress', list: progress, testID: 'work-section-in-progress' },
    { key: 'backlog', title: 'Backlog', list: backlog, testID: 'work-section-backlog' },
    { key: 'done', title: 'Done', list: done, note: 'last 7 days', testID: 'work-section-done' },
  ] as const;
  const needsHead = (
    <SectionHead
      title="Needs you"
      count={needs.length}
      testID="work-section-needs-you"
      right={
        needs.length ? (
          <Btn
            kind="quiet"
            label="Clear all"
            minHeight={0}
            padding="0"
            hitSlop={12}
            onPress={() => void actions.clearAll()}
            testID="work-clear-all"
          >
            <T v="meta">Clear all</T>
          </Btn>
        ) : undefined
      }
    />
  );
  const needsBody = needs.length ? (
    needs.map((item) => <AskCard key={item.id} item={item} actions={actions} now={now} desktop={desktop} />)
  ) : (
    <YStack paddingHorizontal="6" paddingTop="8" paddingBottom="5" gap="1" alignItems="center" testID="work-calm">
      {/* A no-break space keeps "now" off a line of its own in a narrow column. */}
      <T v="heading" textAlign="center">
        {'Nothing needs you\u00a0now'}
      </T>
      <T color="secondary" textAlign="center">
        Go do something else.
      </T>
    </YStack>
  );
  const desktopColumns = (
    <XStack width="100%" minWidth={1160} gap="4" padding="4" alignItems="flex-start" testID="work-sections">
      <YStack flex={1} minWidth={300} testID="work-column-needs-you">
        {needsHead}
        {needsBody}
      </YStack>
      {sections.map((section) => {
        const dropProps = webDropTargetProps(
          canMove && enableWebDrag,
          () => {
            if (dragOver !== section.key) setDragOver(section.key);
          },
          () => {
            if (dragOver === section.key) setDragOver(null);
          },
          (transferredId) => dropOn(section.key, transferredId),
        );
        const highlighted = dragOver === section.key;
        return (
          <YStack
            key={section.key}
            flex={1}
            minWidth={260}
            borderWidth={highlighted ? 1 : 0}
            borderColor="needsYou"
            borderRadius="md"
            testID={`work-column-${section.key}`}
            {...dropProps}
          >
            <SectionHead
              title={section.title}
              count={section.list.length}
              note={'note' in section ? section.note : undefined}
              testID={section.testID}
            />
            {rows(section.list)}
          </YStack>
        );
      })}
    </XStack>
  );
  return (
    <YStack flex={1} minHeight={0} testID="work-board">
      {desktop ? (
        <>
          <XStack height={HEIGHT.tabBar} alignItems="center" paddingHorizontal="4" testID="work-board-header">
            <T v="title" flex={1}>Tasks</T>
            {headerActions}
          </XStack>
          <Separator borderColor="stroke" />
        </>
      ) : (
        <TabHeader workspaceName={board.workspaceName} scrolled={scrolled} actions={headerActions} />
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
      {desktop ? (
        Platform.OS === 'web' ? (
          <YStack flex={1} minHeight={0} overflowX="auto" overflowY="auto" testID="work-board-scroll">
            {desktopColumns}
          </YStack>
        ) : (
          <ScrollView flex={1} minHeight={0} keyboardShouldPersistTaps="handled" {...scrollProps}>
            <ScrollView horizontal keyboardShouldPersistTaps="handled" testID="work-board-scroll">
              {desktopColumns}
            </ScrollView>
          </ScrollView>
        )
      ) : (
        <ScrollView
          ref={(node: ScrollableHost | null) => {
            scrollRef.current = node;
          }}
          flex={1}
          minHeight={0}
          keyboardShouldPersistTaps="handled"
          scrollEnabled={!draggedItem}
          testID="work-phone-scroll"
          {...scrollProps}
          onContentSizeChange={(_width: number, height: number) => {
            scrollContentHeight.current = height;
          }}
          onScroll={(event: { nativeEvent?: { contentOffset?: { y?: number } } }) => {
            scrollProps.onScroll?.(event as never);
            // Ignore delayed native scroll echoes while auto-scroll owns the drag offset.
            if (draggingIdRef.current) return;
            const nextY = event?.nativeEvent?.contentOffset?.y;
            if (typeof nextY === 'number') scrollOffsetY.current = nextY;
          }}
        >
          <YStack
            ref={(node: MeasurableHost | null) => {
              boardRef.current = node;
            }}
            width="100%"
            maxWidth={720}
            alignSelf="center"
            paddingBottom="8"
            testID="work-sections"
            onTouchMove={
              draggedItem
                ? (event: { nativeEvent?: { pageY?: number } }) => {
                    const pageY = event?.nativeEvent?.pageY;
                    refreshHoverTarget(typeof pageY === 'number' ? pageY : null);
                    syncAutoScroll(pageY);
                  }
                : undefined
            }
            onTouchEnd={
              draggedItem
                ? (event: { nativeEvent?: { pageY?: number } }) => {
                    stopAutoScroll();
                    const pageY = event?.nativeEvent?.pageY;
                    const target =
                      typeof pageY === 'number'
                        ? resolveCurrentTouchTarget(pageY)
                        : dragOverRef.current;
                    if (target) dropOn(target);
                    else finishDrag();
                  }
                : undefined
            }
            onTouchCancel={draggedItem ? finishDrag : undefined}
          >
            {needs.length ? needsHead : null}
            {needsBody}
            {sections.map((section) => {
              const dropProps = webDropTargetProps(
                canMove && enableWebDrag,
                () => {
                  if (dragOver !== section.key) updateDragOver(section.key);
                },
                () => {
                  if (dragOver === section.key) updateDragOver(null);
                },
                (transferredId) => dropOn(section.key, transferredId),
              );
              const canDropHere = Boolean(draggedItem && shouldMoveWorkItem(draggedItem, section.key));
              const highlighted = dragOver === section.key || canDropHere;
              return (
                <YStack
                  key={section.key}
                  ref={(node: MeasurableHost | null) => {
                    sectionRefs.current[section.key] = node;
                  }}
                  borderWidth={highlighted ? 1 : 0}
                  borderColor="needsYou"
                  borderRadius="md"
                  testID={`work-drop-${section.key}`}
                  onLayout={(event: { nativeEvent?: { layout?: SectionBounds } }) => {
                    const layout = event?.nativeEvent?.layout;
                    if (layout) sectionLayouts.current[section.key] = layout;
                  }}
                  {...dropProps}
                >
                  <SectionHead
                    title={section.title}
                    count={section.list.length}
                    note={canDropHere ? 'Drop here' : 'note' in section ? section.note : undefined}
                    open={open[section.key]}
                    // An empty section has nothing to show, so it does not open unless accepting a dragged task.
                    onToggle={
                      canDropHere
                        ? () => dropOn(section.key)
                        : section.list.length
                          ? () =>
                              setOpen((current) => ({ ...current, [section.key]: !current[section.key] }))
                          : undefined
                    }
                    testID={section.testID}
                  />
                  {open[section.key] ? rows(section.list) : null}
                </YStack>
              );
            })}
          </YStack>
        </ScrollView>
      )}
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
        item={detail ? board.items.find(item => item.id === detail.id) ?? detail : null}
        workspaceId={board.workspaceId}
        viewerId={board.viewerId}
        desktop={desktop}
        now={now}
        people={board.people}
        onAssign={actions.assign}
        close={() => setDetail(null)}
      />
      {actions.create ? (
        <NewTaskSheet
          open={creating}
          close={() => setCreating(false)}
          chats={board.chats}
          people={board.people}
          defaultChatId={chat}
          onCreate={actions.create}
        />
      ) : null}
    </YStack>
  );
}
