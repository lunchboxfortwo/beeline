import { repositoryMarkColumnsSql } from '../repository-mark.js';
import { memberPresenceSql } from '../member-presence.js';
import { messageColumns } from '../message-columns.js';
import { assetUrl, phoneIdentity as identity, type PhoneIdentityRow as IdentityRow } from '../phone-identity.js';
import type { ChatListView, ChatListItem, RoomViewMessage } from '@beeline/api-contract/phone';
import { chatActivityAt } from '@beeline/api-contract/phone';
import { AGENT_REACHABLE_HORIZON_MS, isAgentReachable } from '@beeline/api-contract/agent-access';
import { tagsKnownIdentitySql } from '../message-mentions.js';
import { chatCornerCounts, openCornerFactsSql, roomAttentionActorSql, roomNeedsYouSql, roomWorkingSql, type OpenCornerFactsRow } from '../chat-corner-counts.js';
import { unreadMessageSql, visibleChatMessageSql } from '../read-cursor.js';
import type { PhoneContext } from './context.js';
import { RoomRow, MessageRow } from './types.js';
import { reviveDates, roomHeader } from './read-projection.js';
import { phoneOptionalEnrichment } from './optional-enrichment.js';
import { unix } from './values.js';
import { workingTurnFreshSql } from '../agent-turn-end.js';
import { phoneProjectAgentTurns } from './message-enrichment.js';
import type { AgentTurnRow } from './types.js';
import { projectedMessage, reactionIdentitiesSql } from './read-projection.js';
import { roomMessageTagsSql } from '../room-router-read.js';
import { turnRootMessageSql } from '../agent-command.js';



  export async function phoneReadChats(ctx: PhoneContext, workspaceId: string, viewerId: string): Promise<ChatListView | null> {
    // Reuse Workspace roles across the deck. The access view also derives
    // corner roles, which need not be expanded again for each Room's managers.
    const result = await ctx.database.query<{
      viewer_row: IdentityRow;
      workspace: {
        id: string;
        name: string;
        avatar: string | null;
        visibility: 'public' | 'invite-only';
        role: 'owner' | 'admin' | 'member' | 'spectator';
        updated_at: Date;
      };
      joinable_rows: { id: string; name: string; memberCount: number }[];
      room_rows: (RoomRow & {
        voice_call: ChatListItem['voiceCall'] | null;
        member_count: string;
        leave_deletes_room: boolean;
        latest_row: MessageRow | null;
        turns: AgentTurnRow[];
        latest_tags_viewer: boolean;
        attention_actor_name: string | null;
        peer_id: string | null;
        peer_kind: 'human' | 'agent' | null;
        peer_name: string | null;
        peer_handle: string | null;
        peer_avatar: string | null;
        peer_face: string | null;
        peer_presence_body: Record<string, unknown> | null;
        peer_presence_updated_at: Date | null;
        peer_activity_at: Date | null;
        /** Undefined until the cursor enrichment reads it. */
        unread?: boolean;
        working: boolean;
        needs_you: boolean;
        closed: boolean;
        agents_offline: boolean;
      })[];
    }>(
      `WITH workspace_members AS MATERIALIZED (
         SELECT workspace_id,identity_id,role FROM memberships workspace_member
         WHERE workspace_member.workspace_id=$1 AND workspace_member.room_id IS NULL
           AND workspace_member.removed_at IS NULL
       ), visible_workspace AS (
         SELECT w.id,w.name,w.avatar,w.visibility,w.updated_at,wm.role
         FROM workspaces w JOIN workspace_members wm ON wm.workspace_id=w.id
         WHERE w.id=$1 AND wm.identity_id=$2
       ), visible_rooms AS (
      SELECT r.*,${repositoryMarkColumnsSql('r')},
        (SELECT message.card FROM voice_calls call JOIN messages message ON message.id=call.message_id
          WHERE call.room_id=r.id AND call.ended_at IS NULL) voice_call,
        (SELECT count(*)::text FROM memberships rm WHERE rm.room_id=COALESCE(r.parent_id,r.id) AND rm.removed_at IS NULL) member_count,
        NOT EXISTS (
          SELECT 1 FROM memberships other_room
          JOIN workspace_members other_workspace ON other_workspace.workspace_id=r.workspace_id
            AND other_workspace.identity_id=other_room.identity_id
            AND other_workspace.role IN ('owner','admin')
          WHERE other_room.room_id=COALESCE(r.parent_id,r.id) AND other_room.removed_at IS NULL
            AND other_room.identity_id<>$2
        ) leave_deletes_room,
        CASE WHEN lm.id IS NOT NULL THEN to_jsonb(lm) || jsonb_build_object(
          'author_kind',li.kind,'author_name',li.name,
          'author_handle',CASE WHEN li.kind='agent' THEN COALESCE(author_address.handle,li.handle) ELSE li.handle END,
          'author_avatar',li.avatar,'author_face',li.face_id,
          'tagged_ids',${roomMessageTagsSql('lm')},
          'reaction_identities',CASE WHEN lm.reactions='{}'::jsonb THEN '[]'::jsonb ELSE ${reactionIdentitiesSql('lm')} END,
          'bookmarked',EXISTS(SELECT 1 FROM message_bookmarks bookmark WHERE bookmark.message_id=lm.id AND bookmark.identity_id=$2),
          'feedback_reported',EXISTS(SELECT 1 FROM feedback_items report WHERE report.trigger_message_id=lm.id AND report.source_kind='human')
        ) END latest_row,
        COALESCE((SELECT jsonb_agg(to_jsonb(turn) || jsonb_build_object('requested_by',requester.id)) FROM (
          SELECT DISTINCT ON(agent_id) * FROM agent_turns
          WHERE room_id=r.id AND (status<>'working' OR ${workingTurnFreshSql('agent_turns')})
          ORDER BY agent_id,(status='working') DESC,created_at DESC,request_id DESC
        ) turn
        LEFT JOIN messages trigger ON trigger.id=${turnRootMessageSql('turn')}
        LEFT JOIN identities requester ON requester.id=trigger.author_id AND requester.kind='human'),'[]'::jsonb) turns,
        COALESCE(lm.author_id<>$2 AND ${tagsKnownIdentitySql('lm', '$2',
          '(SELECT handle FROM identities WHERE id=$2)', '(SELECT kind FROM identities WHERE id=$2)')},false) latest_tags_viewer,
        ${roomAttentionActorSql('r')} attention_actor_name,
        peer.id peer_id,peer.kind peer_kind,peer.name peer_name,
        CASE WHEN peer.kind='agent' THEN COALESCE(peer_address.handle,peer.handle) ELSE peer.handle END peer_handle,
        peer.avatar peer_avatar,peer.face_id peer_face,
        NULL::jsonb peer_presence_body,NULL::timestamptz peer_presence_updated_at,
        NULL::timestamptz peer_activity_at,
        false agents_offline,
        ${roomWorkingSql('r')} working,
        ${roomNeedsYouSql('r')} needs_you,
        (r.direct_participants IS NOT NULL AND EXISTS(
          SELECT 1 FROM chat_dismissals dismissal
          WHERE dismissal.room_id=r.id AND dismissal.identity_id=$2
            AND NOT EXISTS(
              SELECT 1 FROM messages incoming
              WHERE incoming.room_id=r.id
                AND incoming.author_id IS DISTINCT FROM $2
                AND ${visibleChatMessageSql('incoming')}
                AND incoming.created_at>dismissal.dismissed_at
            )
        )) closed
      FROM rooms r
      JOIN memberships member ON member.room_id=COALESCE(r.parent_id,r.id) AND member.identity_id=$2 AND member.removed_at IS NULL
      LEFT JOIN LATERAL (
        SELECT ${messageColumns('message')} FROM messages message
        WHERE message.room_id=r.id AND ${visibleChatMessageSql('message')}
          AND (message.card_type IS DISTINCT FROM 'repository-onboarding' OR message.card->>'requesterId'=$2)
        ORDER BY created_at DESC,id DESC LIMIT 1
      ) lm ON true
      LEFT JOIN identities li ON li.id=lm.author_id
      LEFT JOIN workspace_handles author_address
        ON author_address.workspace_id=r.workspace_id AND author_address.identity_id=li.id
      LEFT JOIN identities peer ON jsonb_typeof(r.direct_participants)='array'
        AND peer.id=(SELECT p FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(r.direct_participants)='array' THEN r.direct_participants ELSE '[]'::jsonb END
        ) p WHERE p<>$2 LIMIT 1)
      LEFT JOIN workspace_handles peer_address
        ON peer_address.workspace_id=r.workspace_id AND peer_address.identity_id=peer.id
      WHERE r.workspace_id=$1 AND r.parent_id IS NULL AND r.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM visible_workspace)
      ORDER BY COALESCE(lm.created_at,r.updated_at) DESC,r.id LIMIT 201
      )
      -- These envelopes are sent to the client, never queried as JSONB. Serialize
      -- them once instead of converting every nested message into JSONB again.
      SELECT row_to_json(visible_workspace) workspace,
        (SELECT row_to_json(viewer) FROM identities viewer WHERE viewer.id=$2) viewer_row,
        COALESCE((SELECT json_agg(visible_rooms) FROM visible_rooms),'[]'::json) room_rows,
        -- Public chats the viewer has not joined: memberships is the only join store.
        COALESCE((SELECT json_agg(json_build_object('id',open_room.id,'name',open_room.name,
            'memberCount',(SELECT count(*) FROM memberships rm WHERE rm.room_id=open_room.id AND rm.removed_at IS NULL))
            ORDER BY open_room.updated_at DESC,open_room.id)
          FROM (SELECT r.id,r.name,r.updated_at FROM rooms r
            WHERE r.workspace_id=$1 AND r.parent_id IS NULL AND r.archived_at IS NULL
              AND r.visibility='public' AND r.direct_participants IS NULL
              AND NOT EXISTS (SELECT 1 FROM memberships mine WHERE mine.room_id=r.id
                AND mine.identity_id=$2 AND mine.removed_at IS NULL)
            ORDER BY r.updated_at DESC,r.id LIMIT 200) open_room),'[]'::json) joinable_rows
      FROM visible_workspace`,
      [workspaceId, viewerId], 'phone-chats-0',
    );
    const current = result.rows[0]?.workspace;
    if (!current) return null;
    reviveDates(current, ['updated_at']);
    const rooms = { rows: result.rows[0]!.room_rows.map((row) =>
      reviveDates(row, ['created_at', 'updated_at', 'archived_at',
        'peer_presence_updated_at', 'peer_activity_at'])) };
    const roomIds = rooms.rows.map((room) => room.id);
    const enrichment = await ctx.optionalEnrichment(
      'chat-enrichment',
      ctx.enrichmentDatabase.query<{
        presence: Array<{ room_id: string; peer_presence_body: Record<string, unknown> | null;
          peer_presence_updated_at: Date | null; peer_activity_at: Date | null; agents_offline: boolean }>;
        cursors: Array<{ room_id: string; unread: boolean }>;
        corner_rows: OpenCornerFactsRow[];
      }>(`WITH presence AS (
          SELECT room.id room_id,presence.body peer_presence_body,
            presence.updated_at peer_presence_updated_at,
            GREATEST(
              CASE WHEN peer.id IS NOT NULL THEN
                (SELECT max(message.created_at) FROM messages message
                 WHERE message.room_id=room.id AND message.author_id=peer.id) END,
              (SELECT max(mark.updated_at) FROM room_read_marks mark
               WHERE mark.room_id=room.id AND mark.identity_id=peer.id)
            ) peer_activity_at,
            agent_presence.agent_count > 0
              AND agent_presence.known_presence_count = agent_presence.agent_count
              AND agent_presence.online_agent_count = 0 agents_offline
          FROM rooms room
          LEFT JOIN identities peer ON peer.id=(SELECT participant FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(room.direct_participants)='array'
              THEN room.direct_participants ELSE '[]'::jsonb END
          ) participant WHERE participant<>$2 LIMIT 1)
          LEFT JOIN LATERAL(
            ${memberPresenceSql('peer.id')}
          ) presence ON peer.kind='agent'
          LEFT JOIN LATERAL(
            SELECT count(*)::int agent_count,
              count(agent_status.body)::int known_presence_count,
              count(*) FILTER(
                WHERE agent_status.body->>'status'='online'
                  AND (agent_status.updated_at>$3 OR agent_status.body->>'held'='true')
              )::int online_agent_count
            FROM memberships member
            JOIN identities agent ON agent.id=member.identity_id
              AND agent.kind='agent' AND agent.hidden_from_roster=false
            LEFT JOIN LATERAL(
              ${memberPresenceSql('member.identity_id')}
            ) agent_status ON true
            WHERE member.room_id=COALESCE(room.parent_id,room.id) AND member.removed_at IS NULL
          ) agent_presence ON true
          WHERE room.id=ANY($1::uuid[])
        ), cursors AS (
          SELECT room.id room_id,(latest.id IS NOT NULL AND (
            mark.message_created_at IS NULL OR latest.id<>mark.message_id AND
            (latest.created_at,latest.id)>(mark.message_created_at,mark.message_id)
          )) unread
          FROM rooms room
          LEFT JOIN room_read_marks mark ON mark.room_id=room.id AND mark.identity_id=$2
          LEFT JOIN LATERAL(
            SELECT message.id,message.created_at FROM messages message
            WHERE message.room_id=room.id AND ${unreadMessageSql('message')}
            ORDER BY message.created_at DESC,message.id DESC LIMIT 1
          ) latest ON true
          WHERE room.id=ANY($1::uuid[])
        ), corner_rows AS (${openCornerFactsSql('=ANY($1::uuid[])', '$2')})
        SELECT COALESCE((SELECT json_agg(p) FROM presence p),'[]'::json) presence,
          COALESCE((SELECT json_agg(c) FROM cursors c),'[]'::json) cursors,
          COALESCE((SELECT json_agg(c ORDER BY c.created_at DESC,c.id DESC)
            FROM corner_rows c),'[]'::json) corner_rows`,
        [roomIds, viewerId, new Date(Date.now() - AGENT_REACHABLE_HORIZON_MS)], 'phone-chats-1',
      ),
    );
    const enrichmentRow = enrichment?.rows[0];
    const presence = enrichmentRow ? { rows: enrichmentRow.presence.map((row) =>
      reviveDates(row, ['peer_presence_updated_at', 'peer_activity_at'])) } : undefined;
    const cursors = enrichmentRow ? { rows: enrichmentRow.cursors } : undefined;
    const cornerRows = enrichmentRow?.corner_rows;
    // A timed-out enrichment is unknown, not empty. Omitting its fields (and
    // naming unread, which old phones require) lets the phone keep what it
    // last knew instead of painting no corners and no unread dot.
    const countsByRoom = cornerRows ? chatCornerCounts(cornerRows.map((corner) =>
      reviveDates(corner, ['archived_at', 'latest_created_at']))) : undefined;
    const unavailable = [
      ...(cursors ? [] : ['unread' as const]),
      ...(cornerRows ? [] : ['corners' as const]),
    ];
    const presenceByRoom = new Map(presence?.rows.map((item) => [item.room_id, item]) ?? []);
    const cursorByRoom = new Map(cursors?.rows.map((item) => [item.room_id, item]) ?? []);
    for (const room of rooms.rows) {
      const item = presenceByRoom.get(room.id);
      room.peer_presence_body = item?.peer_presence_body ?? null;
      room.peer_presence_updated_at = item?.peer_presence_updated_at ?? null;
      room.peer_activity_at = item?.peer_activity_at ?? null;
      room.agents_offline = item?.agents_offline ?? false;
      if (cursors) room.unread = cursorByRoom.get(room.id)?.unread ?? false;
    }
    return {
      workspace: {
        id: current.id,
        name: current.name,
        ...(current.avatar ? { avatar: assetUrl(current.avatar, ctx.publicOrigin) } : {}),
        visibility: current.visibility,
        role: current.role,
        updatedAt: unix(current.updated_at),
      },
      chats: rooms.rows
        .slice(0, 200)
        .map((row) => ({
          room: roomHeader(row, ctx.publicOrigin),
          ...(row.voice_call ? { voiceCall: row.voice_call } : {}),
          leaveDeletesRoom:
            !row.direct_participants &&
            (current.role === 'owner' || current.role === 'admin') &&
            row.leave_deletes_room,
          ...(row.agents_offline ? { agentsOffline: true } : {}),
          ...(row.closed ? { closed: true } : {}),
          memberCount: Number(row.member_count),
          latestAgentTurns: phoneProjectAgentTurns(ctx, (row.turns ?? []).map(turn => reviveDates(turn, ['started_at', 'created_at']))),
          ...(countsByRoom
            ? (countsByRoom.get(row.id) ?? { cornerCount: 0, waitingCornerCount: 0, mineCornerCount: 0 })
            : {}),
          ...(row.latest_row ? { latestMessage: {
            ...projectedMessage(reviveDates(row.latest_row, ['created_at', 'deleted_at']), ctx.publicOrigin, viewerId),
            ...(row.latest_tags_viewer ? { mentionsViewer: true as const } : {}),
          } } : {}),
          ...(row.peer_id && row.peer_kind && row.peer_name
            ? {
                directMessage: {
                  peer: identity(
                    {
                      id: row.peer_id,
                      kind: row.peer_kind,
                      name: row.peer_name,
                      handle: row.peer_handle,
                      avatar: row.peer_avatar,
                      face_id: row.peer_face,
                    },
                    ctx.publicOrigin,
                  ),
                  ...(ctx.directMessagePresence(row)
                    ? { presence: ctx.directMessagePresence(row)! }
                    : {}),
                },
              }
            : {}),
          ...(row.unread !== undefined ? { unread: row.unread } : {}),
          ...(row.repository_key
            ? {
                repositoryName:
                  row.repository_name ?? row.repository_key.split('/').at(-1) ?? row.repository_key,
              }
            : {}),
          ...(row.needs_you
            ? { agentState: 'needs-you' as const }
            : row.working
              ? { agentState: 'working' as const }
              : {}),
          ...(row.needs_you
            ? {
                attentionReason: {
                  kind: 'approval' as const,
                  ...(row.attention_actor_name ? { actor: row.attention_actor_name } : {}),
                },
              }
            : {}),
        }))
        // A viewer's corner going to waiting lifts its Room like a message does.
        .sort((left, right) => chatActivityAt(right) - chatActivityAt(left)),
      viewer: identity(result.rows[0]!.viewer_row, ctx.publicOrigin),
      truncated: rooms.rows.length > 200,
      ...(unavailable.length ? { unavailable } : {}),
      joinable: result.rows[0]!.joinable_rows,
      watchFilters: rooms.rows.length
        ? [{ kinds: [9, 9000, 9001, 9002, 9007, 9008], '#h': rooms.rows.map((row) => row.id) }]
        : [],
    };
  }


  export function phoneDirectMessagePresence(ctx: PhoneContext, row: {
    peer_id: string | null;
    peer_kind: 'human' | 'agent' | null;
    peer_presence_body: Record<string, unknown> | null;
    peer_presence_updated_at: Date | null;
    peer_activity_at: Date | null;
  }): { status: 'online' | 'offline'; observedAt: number; held?: true } | undefined {
    if (!row.peer_id || !row.peer_kind) return undefined;
    if (row.peer_kind === 'agent' && row.peer_presence_body && row.peer_presence_updated_at) {
      const held = row.peer_presence_body.held === true;
      const status = isAgentReachable(
        row.peer_presence_body.status === 'online' ? 'online' : 'offline',
        row.peer_presence_updated_at.getTime(),
        Date.now(),
        held,
      )
        ? 'online'
        : 'offline';
      return {
        status,
        observedAt: Math.max(
          Number(row.peer_presence_body.observedAt ?? 0),
          unix(row.peer_presence_updated_at),
        ),
        ...(held && status === 'online' ? { held: true as const } : {}),
      };
    }
    const connection = ctx.live?.humanPresence(row.peer_id);
    const activityAt = row.peer_activity_at ? unix(row.peer_activity_at) : undefined;
    const observedAt = Math.max(connection?.observedAt ?? 0, activityAt ?? 0);
    return observedAt
      ? { status: connection?.status === 'online' ? 'online' : 'offline', observedAt }
      : undefined;
  }
