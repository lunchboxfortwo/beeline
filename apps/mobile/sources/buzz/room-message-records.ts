import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import equal from 'fast-deep-equal';
import type { ChatListView, RoomView, RoomViewAgentTurn, RoomViewMessage, SurfaceCacheAddress } from '@beeline/buzz-client';
import { ROOM_VIEW_AGENT_LIMIT, ROOM_VIEW_MESSAGE_LIMIT, ROOM_VIEW_TOOL_ROW_LIMIT } from '@beeline/api-contract/phone';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';
import { IdentitySelection, identityScope, useIdentityRecords } from './identity-records';
import { currentSurfaceStamp, nextSurfaceStamp } from './surface-clock';

type RoomRecords = {
  scope: string;
  roomId: string;
  messages: Map<string, RoomViewMessage>;
  incomplete: Set<string>;
  tailIds: string[];
  toolIds: string[];
  corner: boolean;
  latestId?: string;
  mentionsViewer?: true;
  gapBefore?: string;
  turns: Map<string, { row: RoomViewAgentTurn; stamp: number }>;
  bookmarkedAt: Map<string, number>;
  views: Map<string, Set<string>>;
  seenRows: WeakSet<RoomViewMessage>;
  listeners: Set<() => void>;
  revision: number;
};

const rooms = new Map<string, RoomRecords>();
const surfaceListeners = new Set<(scope: string, roomId: string) => void>();
/** List delivery metadata contains an id, never another message body. */
export const indexedPreviewId = Symbol('indexed-preview-id');
const keyOf = (scope: string, roomId: string) => `${scope}\u0000${roomId}`;
const readAt = new WeakMap<RoomViewMessage, number>();
const identityRows = new WeakMap<RoomViewMessage, { scope: string; version: number; row: RoomViewMessage }>();
let nextViewId = 0;

export function stampRoomMessageRows(rows: readonly RoomViewMessage[], stamp: number): void {
  for (const row of rows) readAt.set(row, Math.min(readAt.get(row) ?? stamp, stamp));
}

function notify(room: RoomRecords): void {
  room.revision++;
  for (const listener of [...room.listeners]) listener();
  for (const listener of surfaceListeners) listener(room.scope, room.roomId);
}

subscribeClientReset(() => {
  for (const [key, room] of rooms) {
    room.messages.clear();
    room.incomplete.clear();
    room.tailIds = [];
    room.toolIds = [];
    room.gapBefore = undefined;
    room.latestId = undefined;
    room.turns.clear();
    room.bookmarkedAt.clear();
    room.views.clear();
    room.seenRows = new WeakSet();
    notify(room);
    if (!room.listeners.size) rooms.delete(key);
  }
});

function records(key: string): RoomRecords {
  let room = rooms.get(key);
  if (!room) {
    const [scope, roomId] = key.split('\u0000');
    room = { scope: scope!, roomId: roomId!, messages: new Map(), incomplete: new Set(), tailIds: [], toolIds: [], corner: false, turns: new Map(), bookmarkedAt: new Map(),
      views: new Map(), seenRows: new WeakSet(), listeners: new Set(), revision: 0 };
    rooms.set(key, room);
  }
  return room;
}

function prune(room: RoomRecords): void {
  for (const id of room.messages.keys()) {
    if (room.tailIds.includes(id) || room.toolIds.includes(id) || room.latestId === id) continue;
    if ([...room.views.values()].some((ids) => ids.has(id))) continue;
    room.messages.delete(id);
    room.incomplete.delete(id);
    room.bookmarkedAt.delete(id);
  }
}

/** A Room read replaces only turns it could see; a newer live delta survives it. */
export function offerRoomTurns(scope: string | null, roomId: string, turns: readonly RoomViewAgentTurn[], stamp: number): void {
  if (!scope) return;
  const room = records(keyOf(scope, roomId));
  const seen = new Set(turns.map((turn) => turn.agentPubkey));
  let changed = false;
  for (const [id, held] of room.turns) {
    if (!seen.has(id) && held.stamp <= stamp) { room.turns.delete(id); changed = true; }
  }
  for (const turn of turns) {
    const held = room.turns.get(turn.agentPubkey);
    if (held && (held.stamp > stamp || (stamp === 0 && held.row.requestId === turn.requestId &&
      held.row.generationId === turn.generationId && held.row.status !== 'working' && turn.status === 'working'))) continue;
    if (held?.row !== turn) changed = true;
    room.turns.set(turn.agentPubkey, { row: turn, stamp });
  }
  if (changed) notify(room);
}

