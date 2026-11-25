import { expect } from 'vitest';
import { threadCommanderAddressSql } from './corner-commander.js';
import type { SqlDatabase } from './database.js';

/** The three read-only routing checks can also run against retained production rows. */
export async function expectThreadRouting(db: SqlDatabase) {
  const commander = threadCommanderAddressSql('t.id');
  const checks = [
    `SELECT m.id FROM messages m
      JOIN agent_commands c ON c.agent_id=m.author_id AND c.turn_request_id=m.request_id
      JOIN rooms t ON t.id=c.room_id AND t.parent_id IS NOT NULL
      WHERE m.card->'route' IS NULL AND m.presentation='message' AND m.room_id<>c.room_id`,
    `SELECT m.id FROM messages m JOIN rooms t ON t.id::text=m.card->'route'->'from'->>'place' AND t.parent_id IS NOT NULL
      WHERE m.author_id=m.card->'route'->'from'->>'agent'
        AND m.card->'route'->'to' IS DISTINCT FROM ${commander}
        AND NOT EXISTS (SELECT 1 FROM agent_commands c WHERE c.agent_id=m.author_id AND c.room_id=t.id
          AND m.card->'route'->'to' IN (c.message->'route'->'from',c.message->'replyAddress'))`,
    `SELECT m.id FROM messages m JOIN rooms t ON t.id=m.block_corner_id
      WHERE m.card->>'reportStatus'='blocked' AND m.author_id=m.card->>'reportToId'
        AND m.room_id=t.id`,
  ];
  for (const query of checks) expect((await db.query(query)).rows).toEqual([]);
}
