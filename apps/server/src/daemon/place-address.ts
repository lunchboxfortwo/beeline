import { CommandRefusalError } from '../command-refusal.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const UNKNOWN_PLACE = 'unknown place; use an id from read(facet:addresses)';

/** Operations whose `address` field is a place id. Elsewhere `address` can mean something else, such as a wallet. */
export const ADDRESS_OPERATIONS = new Set(['order', 'read', 'stopAgentTurn']);

/** Input fields that name a chat, thread or DM by id. */
const PLACE_FIELD = /^(roomId|cornerId|[a-z][A-Za-z]*(RoomId|CornerId))$/;

function placeId(value: string): string {
  const id = value.startsWith('#') ? value.slice(1) : value;
  if (!UUID.test(id)) throw new CommandRefusalError(UNKNOWN_PLACE, 400);
  return id.toLowerCase();
}

/**
 * Checks every place address in one daemon operation input before any
 * database call. A `#`-prefixed id is read as the id. Anything else that is
 * not an id, such as a channel name, is refused with a plain message instead
 * of reaching Postgres as a uuid cast error. Names are not resolved.
 */
export function normalizePlaceAddresses<T>(name: string, input: T): T {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const value: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const [key, field] of Object.entries(value))
    if (PLACE_FIELD.test(key) && typeof field === 'string') value[key] = placeId(field);
  if (ADDRESS_OPERATIONS.has(name) && typeof value.address === 'string') value.address = placeId(value.address);
  if (name === 'message' && value.to && typeof value.to === 'object' && !Array.isArray(value.to)) {
    const to = value.to as Record<string, unknown>;
    if (typeof to.place === 'string') value.to = { ...to, place: placeId(to.place) };
  }
  return value as T;
}