export function writeRoomTurn(scope: string | null, roomId: string, turn: RoomViewAgentTurn): void {
  if (!scope) return;
  const room = records(keyOf(scope, roomId));
  room.turns.set(turn.agentPubkey, { row: turn, stamp: nextSurfaceStamp() });
  notify(room);
}

export function roomTurns(scope: string | null, roomId: string): readonly RoomViewAgentTurn[] {
  const room = scope ? rooms.get(keyOf(scope, roomId)) : undefined;
  return [...(room?.turns.values() ?? [])].map(({ row }) => row)
    .sort((a, b) => b.createdAt - a.createdAt || a.agentPubkey.localeCompare(b.agentPubkey))
    .slice(0, ROOM_VIEW_AGENT_LIMIT);
}

function accept(room: RoomRecords, incoming: RoomViewMessage, shared: boolean, complete = true): boolean {
  const held = room.messages.get(incoming.id);
  const upgrading = complete && room.incomplete.delete(incoming.id);
  if (held === incoming || (held && (held.version ?? 0) > (incoming.version ?? 0))) return false;
  if (shared) readAt.set(incoming, nextSurfaceStamp());
  else if (!readAt.has(incoming)) readAt.set(incoming, currentSurfaceStamp());
  if (held && !shared && !upgrading && (held.version ?? 0) === (incoming.version ?? 0) &&
    (readAt.get(held) ?? 0) > readAt.get(incoming)!) return false;
  const written = room.bookmarkedAt.get(incoming.id);
  const keepBookmark = shared || (written !== undefined && readAt.get(incoming)! < written);
  const bookmarked = held && keepBookmark ? held.bookmarked : incoming.bookmarked;
  const feedbackReported = Boolean(held?.feedbackReported || incoming.feedbackReported);
  const next = bookmarked === incoming.bookmarked && feedbackReported === Boolean(incoming.feedbackReported)
    ? incoming : { ...incoming, bookmarked, feedbackReported };
  // Identity selection can recreate an unchanged row when turn subscribers refresh.
  // Keep its record stable so the layout effect does not notify those subscribers again.
  if (held && equal(held, next)) return false;
  if (next !== incoming) readAt.set(next, readAt.get(incoming)!);
  room.messages.set(incoming.id, next);
  return next !== held;
}

/** Update one loaded row; the server version and viewer state remain authoritative. */
export function writeRoomMessage(scope: string | null, roomId: string, message: RoomViewMessage, complete = true): void {
  if (!scope) return;
  const room = records(keyOf(scope, roomId));
  if (!complete && room.messages.has(message.id) && !room.incomplete.has(message.id)) return;
  if (accept(room, message, true, complete)) {
    if (!complete) {
      room.incomplete.add(message.id);
      room.gapBefore = message.id;
      room.tailIds = [message.id];
    }
    const tool = room.corner && message.presentation === 'activity' && !message.durableFact &&
      message.activity?.some(item => item.kind === 'tool' || item.kind === 'output');
    const ids = tool ? room.toolIds : room.tailIds;
    if (!ids.includes(message.id)) ids.push(message.id);
    const bounded = orderedRows(room, ids).slice(-(tool ? ROOM_VIEW_TOOL_ROW_LIMIT : ROOM_VIEW_MESSAGE_LIMIT)).map(row => row.id);
    if (tool) room.toolIds = bounded;
    else room.tailIds = bounded;
    selectLatest(room, message);
    prune(room);
    notify(room);
  }
}

function compareRows(a: RoomViewMessage, b: RoomViewMessage): number {
  return (a.createdAtMs ?? a.createdAt * 1000) - (b.createdAtMs ?? b.createdAt * 1000) || a.id.localeCompare(b.id);
}

function orderedRows(room: RoomRecords, ids: readonly string[]): RoomViewMessage[] {
  return ids.map(id => room.messages.get(id)).filter((row): row is RoomViewMessage => !!row).sort(compareRows);
}

