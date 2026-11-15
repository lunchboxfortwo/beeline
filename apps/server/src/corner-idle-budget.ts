import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

/** At most two notices per person-authored epoch; reactions never replenish it. */
export const CORNER_IDLE_REPORT_BUDGET = 2;

/** Both serving instances derive the budget from committed sources under the corner lock. */
export function cornerIdleBudgetSql(corner: string): string {
  return `CROSS JOIN LATERAL (WITH person_messages AS MATERIALIZED (
    SELECT message.created_at,message.author_id,message.presentation,message.system_event,message.deleted_at
      FROM identities local_person CROSS JOIN LATERAL (
        SELECT message.created_at,message.author_id,message.presentation,message.system_event,message.deleted_at
          FROM messages message WHERE message.room_id=${corner}.id AND message.author_id=local_person.id
            AND message.presentation='message' AND message.system_event IS NULL AND message.deleted_at IS NULL
          ORDER BY message.created_at DESC LIMIT 1
      ) message WHERE local_person.kind='human' AND local_person.id<>'${SYSTEM_IDENTITY_ID}'
    UNION ALL
    SELECT message.created_at,message.author_id,message.presentation,message.system_event,message.deleted_at FROM messages message WHERE message.card->>'sourceRoomId'=${corner}.id::text
    UNION ALL
    SELECT message.created_at,message.author_id,message.presentation,message.system_event,message.deleted_at
      FROM (SELECT id FROM messages WHERE room_id=${corner}.id
        UNION SELECT id FROM messages WHERE card->>'sourceRoomId'=${corner}.id::text) target
      CROSS JOIN LATERAL (SELECT message.created_at,message.author_id,message.presentation,message.system_event,message.deleted_at
        FROM messages message WHERE message.reply_to_message_id=target.id OFFSET 0) message
    UNION ALL
    SELECT message.created_at,message.author_id,message.presentation,message.system_event,message.deleted_at FROM agent_commands addressed JOIN messages message ON message.id=addressed.source_message_id
      WHERE addressed.room_id=${corner}.id
  ) SELECT GREATEST(${corner}.created_at,max(person_event.at)) at FROM (
    SELECT message.created_at at FROM person_messages message JOIN identities person ON person.id=message.author_id
    WHERE person.kind='human' AND person.id<>'${SYSTEM_IDENTITY_ID}'
      AND message.presentation='message' AND message.system_event IS NULL AND message.deleted_at IS NULL
    UNION ALL
    SELECT addressed.created_at FROM agent_commands addressed
      JOIN identities person ON person.id=addressed.private_payload->>'authorId'
      WHERE addressed.room_id=${corner}.id AND addressed.private_payload->>'kind'='order'
        AND person.kind='human' AND person.id<>'${SYSTEM_IDENTITY_ID}'
    UNION ALL
    SELECT grant_decision.decided_at FROM agent_grants grant_decision JOIN identities person ON person.id=grant_decision.decided_by
      WHERE grant_decision.room_id=${corner}.id AND person.kind='human' AND person.id<>'${SYSTEM_IDENTITY_ID}'
    UNION ALL
    SELECT vote.updated_at FROM room_choices choice JOIN room_choice_votes vote ON vote.choice_id=choice.id
      JOIN identities person ON person.id=vote.voter_id AND person.kind='human' AND person.id<>'${SYSTEM_IDENTITY_ID}'
      WHERE choice.room_id=${corner}.id
    UNION ALL
    SELECT offer.accepted_at FROM connector_offers offer JOIN identities person ON person.id=offer.accepted_by
      WHERE offer.room_id=${corner}.id AND person.kind='human' AND person.id<>'${SYSTEM_IDENTITY_ID}'
    UNION ALL
    SELECT hold.released_at FROM corner_merge_holds hold JOIN identities person ON person.id=hold.released_by
      WHERE hold.corner_id=${corner}.id AND person.kind='human' AND person.id<>'${SYSTEM_IDENTITY_ID}'
    UNION ALL
    SELECT GREATEST(card.created_at,to_timestamp(COALESCE(card.card->>'decidedAt',card.card->>'savedAt')::double precision))
      FROM messages card JOIN identities person ON person.id=COALESCE(card.card->'decidedBy'->>'pubkey',
        card.card->'decider'->>'pubkey',
        card.card->>'decidedBy',CASE WHEN card.card->>'status'='saved' THEN card.card->>'ownerId' END)
      WHERE card.room_id=${corner}.id AND card.presentation='card' AND person.kind='human'
        AND person.id<>'${SYSTEM_IDENTITY_ID}'
        AND COALESCE(card.card->>'decidedAt',card.card->>'savedAt') ~ '^[0-9]+([.][0-9]+)?$'
  ) person_event) person_epoch
  LEFT JOIN LATERAL (SELECT count(*)::int report_count,COALESCE(bool_or(report.state='pending'),false) pending
    FROM agent_commands report WHERE report.private_payload->>'authorId'='${SYSTEM_IDENTITY_ID}'
      AND report.private_payload->>'kind'='report'
      AND report.private_payload->>'fromRoomId'=${corner}.id::text
      AND report.private_payload->>'text' ~ '^blocked: Corner .+ is idle[.] Resume it, set a hold, or close it[.]$'
      AND report.created_at>=person_epoch.at) idle_budget ON true`;
}
