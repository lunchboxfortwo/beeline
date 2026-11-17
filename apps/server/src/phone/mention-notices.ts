import { readMemberDeliveries } from '../rooms-mcp-delivery.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import type { RoomView } from '@beeline/api-contract/phone';
import { accessNoticeBucket } from '@beeline/api-contract/agent-access';
import { resolveCurrentMemberMentions } from '../message-mentions.js';
import { type SqlDatabase } from '../database.js';
import { systemLine } from '../system-line.js';
import type { PhoneContext } from './context.js';
import { phoneReadLiveDelta } from './live-reads.js';
import { mentionNoticeId } from './values.js';
import { phoneProjectPendingAgentCommands } from './message-enrichment.js';



  /**
   * Active turns targeted by the human write. The command and message commit
   * in one transaction, so the phone can distinguish a server-accepted steer
   * from text that merely looked addressed locally.
   */
  export async function phoneReceiptMessage(ctx: PhoneContext, roomId: string, viewerId: string, messageIdValue: string, database: SqlDatabase, mayRoute = true) {
    const delta = await phoneReadLiveDelta(ctx, roomId, viewerId, {
      type: 'message', messageId: messageIdValue,
    }, database);
    mayRoute = mayRoute && delta?.type === 'message-delta' && delta.message.author.kind === 'human';
    // Read both routing facts in the existing steer-receipt round trip.
    // Routing records MCP mentions only after membership and addressing policy
    // pass; presence never determines whether a recipient is external.
    const routing = (await database.query<{
      active_steer_agent_ids: string[];
      external_agent_handles: string[];
    }>(
      `SELECT ARRAY(
         SELECT DISTINCT command.agent_id
         FROM agent_commands command
         JOIN agent_turns turn ON turn.room_id=command.room_id
           AND turn.agent_id=command.agent_id AND turn.status='working'
           AND turn.request_id<>command.turn_request_id
         WHERE $3::boolean AND command.source_message_id=$2 AND command.action='input'
         ORDER BY command.agent_id
       ) active_steer_agent_ids,
       ARRAY(
         SELECT DISTINCT beeline_room_handle(identity.id,$1) handle
         FROM memberships membership
         JOIN rooms_mcp_members external ON external.member_id=membership.identity_id
         JOIN identities identity ON identity.id=external.member_id
         WHERE $3::boolean AND membership.room_id=(SELECT COALESCE(parent_id,id) FROM rooms WHERE id=$1)
           AND membership.removed_at IS NULL
           AND NULLIF(identity.handle,'') IS NOT NULL
           AND EXISTS(SELECT 1 FROM rooms_mcp_mentions mention
             WHERE mention.member_id=external.member_id AND mention.message_id=$2
               AND mention.room_id=$1)
         ORDER BY handle
       ) external_agent_handles`,
      [roomId, messageIdValue, mayRoute],
    )).rows[0];
    const externalMembers=routing?.external_agent_handles?.length
      ? (await database.query<{member_id:string;handle:string}>(`SELECT m.member_id,beeline_room_handle(i.id,$2) handle FROM rooms_mcp_members m
          JOIN identities i ON i.id=m.member_id
          JOIN room_access member ON member.identity_id=i.id AND member.room_id=$2 AND member.removed_at IS NULL
          WHERE beeline_room_handle(i.id,$2)=ANY($1::text[]) ORDER BY handle`,[routing.external_agent_handles,roomId])).rows : [];
    const delivery=await readMemberDeliveries(database,externalMembers.map(member=>member.member_id));
    const externalAgentDelivery=externalMembers.map(member=>({memberId:member.member_id,handle:member.handle,...delivery.get(member.member_id)!}));
    return {
      externalAgentDelivery,
      ...(delta?.type === 'message-delta' ? { message: delta.message } : {}),
      activeSteerAgentIds: routing?.active_steer_agent_ids ?? [],
      externalAgentHandles: routing?.external_agent_handles ?? [],
    };
  }


  export async function phonePendingAgentCommandsForMessage(ctx: PhoneContext,
    database: SqlDatabase,
    roomId: string,
    messageIdValue: string,
  ): Promise<NonNullable<RoomView['pendingAgentCommands']>> {
    const commands = await database.query<{
      agent_id: string;
      turn_request_id: string;
      created_at: Date;
    }>(
      `SELECT command.agent_id,command.turn_request_id,command.created_at
       FROM agent_commands command
       WHERE command.room_id=$1 AND command.source_message_id=$2
         AND command.state='pending' AND command.action='input'
         AND command.reason IN ('human_tag','direct_message')
       ORDER BY command.created_at,command.agent_id`,
      [roomId, messageIdValue],
    );
    return phoneProjectPendingAgentCommands(ctx, commands.rows);
  }

  /** The sole unsolicited agent notice: an addressed agent has no live
   * delivery route (an external member without one, or a helper agent whose
   * machine is not connected). Its queue item waits; this line says so. */
  export async function phoneNoteUnansweredMentions(ctx: PhoneContext,
    roomId: string,
    senderId: string,
    agentIds: readonly string[],
    afterMessageId?: string,
  ): Promise<void> {
    if (!agentIds.length) return;
    try {
      const human = await ctx.database.query(
        "SELECT 1 FROM identities WHERE id=$1 AND kind='human'", [senderId],
      );
      if (!human.rowCount) return;
      const agents = (await ctx.database.query<{ agent_id: string; agent_name: string; external: boolean }>(
        `SELECT identity.id agent_id,identity.name agent_name,external.member_id IS NOT NULL external
         FROM identities identity
         LEFT JOIN rooms_mcp_members external ON external.member_id=identity.id
         JOIN room_access member ON member.identity_id=identity.id
           AND member.room_id=$2 AND member.removed_at IS NULL
         WHERE identity.id=ANY($1::text[]) AND identity.kind='agent'
           AND NOT EXISTS(SELECT 1 FROM free_agents free WHERE free.agent_id=identity.id)`,
        [[...agentIds], roomId],
      )).rows;
      const deliveries = await readMemberDeliveries(ctx.database, agents.filter(agent => agent.external).map(agent => agent.agent_id));
      const bucket = accessNoticeBucket(Date.now());
      for (const agent of agents) {
        const delivery = deliveries.get(agent.agent_id);
        // Offline is a recorded failure or a dead credential. A host that declared on-demand delivery, or has
        // not yet proved its route, is not offline: it polls or has not been asked yet.
        if (!delivery?.offline) continue;
        await systemLine(ctx.database, {
          roomId,
          id: mentionNoticeId(roomId, agent.agent_id, senderId, 'no-live-route', bucket),
          subject: { kind: 'agent', id: agent.agent_id, name: agent.agent_name },
          verb: systemMessage('phone-service.is-offline'),
          consequence: systemMessage('phone-service.connect-again'),
          afterMessageId,
        });
      }
    } catch (error) {
      console.error('[server] could not record agent offline notice:', error);
    }
  }

  /** Resolve current addressed agents for the offline notice. */
  export async function phoneUnansweredMentionTargets(ctx: PhoneContext,
    roomId: string,
    author: string,
    text: string,
    source?: { authorKind: 'human' | 'agent'; direct: boolean; corner: boolean },
  ): Promise<readonly string[]> {
    // A send already read these facts in its membership-fenced insert. Replies
    // retain the lookup because they do not carry that same source context.
    const authorKind = source?.authorKind ?? (
      await ctx.database.query<{ kind: 'human' | 'agent' }>(
        `SELECT kind FROM identities WHERE id=$1`,
        [author],
      )
    ).rows[0]?.kind;
    if (authorKind !== 'human') return [];
    const resolvedMembers = await resolveCurrentMemberMentions(ctx.database, roomId, text, author);
    const noticeAgentIds = new Set(
      resolvedMembers.filter((member) => member.kind === 'agent').map((member) => member.id),
    );
    const directAgents = source?.direct === false ? { rows: [] } : await ctx.database.query<{ id: string }>(
      `SELECT identity.id
       FROM rooms room
       JOIN LATERAL jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(room.direct_participants)='array'
           THEN room.direct_participants ELSE '[]'::jsonb END
       ) participant(id) ON true
       JOIN identities identity ON identity.id=participant.id AND identity.kind='agent'
       JOIN memberships membership ON membership.room_id=room.id
         AND membership.identity_id=identity.id AND membership.removed_at IS NULL
       WHERE room.id=$1 AND jsonb_array_length(
         CASE WHEN jsonb_typeof(room.direct_participants)='array'
           THEN room.direct_participants ELSE '[]'::jsonb END
       )=2`,
      [roomId],
    );
    // A private two-member DM with one agent is already an addressed surface:
    // every human message in it is for that sole helper, including the first
    // untagged message and a reply to the human's own row. The address is the
    // Room, not a tag, and `routeHumanMessage` reads it from the participant
    // list — so this only decides whether an unreachable helper is worth a word.
    if (directAgents.rows.length === 1) {
      noticeAgentIds.add(directAgents.rows[0]!.id);
    }
    return [...noticeAgentIds];
  }