function selectLatest(room: RoomRecords, message: RoomViewMessage): void {
  message = room.messages.get(message.id) ?? message;
  if (message.deleted && room.latestId === message.id) {
    room.latestId = orderedRows(room, room.tailIds).filter(row => !row.deleted && ['message', 'system', 'card'].includes(row.presentation)).at(-1)?.id;
  }
  if (message.deleted || !['message', 'system', 'card'].includes(message.presentation)) return;
  const held = room.latestId ? room.messages.get(room.latestId) : undefined;
  if (!held || message.createdAt > held.createdAt ||
    (message.createdAt === held.createdAt && message.id >= held.id)) {
    room.latestId = message.id;
    room.mentionsViewer = message.mentionPubkeys?.includes((JSON.parse(room.scope) as string[])[1]!)
      ? true : 'mentionsViewer' in message && message.mentionsViewer === true ? true : undefined;
  }
}

/** Windows hold membership; message bodies and turns live here, including
 * arrivals when no full Room response or transcript is resident. */
export function offerRoomView(scope: string | null, view: RoomView, stamp: number): void {
  if (!scope) return;
  const room = records(keyOf(scope, view.room.id));
  room.corner = Boolean(view.parent?.id ?? view.room.parentId);
  stampRoomMessageRows([...view.messages, ...(view.toolRows ?? [])]
    .filter(row => room.messages.get(row.id) !== row), stamp);
  let changed = false;
  for (const message of [...view.messages, ...(view.toolRows ?? [])]) {
    if (accept(room, message, false)) changed = true;
    selectLatest(room, message);
  }
  const newest = view.messages.at(-1)?.createdAt ?? 0;
  const later = orderedRows(room, room.tailIds).filter(row => row.createdAt >= newest || (readAt.get(row) ?? 0) > stamp);
  const ids = [...new Map([...view.messages, ...later].map(row => [row.id, row])).values()]
    .sort(compareRows).slice(-ROOM_VIEW_MESSAGE_LIMIT).map(row => row.id);
  changed ||= ids.length !== room.tailIds.length || ids.some((id, index) => id !== room.tailIds[index]);
  room.tailIds = ids;
  if (room.gapBefore && (stamp > 0 || view.messages.some(row => row.id === room.gapBefore))) room.gapBefore = undefined;
  room.toolIds = [...new Set([...(view.toolRows?.map(row => row.id) ?? []),
    ...room.toolIds.filter(id => (readAt.get(room.messages.get(id)!) ?? 0) > stamp)])];
  room.toolIds = orderedRows(room, room.toolIds).slice(-ROOM_VIEW_TOOL_ROW_LIMIT).map(row => row.id);
  prune(room);
  offerRoomTurns(scope, view.room.id, view.latestAgentTurns, stamp);
  if (changed) notify(room);
}

export function selectRoomViewRecords(scope: string | null, view: RoomView): RoomView {
  const room = scope ? rooms.get(keyOf(scope, view.room.id)) : undefined;
  if (!room) return view;
  const rows = orderedRows(room, [...new Set([...room.tailIds, ...(room.latestId ? [room.latestId] : [])])]);
  const gap = room.gapBefore ? room.messages.get(room.gapBefore) : undefined;
  const turns = roomTurns(scope, view.room.id);
  let messages = rows.filter(row => !gap || compareRows(row, gap) >= 0).filter(row => row.presentation !== 'activity' || row.durableFact ||
    !turns.some(turn => turn.agentPubkey === row.author.pubkey && (turn.status !== 'working' || row.createdAt < turn.createdAt)))
    .sort(compareRows);
  if (messages.length > ROOM_VIEW_MESSAGE_LIMIT) {
    const latest = messages.find(row => row.id === room.latestId);
    messages = latest ? [...messages.filter(row => row !== latest).slice(-(ROOM_VIEW_MESSAGE_LIMIT - 1)), latest].sort(compareRows)
      : messages.slice(-ROOM_VIEW_MESSAGE_LIMIT);
  }
  return { ...view, messages, latestAgentTurns: turns,
    ...(room.corner ? { toolRows: orderedRows(room, room.toolIds) } : {}),
    ...(view.pendingAgentCommands ? { pendingAgentCommands: view.pendingAgentCommands.filter(command =>
      !turns.some(turn => turn.status !== 'working' && turn.requestId === command.requestId && turn.agentPubkey === command.agentPubkey)) } : {}) };
}

/** The registry keeps response metadata and membership only. Both deck and
 * transcript select the same id-keyed records, also when a covering read is held. */
