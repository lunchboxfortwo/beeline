import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';

declare const composedBy: unique symbol;
declare const systemAuthor: unique symbol;

/**
 * Who composed text that is written as a message or queued for an agent.
 *
 * A message under an agent's name is only ever what that agent's model wrote,
 * except Beeline's one-time onboarding lines. The types below carry that
 * rule at compile time: every agent-authored write accepts only `AgentVoice`,
 * so text the server composes cannot be written or queued under an agent's
 * name without naming its origin here. There is no runtime check.
 *
 * - `model`: the agent's own model output, as its helper or provider returned it.
 * - `product-onboarding`: a one-time onboarding line Beeline writes for a new
 *   agent (the hello, the starter welcome, Luna's intro, the game caption, the
 *   join greeting, the invite link).
 * - `system`: text the server composed. Its author is System, never an agent;
 *   System lines and cards go through `systemLine`.
 * - `person`: what a person typed or said.
 */
export type MessageOrigin = 'model' | 'product-onboarding' | 'system' | 'person';

/** Text with a declared origin. */
export type Composed<Origin extends MessageOrigin> = string & { readonly [composedBy]: Origin };

/** The System identity as an author: the only author `system` text may carry. */
export type SystemAuthorId = string & { readonly [systemAuthor]: true };
export const SYSTEM_AUTHOR_ID = SYSTEM_IDENTITY_ID as SystemAuthorId;

/** The only text an agent author may carry. */
export type AgentVoice = Composed<'model' | 'product-onboarding'>;

/** Text a member (a person or an agent) may post under their own name. */
export type MemberText = AgentVoice | Composed<'person'>;

/** The agent's model wrote this (a tool argument or final answer from its helper or provider). */
export function modelText(text: string): Composed<'model'> {
  return text as Composed<'model'>;
}

/** One of Beeline's one-time onboarding lines, written under the onboarding agent's name. */
export function productOnboardingText(text: string): Composed<'product-onboarding'> {
  return text as Composed<'product-onboarding'>;
}

/** Server-composed text; its writer uses the System identity as author. */
export function systemText(text: string): Composed<'system'> {
  return text as Composed<'system'>;
}

/** What a person typed or said. */
export function personText(text: string): Composed<'person'> {
  return text as Composed<'person'>;
}

/**
 * Insert one ordinary message under a member's name, outside the queue's
 * publication path. An agent's row type-checks only with onboarding or model text.
 */
export async function insertMemberMessage(db: Pick<SqlDatabase, 'query'>, row: {
  readonly id: string;
  readonly roomId: string;
  readonly authorId: string;
  readonly text: MemberText;
  readonly card?: unknown;
  readonly attachments?: unknown;
  readonly ignoreExisting?: boolean;
}): Promise<boolean> {
  const inserted = await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,card,attachments,created_at)
     VALUES($1,$2,$3,$4,$5::jsonb,COALESCE($6::jsonb,'[]'::jsonb),clock_timestamp())
     ${row.ignoreExisting ? 'ON CONFLICT(id) DO NOTHING' : ''}`,
    [row.id, row.roomId, row.authorId, row.text,
      row.card === undefined ? null : JSON.stringify(row.card),
      row.attachments === undefined ? null : JSON.stringify(row.attachments)],
  );
  return Boolean(inserted.rowCount);
}
