import type { DaemonAttachment } from '@beeline/api-contract/daemon';
import { roomAudienceCanReadSourceSql } from '../institutional-history.js';
import { mediaIdFromUrl } from '../media-ttl.js';
import type { DaemonContext } from './context.js';
import { Input, AccessDeniedError, daemonTranscriptVisibilitySql, markExpiredAttachments } from './values.js';
import { agentRoomMembershipJoins } from './access.js';
import { daemonReach } from './corner-messages.js';
import { deliveredMessage } from '../corner-brief.js';

const readableMessage = daemonTranscriptVisibilitySql('message');
// A borrowed review source grants access only to the addressed transcript.
// A lookup outside the addressed chat must also respect its human audience.
const readableScope = `${readableMessage} AND (message.room_id=$1 OR (NOT $4::boolean AND EXISTS (
  SELECT 1 FROM rooms source ${agentRoomMembershipJoins('source', '$3')}
  JOIN rooms output ON output.id=$1 AND output.workspace_id=source.workspace_id
  WHERE source.id=message.room_id
    AND ${roomAudienceCanReadSourceSql('COALESCE(output.parent_id,output.id)', 'COALESCE(source.parent_id,source.id)')})))`;

  export async function daemonRoomMessage(ctx: DaemonContext, input: Input<'getRoomMessage'>, agentId: string): Promise<{ messageId: string; body: string; attachments: DaemonAttachment[] }> {
    if (input.attachmentId !== undefined) return ctx.roomAttachment(input, agentId);
    let borrowedSource = false;
    await ctx.access(input.roomId, agentId).catch(async (error: unknown) => {
      if (!(error instanceof AccessDeniedError)) throw error;
      try {
        await ctx.reviewSourceAccess(input.roomId, agentId);
        borrowedSource = true;
      } catch (sourceError) {
        if (!(sourceError instanceof AccessDeniedError)) throw sourceError;
        await ctx.reach(input.roomId, agentId);
      }
    });
    if (!input.messageId || input.messageId.length > 128) throw new Error('invalid message id');
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000_000)
      throw new Error('invalid message offset');
    const delivered = await deliveredMessage(ctx.database, input.messageId, agentId);
    if (delivered) input = { ...input, messageId: delivered.id };
    // Private hand-offs expose the command id as their message id. Only the
    // sender and recipient may reopen that payload, even in a shared Room.
    const handoff = (await ctx.database.query<{
      agent_id: string; author_id: string; body: string;
      attachments: DaemonAttachment[]; accessible: boolean;
    }>(
      `SELECT command.agent_id,command.private_payload->>'authorId' author_id,
              command.private_payload->>'text' body,
              command.private_payload->'attachments' attachments,
              EXISTS(SELECT 1 FROM rooms handoff_room
                     JOIN memberships member ON member.room_id=COALESCE(handoff_room.parent_id,handoff_room.id)
                     WHERE handoff_room.id=CASE WHEN command.agent_id=$2 THEN command.room_id
                       ELSE NULLIF(command.private_payload->>'fromRoomId','')::uuid END
                       AND member.identity_id=$2
                       AND member.removed_at IS NULL) accessible
       FROM agent_commands command
       WHERE command.id=$1 AND command.private_payload IS NOT NULL`,
      [input.messageId, agentId],
    )).rows[0];
    if (handoff && (borrowedSource || !handoff.accessible ||
        (handoff.agent_id !== agentId && handoff.author_id !== agentId)))
      throw new Error('message access denied: private hand-off');
    let row = handoff ?? (
      await ctx.database.query<{ body: string; attachments: DaemonAttachment[] }>(
        `SELECT CASE WHEN card_type='agent-command' THEN COALESCE(card->>'text',text) ELSE text END body,
                attachments
         FROM messages message
         WHERE message.id=$2 AND ${readableScope}`,
        [input.roomId, input.messageId, agentId, borrowedSource],
      )
    ).rows[0];
    if (!row && !borrowedSource) {
      // A dispatched review lends access to current brief citations only.
      // Keep this separate from Room access and requester-derived authority.
      row = (await ctx.database.query<{ body: string; attachments: DaemonAttachment[] }>(
        `SELECT message.text body,message.attachments
         FROM messages message
         JOIN rooms corner ON corner.id=$1 AND corner.archived_at IS NULL
         JOIN rooms source ON source.id=message.room_id AND source.workspace_id=corner.workspace_id
         JOIN corner_github_cache fact ON fact.corner_id=corner.id
         JOIN LATERAL (SELECT corner_brief_revisions.* FROM corner_brief_revisions
           WHERE corner_id=corner.id ORDER BY revision DESC LIMIT 1) brief
           ON brief.source_room_id=message.room_id
         WHERE message.id=$3 AND ${readableMessage} AND message.presentation='message'
           AND (message.id=brief.source_message_id
             OR message.id=brief.approval_basis->>'sourceMessageId'
             OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(brief.intent_verbatim,'[]'::jsonb)) intent
               WHERE intent->>'sourceMessageId'=message.id))
           AND EXISTS(SELECT 1 FROM agent_commands command
             WHERE command.room_id=corner.id AND command.agent_id=$2
               AND command.state='pending' AND command.review_context IS NOT NULL
               AND command.review_context->>'headSha'=fact.lifecycle->'pr'->>'headSha'
               AND command.review_context->'pullRequest'=fact.lifecycle->'pr'->'number'
               AND command.review_context->>'briefRevision'=brief.revision::text)
         LIMIT 1`,
        [input.roomId,agentId,input.messageId],
      )).rows[0];
    }
    if (!row) {
      // Literal prefix comparison avoids treating user-supplied % or _ as wildcards.
      // Resolve the entire readable scope before selecting a candidate.
      const candidates = await ctx.database.query<{ id: string }>(
        `SELECT message.id FROM messages message
         WHERE starts_with(message.id,$2) AND ${readableScope}
         ORDER BY message.id LIMIT 21`,
        [input.roomId, input.messageId, agentId, borrowedSource],
      );
      if (candidates.rows.length > 1)
        throw new Error(`ambiguous message id: ${candidates.rows.slice(0, 20).map(candidate => candidate.id).join(', ')}${candidates.rows.length > 20 ? ' (more matches; use a longer id)' : ''}`);
      if (candidates.rows.length === 1 && candidates.rows[0]!.id !== input.messageId)
        return ctx.roomMessage({ ...input, messageId: candidates.rows[0]!.id }, agentId);
      if (borrowedSource) throw new AccessDeniedError();
      // Existing messages outside the readable scope are refusals, not misses:
      // download_attachment must preserve forbidden rather than not_found.
      const elsewhere = await ctx.database.query(
        `SELECT 1 FROM messages message
         WHERE message.id=$1 AND ${readableMessage}`,
        [input.messageId],
      );
      if (elsewhere.rowCount) throw new Error('message access denied from this chat');
      throw new Error('message not found in this chat');
    }
    let body = row.body;
    if (offset) {
      const characters = [...body];
      if (offset > characters.length) throw new Error('offset exceeds message body');
      body = characters.slice(offset).join('');
    }
    const attachments = markExpiredAttachments(
      row.attachments ?? [],
      await ctx.expiredMediaIds(row.attachments ?? []),
    );
    return {
      messageId: input.messageId,
      body,
      attachments: await ctx.withStoredDigests(attachments),
    };
  }


  /** Locate candidates only; the existing message/brief reads decide reach. */
  export async function daemonRoomAttachment(ctx: DaemonContext, input: Input<'getRoomMessage'>, agentId: string): Promise<{
    messageId: string; body: string; attachments: DaemonAttachment[];
  }> {
    const wanted = input.attachmentId!.trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(wanted))
      return { messageId: '', body: '', attachments: [] };
    const candidates = await ctx.database.query<{ id: string }>(
      `SELECT message.id FROM messages message
       WHERE ${readableMessage} AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(message.attachments) file
         WHERE file->>'mediaId'=$1 OR file->>'url' LIKE '%/v1/media/' || $1)
       UNION
       SELECT command.id FROM agent_commands command WHERE EXISTS (
         SELECT 1 FROM jsonb_array_elements(command.private_payload->'attachments') file
         WHERE file->>'mediaId'=$1 OR file->>'url' LIKE '%/v1/media/' || $1)`, [wanted]);
    for (const candidate of candidates.rows) {
      try {
        const message = await daemonRoomMessage(ctx, { ...input, attachmentId: undefined, messageId: candidate.id }, agentId);
        if (message.attachments.some(file => mediaIdFromUrl(file.url) === wanted)) return message;
      } catch (error) {
        if (!(error instanceof AccessDeniedError) &&
            !/message (access denied|not found)/.test(String(error))) throw error;
      }
    }
    const briefs = await ctx.database.query<{ corner_id: string; attachments: import('@beeline/api-contract/daemon').CornerBriefAttachment[] }>(
      `SELECT corner_id,attachments FROM corner_brief_revisions brief WHERE EXISTS (
         SELECT 1 FROM jsonb_array_elements(brief.attachments) file WHERE file->>'objectId'=$1)
       ORDER BY revision DESC`, [wanted]);
    for (const brief of briefs.rows) {
      try { await daemonReach(ctx, brief.corner_id, agentId); }
      catch (error) { if (error instanceof AccessDeniedError) continue; throw error; }
      const file = brief.attachments.find(file => file.objectId === wanted)!;
      return { messageId: wanted, body: '', attachments: [{
        url: `/v1/media/${wanted}`, name: file.title, mimeType: file.mime,
        size: file.size, sha256: file.sha256,
      }] };
    }
    return { messageId: '', body: '', attachments: [] };
  }


  /** Each ready attachment's stored sha256, so a helper can skip re-downloading bytes it holds. */
  export async function daemonWithStoredDigests(ctx: DaemonContext,
    attachments: readonly DaemonAttachment[],
  ): Promise<DaemonAttachment[]> {
    const ids = attachments.flatMap((attachment) => mediaIdFromUrl(attachment.url) ?? []);
    if (!ids.length) return [...attachments];
    const digests = new Map(
      (
        await ctx.database.query<{ id: string; sha256: string }>(
          `SELECT id::text id,sha256 FROM objects WHERE id=ANY($1::uuid[]) AND state='ready'`,
          [ids],
        )
      ).rows.map((object) => [object.id, object.sha256]),
    );
    return attachments.map((attachment) => {
      const sha256 = digests.get(mediaIdFromUrl(attachment.url) ?? '');
      return sha256 ? { ...attachment, sha256 } : attachment;
    });
  }


  /** Media ids these attachments name whose bytes are past the TTL (`media-ttl.ts`). */
  export async function daemonExpiredMediaIds(ctx: DaemonContext,
    attachments: readonly DaemonAttachment[],
  ): Promise<ReadonlySet<string>> {
    const ids = new Set<string>();
    for (const attachment of attachments) {
      const id = mediaIdFromUrl(attachment.url);
      if (id) ids.add(id);
    }
    if (!ids.size) return ids;
    const expired = await ctx.database.query<{ id: string }>(
      `SELECT id::text id FROM object_expirations WHERE id=ANY($1::uuid[])`,
      [[...ids]],
    );
    return new Set(expired.rows.map((row) => row.id));
  }