export const roomSurfaceRecords = {
  snapshot(address: SurfaceCacheAddress, value: unknown): unknown {
    const scope = identityScope(address.relayOrigin, address.viewerPubkey);
    // Select records here, never through stored object-literal getters: Metro
    // lowers spreads to Object.assign, which evaluates those getters once.
    if (address.endpoint === '/workspace/:id/chats') {
      const view = value as ChatListView;
      return { ...view, chats: view.chats.map(item => {
        const room = records(keyOf(scope, item.room.id));
        const message = room.latestId ? room.messages.get(room.latestId) : undefined;
        return { ...item,
          latestMessage: message ? { ...message, ...(room.mentionsViewer ? { mentionsViewer: true as const } : {}) } : undefined,
          latestAgentTurns: roomTurns(scope, item.room.id),
        };
      }) };
    }
    return /^\/room\/[^/]+$/.test(address.endpoint) && value && typeof value === 'object' && 'room' in value && 'viewer' in value
      ? selectRoomViewRecords(scope, value as RoomView) : value;
  },
  subscribe(listener: (scope: string, roomId: string) => void) {
    surfaceListeners.add(listener);
    return () => { surfaceListeners.delete(listener); };
  },
  matches(address: SurfaceCacheAddress, scope: string, roomId: string) {
    return identityScope(address.relayOrigin, address.viewerPubkey) === scope &&
      (address.endpoint === `/room/${roomId}` || address.endpoint === '/workspace/:id/chats');
  },
  store(address: SurfaceCacheAddress, value: unknown, stamp: number): unknown {
    const scope = identityScope(address.relayOrigin, address.viewerPubkey);
    if (/^\/room\/[^/]+$/.test(address.endpoint)) {
      if (!value || typeof value !== 'object' || !('room' in value) || !('viewer' in value)) return value;
      const view = value as RoomView;
      offerRoomView(scope, view, stamp);
      const { messages, toolRows, latestAgentTurns: _turns, ...metadata } = view;
      // Keep response metadata only; snapshot selects the shared rows/turns.
      return { ...metadata, messages: [], latestAgentTurns: [] };
    }
    if (address.endpoint !== '/workspace/:id/chats') return value;
    const view = value as ChatListView;
    return { ...view, chats: view.chats.map(item => {
      const room = records(keyOf(scope, item.room.id));
      const latest = item.latestMessage;
      let changed = false;
      if (latest) {
        const held = room.messages.get(latest.id);
        const complete = latest.presentation !== undefined && (!room.incomplete.has(latest.id) ||
          latest.version !== undefined || latest.reference !== undefined || latest.requestId !== undefined);
        // Legacy list reads supply text only. Use the existing plain-text
        // presentation until the ordinary Room read supplies its card/details.
        const message = latest.presentation ? latest as RoomViewMessage : { ...latest, presentation: 'message' as const };
        if (complete || !held || room.incomplete.has(latest.id)) {
          if (held !== message) stampRoomMessageRows([message], stamp);
          const newest = room.latestId ? room.messages.get(room.latestId) : undefined;
          const indexedLatest = !newest || ((readAt.get(newest) ?? 0) <= stamp &&
            (stamp > 0 || compareRows(message, newest) >= 0));
          if (!held && indexedLatest) {
            room.gapBefore = latest.id;
            room.tailIds = [latest.id];
          }
          changed = accept(room, message, false, complete);
          if (!complete) room.incomplete.add(message.id);
          selectLatest(room, message);
          if (indexedLatest) room.latestId = latest.id;
        }
        if (room.latestId === latest.id) room.mentionsViewer = latest.mentionsViewer;
      }
      if (item.latestAgentTurns) offerRoomTurns(scope, item.room.id, item.latestAgentTurns, stamp);
      if (changed) { prune(room); notify(room); }
      const { latestMessage: _latest, latestAgentTurns: _turns, ...metadata } = item;
      return { ...metadata, [indexedPreviewId]: latest?.id };
    }) };
  },
};

export function writeRoomBookmark(scope: string | null, roomId: string, id: string, bookmarked: boolean): void {
  const room = scope ? rooms.get(keyOf(scope, roomId)) : undefined;
  const held = room?.messages.get(id);
  if (!room || !held) return;
  room.bookmarkedAt.set(id, nextSurfaceStamp());
  room.messages.set(id, { ...held, bookmarked });
  notify(room);
}

