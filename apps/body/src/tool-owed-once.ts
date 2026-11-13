import { readFileSync } from 'node:fs';

const FULL_ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let listedGeneration: string | undefined;

/** The first tool in a turn lists owed mentions. Later tools in that turn do not. */
export function claimToolOwedListing(env: NodeJS.ProcessEnv = process.env): { include: boolean; roomId?: string } {
  const file = env.BEELINE_TURN_CONTEXT_FILE;
  let context: { itemId?: unknown; roomId?: unknown } = {};
  if (file) {
    try { context = JSON.parse(readFileSync(file, 'utf8')) as typeof context; } catch { context = {}; }
  }
  const room = typeof context.roomId === 'string' ? context.roomId : env.BEELINE_DAEMON_ROOM_ID;
  const roomId = typeof room === 'string' && FULL_ROOM_ID.test(room) ? room : undefined;
  const generation = typeof context.itemId === 'string' && context.itemId ? context.itemId : undefined;
  if (!generation || listedGeneration !== generation) {
    if (generation) listedGeneration = generation;
    return { include: true, roomId };
  }
  return { include: false, roomId };
}

export function filterOwedMentions(mentions: unknown[] | undefined, roomId: string | undefined): unknown[] | undefined {
  if (!Array.isArray(mentions) || mentions.length === 0) return undefined;
  if (!roomId) return mentions;
  const kept = mentions.filter(item => Boolean(item) && typeof item === 'object' && (item as { roomId?: unknown }).roomId === roomId);
  return kept.length ? kept : undefined;
}
