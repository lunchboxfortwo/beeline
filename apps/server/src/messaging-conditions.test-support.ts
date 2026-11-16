import { beforeEach } from 'vitest';
import { queueMessage } from './agent-command.js';
import { SYSTEM_AUTHOR_ID, systemText } from './message-origin.js';
import { H, A, B, C, W, CHAT, THREAD, db } from './messaging.test-support.js';
export * from './messaging.test-support.js';

/** Commander places for the owner's four conditions: the parent chat, a DM,
 * the worked thread itself and a sibling thread. */
export const DM = '55555555-5555-4555-8555-555555555555';
export const SIBLING = '66666666-6666-4666-8666-666666666666';
export const PLACES = { chat: CHAT, dm: DM, thread: THREAD, sibling: SIBLING } as const;
export type Place = keyof typeof PLACES;
export const ROLES = { implementer: B, reviewer: C } as const;
export type Role = keyof typeof ROLES;

beforeEach(async () => {
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by,direct_participants)
    VALUES($1,$3,NULL,'Owner and Ruby',$4,jsonb_build_array($4::text,$5::text)),($2,$3,$6,'Sibling',$4,NULL)`,
  [DM, SIBLING, W, H, A, CHAT]);
  for (const member of [H, A]) await db.query(
    "INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')", [W, DM, member]);
  await db.query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1', [CHAT, C]);
});

/** Every pending item, with the tuple its recipient will reply from. */
export async function inbox() {
  return (await db.query<{ agent_id: string; room_id: string; reason: string; ask: unknown; from: unknown }>(
    `SELECT agent_id,room_id,reason,message->'route'->'from' "from",private_payload->'messageAsk' ask
     FROM agent_commands WHERE state='pending' ORDER BY created_at,id`)).rows;
}
export const settle = () => db.query("UPDATE agent_commands SET state='complete' WHERE state='pending'");

/** The System wakes the corner machine queues for thread workers. */
export const SYSTEM_WAKES = ['corner_check', 'corner_merge_conflict', 'corner_merge_refused', 'corner_review_needed', 'corner_review_dispatch'] as const;
export async function systemWake(reason: typeof SYSTEM_WAKES[number], agentId = B) {
  return (await queueMessage(db, { roomId: THREAD, agentId, sourceMessageId: null, reason,
    privatePayload: { kind: 'lifecycle', authorId: SYSTEM_AUTHOR_ID, fromRoomId: THREAD, text: systemText(`${reason} fact`) } }))!;
}

/** A person posts in a place; agent tags in it start turns there. */
export async function personSays(place: string, text: string) {
  return queueMessage(db, { kind: 'post', roomId: place, authorId: H, text });
}

/** What a person commander sees: thread-routed posts and answer cards. */
export async function personDeliveries() {
  return (await db.query<{ room_id: string; author_id: string; text: string; card: { route?: unknown } | null }>(
    `SELECT room_id,author_id,text,card FROM messages WHERE author_id=ANY($1::text[]) ORDER BY created_at,id`,
    [[B, C]])).rows.map(row => ({ room_id: row.room_id, author_id: row.author_id, text: row.text }));
}