export function roomMessageRecord(scope: string | null, roomId: string, id: string): RoomViewMessage | undefined {
  return scope ? rooms.get(keyOf(scope, roomId))?.messages.get(id) : undefined;
}

function offer(key: string, viewKey: string, groups: readonly (readonly RoomViewMessage[])[]): boolean {
  const room = records(key);
  const previous = room.views.get(viewKey);
  const next = new Set<string>();
  let changed = false;
  for (const rows of groups) for (const row of rows) {
    next.add(row.id);
    if (room.seenRows.has(row) && room.messages.has(row.id)) continue;
    room.seenRows.add(row);
    if (accept(room, row, false)) changed = true;
  }
  room.views.set(viewKey, next);
  if (previous && [...previous].some((id) => !next.has(id))) prune(room);
  return changed;
}

function useRevision(key: string | undefined): number {
  const subscribe = useCallback((listener: () => void) => {
    if (!key) return () => undefined;
    const room = records(key);
    room.listeners.add(listener);
    return () => { room.listeners.delete(listener); prune(room); };
  }, [key]);
  return useSyncExternalStore(subscribe, () => key ? rooms.get(key)?.revision ?? 0 : 0);
}

export function useRoomTurnRecords(scope: string | null, roomId: string | undefined) {
  const key = scope && roomId ? keyOf(scope, roomId) : undefined;
  const revision = useRevision(key);
  return useMemo(() => roomTurns(scope, roomId ?? ''), [key, revision]);
}

function select(room: RoomRecords | undefined, rows: readonly RoomViewMessage[], scope: string | null, version: number) {
  if (!room) return rows;
  let changed = false;
  const selected = rows.map((row) => {
    const record = room.messages.get(row.id) ?? row;
    let result = record;
    if (scope) {
      const cached = identityRows.get(record);
      result = cached?.scope === scope && cached.version === version ? cached.row
        : new IdentitySelection(scope, readAt.get(record) ?? 0).message(record);
      if (cached?.scope !== scope || cached.version !== version)
        identityRows.set(record, { scope, version, row: result });
    }
    if (result !== row) changed = true;
    return result;
  });
  return changed ? selected : rows;
}

/** Windows keep their order; all mounted views select content from one id-keyed record. */
export function useRoomMessageRecords<const Groups extends readonly (readonly RoomViewMessage[])[]>(
  scope: string | null, roomId: string | undefined, groups: Groups,
): Groups {
  const [viewKey] = useState(() => `view:${++nextViewId}`);
  const held = useRef({ generation: clientResetGeneration(), scope, roomId,
    groups: [...groups] as readonly (readonly RoomViewMessage[])[], blocked: false });
  const generation = clientResetGeneration();
  if (generation !== held.current.generation)
    held.current = { generation, scope, roomId, groups: [...groups], blocked: true };
  else if (held.current.blocked && (scope !== held.current.scope || roomId !== held.current.roomId ||
    groups.length !== held.current.groups.length ||
    groups.some((rows, index) => rows !== held.current.groups[index])))
    held.current.blocked = false;
  const visible = held.current.blocked ? groups.map(() => []) : groups;
  const identityVersion = useIdentityRecords();
  const key = scope && roomId ? keyOf(scope, roomId) : undefined;
  const changed = key ? offer(key, viewKey, visible) : false;
  const room = key ? rooms.get(key) : undefined;
  useRevision(key);
  useLayoutEffect(() => { if (changed && room) notify(room); });
  useLayoutEffect(() => {
    if (!key) return;
    return () => { const held = rooms.get(key); held?.views.delete(viewKey); if (held) prune(held); };
  }, [key, viewKey]);
  const selected = visible.map((rows) => select(room, rows, scope, identityVersion));
  const previous = useRef<readonly (readonly RoomViewMessage[])[]>([]);
  // A canonical edit can replace an input row without replacing that window.
  // Keep the selected window while its row references are unchanged, so typing
  // does not refold cards and recreate their neighbouring row context.
  const stable = selected.map((rows, index) => {
    const held = previous.current[index];
    return held && held.length === rows.length && rows.every((row, index) => row === held[index])
      ? held : rows;
  });
  if (stable.length !== previous.current.length || stable.some((rows, index) => rows !== previous.current[index]))
    previous.current = stable;
  return previous.current as unknown as Groups;
}
