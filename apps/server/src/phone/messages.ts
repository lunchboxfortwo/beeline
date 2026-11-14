import type { RoomViewMessage } from '@beeline/api-contract/phone';
import { MESSAGE_REACTION_EMOJIS } from '@beeline/api-contract/phone';
import { queueMessage } from '../agent-command.js';
import { CommandRefusalError } from '../command-refusal.js';
import { CornerAccessDatabase } from '../corner-access-database.js';
import { recordSystemReportMention } from '../feedback.js';
import { tombstoneInstitutionalMemoryForMessage } from '../institutional-memory-shadow.js';
import { messageColumns } from '../message-columns.js';
import { unreadMessageSql,visibleChatMessageSql } from '../read-cursor.js';
import { observeOnboardingMessage } from '../signin-funnel.js';
import { deletedMessageEvent } from '../system-line.js';
import { phoneRequireWorkspaceMember } from './access.js';
import type { PhoneContext } from './context.js';
import { phoneLiveStarPrompt,phoneReadLiveDelta } from './live-reads.js';
import { Input,Output } from './types.js';



  export async function phoneMarkRead(ctx: PhoneContext, roomId: string, messageIdValue: string, viewerId: string): Promise<void> {
    const result = (await ctx.database.query<{ eligible: boolean; changed: boolean }>(
      `WITH eligible AS (
         SELECT message.id,message.created_at FROM messages message
         JOIN rooms room ON room.id=message.room_id
         JOIN memberships room_member ON room_member.room_id=COALESCE(room.parent_id,room.id)
           AND room_member.identity_id=$2 AND room_member.removed_at IS NULL
         JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
           AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
           AND workspace_member.removed_at IS NULL
         WHERE message.id=$3 AND room.id=$1
       ), written AS (
         INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
         SELECT $1,$2,created_at,id FROM eligible
         ON CONFLICT(room_id,identity_id) DO UPDATE
           SET message_created_at=EXCLUDED.message_created_at,message_id=EXCLUDED.message_id,
             updated_at=now()
         WHERE (EXCLUDED.message_created_at,EXCLUDED.message_id)>
           (room_read_marks.message_created_at,room_read_marks.message_id)
         RETURNING message_id
       ) SELECT EXISTS(SELECT 1 FROM eligible) eligible,
           EXISTS(SELECT 1 FROM written) changed`,
      [roomId, viewerId, messageIdValue],
    )).rows[0];
    if (!result?.eligible) throw new Error('message not found');
    // The committed row's PostgreSQL notification reconciles every reader
    // device, including those on this server. Publishing here duplicates it.
  }


  /**
   * Put the boundary back in front of `messageIdValue`, so the Room reads
   * unread from that message onward. The mark lands on the newest countable
   * row strictly older than the target; when nothing precedes it the mark is
   * removed entirely and the whole Room is unread again.
   *
   * Unlike `markRead` this is not monotonic — moving the boundary backwards is
   * the entire point — so it writes unconditionally.
   *
   * The target must be a row this viewer's unread count would actually count.
   * Anything else — their own message above all — makes the caller a boundary
   * the count then contradicts: it reported nothing unread while the open Room
   * drew a NEW MESSAGES divider at the chosen row (review 2026-09-22).
   */
  export async function phoneMarkUnread(ctx: PhoneContext, roomId: string, messageIdValue: string, viewerId: string): Promise<void> {
    const result = (await ctx.database.query<{ accessible: boolean; countable: boolean }>(
      `WITH accessible AS (
         SELECT ${messageColumns('message')} FROM messages message
         JOIN rooms room ON room.id=message.room_id
         JOIN memberships room_member ON room_member.room_id=COALESCE(room.parent_id,room.id)
           AND room_member.identity_id=$2 AND room_member.removed_at IS NULL
         JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
           AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
           AND workspace_member.removed_at IS NULL
         WHERE message.id=$1 AND room.id=$3
       ), target AS (
         SELECT accessible_row.* FROM accessible accessible_row WHERE ${unreadMessageSql('accessible_row')}
       ), previous AS (
         SELECT earlier.id,earlier.created_at FROM target
         JOIN messages earlier ON earlier.room_id=target.room_id
           AND (earlier.created_at,earlier.id)<(target.created_at,target.id)
           AND ${visibleChatMessageSql('earlier')}
         ORDER BY earlier.created_at DESC,earlier.id DESC LIMIT 1
       ), written AS (
         INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
         SELECT $3,$2,created_at,id FROM previous
         ON CONFLICT(room_id,identity_id) DO UPDATE
           SET message_created_at=EXCLUDED.message_created_at,
               message_id=EXCLUDED.message_id,updated_at=now()
         RETURNING message_id
       ), cleared AS (
         DELETE FROM room_read_marks
         WHERE room_id=$3 AND identity_id=$2 AND EXISTS(SELECT 1 FROM target)
           AND NOT EXISTS(SELECT 1 FROM previous)
         RETURNING message_id
       ) SELECT EXISTS(SELECT 1 FROM accessible) accessible,
           EXISTS(SELECT 1 FROM target) countable`,
      [messageIdValue, viewerId, roomId],
    )).rows[0];
    if (!result?.accessible) throw new Error('message not found');
    // 'invalid' is what the router reads as a 400 — the row is real and
    // readable, it is simply not something this viewer can hold unread.
    if (!result.countable)
      throw new Error(
        'messageId is invalid: only a row that counts as unread can be marked unread',
      );
    // INSERT/UPDATE/DELETE all notify through PostgreSQL, once per changed row.
  }


  export async function phoneUploadMedia(ctx: PhoneContext,
    viewerId: string,
    bytes: Uint8Array,
    mimeType: string,
    name: string,
    maximumBytes: number,
  ) {
    if (!ctx.objects) throw new Error('object storage is not configured');
    if (!bytes.length || bytes.length > maximumBytes)
      throw new Error('media size is outside the allowed range');
    const stored = await ctx.objects.uploadSharedFile(viewerId, bytes, mimeType, name);
    return {
      url: stored.url,
      name: stored.title,
      mimeType: stored.mimeType,
      size: stored.size,
      sha256: stored.sha256,
    };
  }


  /** Only transport receipts defer observation; service completion still includes its milestones. */
  export async function phoneObserveSentMessage(ctx: PhoneContext, roomId: string, viewerId: string, defer: boolean): Promise<void> {
    const work = () =>
      observeOnboardingMessage(ctx.database, roomId, viewerId).catch((error) =>
        console.error('[onboarding]', error),
      );
    const backgroundWork = CornerAccessDatabase.physical(ctx.database).backgroundWork;
    if (defer && backgroundWork)
      backgroundWork.run(async () => {
        // Queue the response before analytics competes for a database connection.
        await new Promise<void>((resolve) => setImmediate(resolve));
        await work();
      });
    else await work();
  }

  export async function phoneSendMessage(ctx: PhoneContext,
    input: Input<'sendRoomMessage'> | Input<'sendRoomReply'>,
    author: string, sourceClient?: { id: string; name: string }, familyId?: string,
  ): Promise<Output<'sendRoomMessage'>> {
    const saved = await queueMessage(ctx.database, { kind: 'post', roomId: input.roomId,
      authorId: author, text: input.text, id: input.messageId, attachments: input.attachments,
      replyTo: 'parentMessageId' in input ? input.parentMessageId : undefined, sourceClient,
    });
    if (input.text.includes('@')) {
      const observe = async () => { await recordSystemReportMention(ctx.database, {
        roomId: input.roomId, messageId: saved.id, authorId: author, text: input.text,
        ...(familyId ? { familyId } : {}),
      }).catch(error => console.warn('[message] feedback observation failed', error)); };
      const background=CornerAccessDatabase.physical(ctx.database).backgroundWork;
      if (background) background.run(observe); else void observe();
    }
    const receipt = await ctx.receiptMessage(input.roomId, author, saved.id, ctx.database)
      .catch(error => { console.warn('[message] receipt enrichment omitted:', error); return {}; });
    return { ...receipt, messageId: saved.id, pendingAgentCommands: saved.commands.filter(command => command.state === 'pending').map(command => ({
      requestId: command.turn_request_id, agentPubkey: command.agent_id,
      createdAt: Math.floor(new Date(command.created_at).getTime() / 1000),
    })) };
  }

  export const phoneSendReply = phoneSendMessage;


  export async function phoneReactToMessage(ctx: PhoneContext, input: Input<'reactToMessage'>, viewerId: string): Promise<Output<'reactToMessage'>> {
    if (!MESSAGE_REACTION_EMOJIS.includes(input.emoji)) throw new Error('reaction is invalid');
    await ctx.database.transaction(async (database) => {
      const row = (
        await database.query<{ reactions: Record<string, string[]> }>(
          `SELECT message.reactions
           FROM messages message
           JOIN memberships membership ON membership.room_id=message.room_id
             AND membership.identity_id=$3 AND membership.removed_at IS NULL
           JOIN memberships workspace_member ON workspace_member.workspace_id=membership.workspace_id
             AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$3
             AND workspace_member.removed_at IS NULL
           WHERE message.id=$1 AND message.room_id=$2 AND message.presentation='message'
             AND message.deleted_at IS NULL
           FOR UPDATE OF message`,
          [input.messageId, input.roomId, viewerId],
        )
      ).rows[0];
      if (!row) throw new CommandRefusalError('message is not available for reaction', 404);
      const reactions = { ...(row.reactions ?? {}) };
      const reactors = new Set(reactions[input.emoji] ?? []);
      if (reactors.has(viewerId)) reactors.delete(viewerId);
      else reactors.add(viewerId);
      if (reactors.size) reactions[input.emoji] = [...reactors];
      else delete reactions[input.emoji];
      await database.query(`UPDATE messages SET reactions=$3::jsonb WHERE id=$1 AND room_id=$2`, [
        input.messageId,
        input.roomId,
        JSON.stringify(reactions),
      ]);
    });
    const delta = await phoneReadLiveDelta(ctx, input.roomId, viewerId, {
      type: 'message', messageId: input.messageId,
    });
    if (delta?.type !== 'message-delta') return null;
    const prompt = await phoneLiveStarPrompt(ctx, viewerId).catch(() => undefined);
    return { ...delta.message, ...prompt };
  }


  export async function phoneDeleteRoomMessage(ctx: PhoneContext,
    input: Input<'deleteRoomMessage'>,
    viewerId: string,
  ): Promise<RoomViewMessage | null> {
    if (!/^[0-9a-f]{64}$/.test(input.messageId)) throw new Error('messageId is invalid');
    await ctx.database.transaction(async (database) => {
      const deleted = await database.query<{ author_id: string; deleted_by: string }>(
        `UPDATE messages message SET deleted_at=COALESCE(message.deleted_at,now()),
           deleted_by=COALESCE(message.deleted_by,$3),text='',attachments='[]'::jsonb,reactions='{}'::jsonb
         FROM rooms room
         WHERE message.id=$1 AND message.room_id=$2 AND message.room_id=room.id
           AND message.presentation='message' AND EXISTS(
               SELECT 1 FROM memberships member
               WHERE member.room_id=COALESCE(room.parent_id,room.id) AND member.identity_id=$3
                 AND member.removed_at IS NULL FOR SHARE OF member
             ) AND (message.author_id=$3 OR EXISTS(
               SELECT 1 FROM memberships manager
               WHERE manager.workspace_id=room.workspace_id AND manager.room_id IS NULL
                 AND manager.identity_id=$3 AND manager.role IN ('owner','admin')
                 AND manager.removed_at IS NULL
             ))
         RETURNING message.author_id,message.deleted_by`,
        [input.messageId, input.roomId, viewerId],
      );
      database = new CornerAccessDatabase(database);
      const row = deleted.rows[0];
      if (!row) throw new CommandRefusalError('message is not available for deletion', 404);
      // The deleted row keeps its place and time and reads as a system line
      // naming who deleted it; nothing new is posted to the Room.
      await database.query(
        `UPDATE messages message SET system_event=$2::jsonb WHERE message.id=$1`,
        [
          input.messageId,
          JSON.stringify(await deletedMessageEvent(database, row.deleted_by, row.author_id,input.roomId)),
        ],
      );
      await tombstoneInstitutionalMemoryForMessage(database, input.messageId);

    });
    const delta = await phoneReadLiveDelta(ctx, input.roomId, viewerId, {
      type: 'message', messageId: input.messageId,
    });
    return delta?.type === 'message-delta' ? delta.message : null;
  }


  export async function phoneSetMessageBookmark(ctx: PhoneContext,
    input: Input<'setMessageBookmark'>,
    viewerId: string,
  ): Promise<Output<'setMessageBookmark'>> {
    if (!/^[0-9a-f]{64}$/.test(input.messageId)) throw new Error('messageId is invalid');
    if (!input.bookmarked) {
      await ctx.database.query(
        `DELETE FROM message_bookmarks WHERE identity_id=$1 AND message_id=$2`,
        [viewerId, input.messageId],
      );
      return { bookmarked: false };
    }
    return ctx.database.transaction(async (database) => {
      const source = (
        await database.query<{
          workspace_id: string;
          room_name: string;
          room_kind: 'room' | 'corner';
          message_created_at: Date;
        }>(
          `SELECT room.workspace_id,room.name room_name,
             CASE WHEN room.parent_id IS NULL THEN 'room' ELSE 'corner' END room_kind,
             message.created_at message_created_at
           FROM messages message
           JOIN rooms room ON room.id=message.room_id
           JOIN memberships membership ON membership.room_id=COALESCE(room.parent_id,room.id)
             AND membership.identity_id=$3 AND membership.removed_at IS NULL
           JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
             AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$3
             AND workspace_member.removed_at IS NULL
           WHERE message.id=$1 AND message.room_id=$2 AND message.presentation='message'`,
          [input.messageId, input.roomId, viewerId],
        )
      ).rows[0];
      if (!source) throw new CommandRefusalError('message is not available for bookmarking', 404);
      await database.query(
        `INSERT INTO message_bookmarks(
           identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,
           message_created_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(identity_id,message_id) DO NOTHING`,
        [
          viewerId,
          source.workspace_id,
          input.roomId,
          input.messageId,
          source.room_name,
          source.room_kind,
          source.message_created_at,
        ],
      );
      return { bookmarked: true };
    });
  }


  export async function phoneClearMessageBookmarks(ctx: PhoneContext,
    input: Input<'clearMessageBookmarks'>,
    viewerId: string,
  ): Promise<void> {
    await phoneRequireWorkspaceMember(ctx, input.workspaceId, viewerId);
    await ctx.database.query(
      `DELETE FROM message_bookmarks WHERE workspace_id=$1 AND identity_id=$2`,
      [input.workspaceId, viewerId],
    );
  }
