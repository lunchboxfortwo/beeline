import { githubProviderKey } from './providers/index.js';
import { restoreRoomMemberships } from './membership-join.js';
import { roomEventSubscriptions } from './agent-subscriptions.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { CornerAccessDatabase } from './corner-access-database.js';
import { approvalAsk } from './tray-approval-ask.js';
import { routeSystemCommand } from './agent-command.js';
import { createHash, randomBytes } from 'node:crypto';
import {
  formatSystemLine,
  isSubscribableEventKind,
  type SystemEvent,
  type SystemEventKind,
  type SystemObject,
  type SystemSubject,
} from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import type { SystemTranscript } from '@beeline/api-contract/phone';
import { systemTranscript } from './system-transcript.js';
import {
  SYSTEM_IDENTITY_HANDLE,
  SYSTEM_IDENTITY_ID,
  SYSTEM_IDENTITY_NAME,
} from '@beeline/api-contract/system-identity';

/**
 * The one producer of every system notification in a Room or Workspace.
 *
 * Every membership note, yolo change, grant line, GitHub fact,
 * corner marker, scheduled prompt and card header is composed here from the
 * System-message catalog, in one
 * grammar (`@beeline/api-contract` `system-events.ts`): `<subject> <verb>
 * [ <object>][ · <consequence>]`. The stored text is what an old phone shows
 * verbatim; the structured `messages.system_event` beside it is what a current
 * phone renders (names as tappable mentions, the object linked by its URL,
 * lifecycle runs folded). The daemon posts events and the server phrases them
 * here. The architecture check enforces this file's write ownership.
 *
 * A line is the default container. A card (`presentation: 'card'`) is only for
 * something a tap must settle — a grant request, a connector offer, a permission
 * ask, a choice question or poll, the merge summary with its pull-request
 * link — and keeps its own component on the phone; its header sentence still
 * comes from here.
 */
export interface SystemLineInput {
  readonly roomId: string;
  readonly replyToMessageId?: string;
  /** The row's author; drives the daemon inbox filter and push exclusions. Defaults to the subject id. */
  readonly authorId?: string;
  /** A deterministic id makes the insert idempotent (`ON CONFLICT DO NOTHING`). */
  readonly id?: string;
  readonly subject: SystemSubject;
  readonly verb: string;
  /**
   * What this line IS. A producer says the kind and nothing else: the
   * subscriber fill below turns it into wakes, in one place. A line with no
   * kind is one nothing subscribes to.
   */
  readonly kind?: SystemEventKind;
  /** The schedule a `schedule-ran` line fired, so its run may inherit its sessions. */
  readonly scheduleId?: string;
  readonly payload?: unknown;
  readonly subscriptionId?: string;
  readonly subscriptionPrompt?: string;
  readonly subscriptionWorkflowSlug?: string;
  readonly object?: string | SystemObject;
  readonly consequence?: string;
  /** A second named actor in the consequence slot (currently the inviter on a join). */
  readonly attribution?: {
    readonly verb: string;
    readonly actor: SystemSubject;
  };
  /**
   * Agents this line wakes, named outright because a system line addresses by
   * FACT rather than by text: nothing in `@scheduler ran a schedule for Ada`
   * spells a handle, so there is no tag for `message-mentions.ts` to read. This
   * is a routing list only — it starts turns, and never stands in for a tag.
   */
  readonly wakes?: readonly string[];
  /** Agent-only browser observations use activity and never paint in the transcript. */
  readonly presentation?: 'system' | 'card' | 'activity';
  readonly cardType?: string;
  /** False stores the line and does not route it. The caller advances the corner. */
  readonly routeCommands?: boolean;
  readonly card?: Record<string, unknown>;
  readonly requestId?: string;
  readonly commandId?: string;
  readonly durableFact?: 'failure' | 'merge' | 'action';
  /**
   * The message this line is a consequence of, when it is one.
   *
   * Passed only by the server, from a fact the server read itself — an agent's
   * active turn receipt, never a value a helper sent. A line with a cause is
   * part of a cascade: it inherits that cause's root, sits one deeper, and is
   * refused when the cascade has run too deep or woken too many turns. A line
   * with a kind and no cause is the ROOT of its own cascade at depth 0, and is
   * never refused — a join must not be lost to a guard meant for agents.
   */
  readonly causeId?: string;
  /**
   * The message this line is written BECAUSE OF, for a line with no kind.
   *
   * Ordering only — it is never stored as a cascade, so an unkinded line keeps
   * waking nobody. The write stamps `created_at` strictly past this message's
   * second, so a consequence can never sort above its cause on a surface that
   * orders by whole seconds (`RoomViewMessage.createdAt` is floored): a
   * second-resolution tie otherwise breaks on the random row id, which is how
   * an access notice landed above the message that provoked it.
   */
  readonly afterMessageId?: string;
}

export function directMessageRoomId(
  workspaceId: string,
  participants: readonly [string, string],
): string {
  const bytes = createHash('sha256')
    .update(`buzz-dm:v1:${workspaceId}:${participants.join(':')}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function ensureSystemIdentity(database: SqlDatabase): Promise<void> {
  // Existing canonical authors need no write lock. An unconditional conflict
  // UPDATE serializes unrelated corner transactions on this shared row.
  await database.query(
    `INSERT INTO identities(id,kind,name,handle,hidden_from_roster,avatar)
     SELECT $1,'human',$2,$3,true,$4
     WHERE NOT EXISTS (
       SELECT 1 FROM identities WHERE id=$1
         AND (name,handle,hidden_from_roster,avatar)
           IS NOT DISTINCT FROM ($2::text,$3::text,true,$4::text)
     ) ON CONFLICT(id) DO UPDATE
     SET name=EXCLUDED.name,handle=EXCLUDED.handle,hidden_from_roster=true,
         avatar=EXCLUDED.avatar,updated_at=now()`,
    [
      SYSTEM_IDENTITY_ID,
      SYSTEM_IDENTITY_NAME,
      SYSTEM_IDENTITY_HANDLE,
      '/v1/connectors/logo/system.svg',
    ],
  );
}

export async function ensureSystemDirectMessageRoom(
  database: SqlDatabase,
  workspaceId: string,
  personId: string,
): Promise<string> {
  return (await ensureSystemDirectMessageRoomResult(database, workspaceId, personId)).id;
}

export async function ensureSystemDirectMessageRoomResult(
  database: SqlDatabase,
  workspaceId: string,
  personId: string,
): Promise<{ id: string; created: boolean }> {
    database = new CornerAccessDatabase(database);
  await ensureSystemIdentity(database);
  const participants = [SYSTEM_IDENTITY_ID, personId].sort() as [string, string];
  const roomId = directMessageRoomId(workspaceId, participants);
  const inserted = await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name,visibility,direct_participants)
     VALUES ($1,$2,$3,'Direct message','invite-only',$4::jsonb)
     ON CONFLICT(id) DO NOTHING RETURNING id`,
    [roomId, workspaceId, SYSTEM_IDENTITY_ID, JSON.stringify(participants)],
  );
  if (!inserted.rowCount) {
    await database.query(`UPDATE rooms SET visibility='invite-only' WHERE id=$1`, [roomId]);
  }
  await restoreRoomMemberships(database,workspaceId,roomId,[personId]);
  return { id: roomId, created: Boolean(inserted.rowCount) };
}

/**
 * An emitted event must cite an available cause. The emitting tool surfaces
 * this refusal without posting a fact that cannot be traced.
 */
export class EventCascadeRefusedError extends Error {
  override readonly name = 'EventCascadeRefusedError';
}

export interface SystemLineResult {
  readonly id: string;
  readonly text: string;
  readonly event: SystemEvent;
  /** False when a deterministic id already existed. */
  readonly inserted: boolean;
}

export type SystemPhrase = Pick<
  SystemLineInput,
  'subject' | 'verb' | 'object' | 'consequence' | 'attribution' | 'kind' | 'scheduleId' | 'payload' | 'subscriptionId' | 'subscriptionPrompt' | 'subscriptionWorkflowSlug'
>;

const CLEAN = /[\s ]+/g;

function clause(value: string): string {
  return value.replace(CLEAN, systemMessage("system-line.space")).trim();
}

/** The text and the structured event for one phrase; pure, so tests can pin both. */
export function composeSystemLine(phrase: SystemPhrase): { text: string; event: SystemEvent } {
  const object: SystemObject | undefined =
    phrase.object === undefined
      ? undefined
      : typeof phrase.object === 'string'
        ? { text: clause(phrase.object) }
        : { ...phrase.object, text: clause(phrase.object.text) };
  const attribution = phrase.attribution
    ? [clause(phrase.attribution.verb), clause(phrase.attribution.actor.name)]
        .filter(Boolean)
        .join(systemMessage("system-line.space"))
    : undefined;
  const consequence = phrase.consequence ? clause(phrase.consequence) : attribution || undefined;
  const event: SystemEvent = {
    subject: { ...phrase.subject, name: clause(phrase.subject.name) },
    verb: clause(phrase.verb),
    ...(object && object.text ? { object } : {}),
    ...(consequence ? { consequence } : {}),
    ...(phrase.kind ? { kind: phrase.kind } : {}),
    ...(phrase.scheduleId ? { scheduleId: phrase.scheduleId } : {}),
    ...(phrase.kind === 'subscription-fired' || phrase.kind === 'check-failed' ||
      phrase.kind === 'computer-session-activity' ? {
      payload: phrase.payload,
      ...(phrase.subscriptionId ? { subscriptionId: phrase.subscriptionId } : {}),
      ...(phrase.subscriptionPrompt ? { subscriptionPrompt: phrase.subscriptionPrompt } : {}),
      ...(phrase.subscriptionWorkflowSlug ? { subscriptionWorkflowSlug: phrase.subscriptionWorkflowSlug } : {}),
    } : {}),
  };
  // The shared formatter owns the sentence, including the compact failed-head copy.
  return { text: formatSystemLine(event), event };
}

type IdentityLabelRow = {
  id: string;
  kind: 'human' | 'agent';
  name: string;
  handle: string | null;
};

function agentHandle(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, systemMessage("system-line.handle-word-separator"))
      .replace(/[^a-z0-9_]/g, '') || systemMessage("system-line.agent")
  );
}

/** The canonical mention for an identity addressed by a system line. */
export function systemIdentityMention(row: IdentityLabelRow): string {
  if (row.kind === 'human') return row.handle ? systemMessage("system-line.identity-mention", row.handle) : '';
  return systemMessage("system-line.identity-mention", row.handle ?? agentHandle(row.name));
}

async function canonicalPhrase(
  database: SqlDatabase,
  phrase: SystemPhrase,
  plainSubjectId?: string,
  roomId?: string,
  messageId?: string,
  workspaceId?: string,
): Promise<SystemPhrase> {
  const ids = [
    phrase.subject.id,
    typeof phrase.object === 'string' ? undefined : phrase.object?.id,
    phrase.attribution?.actor.id,
  ].filter((id): id is string => Boolean(id));
  const rows = ids.length
    ? await database.query<IdentityLabelRow>(
        `SELECT id,kind,name,beeline_workspace_handle(id,COALESCE($4::uuid,(SELECT workspace_id FROM rooms WHERE id=COALESCE($2::uuid,(SELECT room_id FROM messages WHERE id=$3))))) handle FROM identities WHERE id=ANY($1::text[])`,
        [[...new Set(ids)],roomId ?? null,messageId ?? null,workspaceId ?? null],
      )
    : { rows: [] };
  const identities = new Map(rows.rows.map((row) => [row.id, row]));
  return labeledPhrase(phrase, identities, plainSubjectId);
}

function labeledPhrase(phrase: SystemPhrase, identities: ReadonlyMap<string, IdentityLabelRow>, plainSubjectId?: string): SystemPhrase {
  const subjectRow = phrase.subject.id ? identities.get(phrase.subject.id) : undefined;
  const object = typeof phrase.object === 'string' ? undefined : phrase.object;
  const objectRow = object?.id ? identities.get(object.id) : undefined;
  const attributionRow = phrase.attribution?.actor.id
    ? identities.get(phrase.attribution.actor.id)
    : undefined;
  const fallbackSubjectName =
    phrase.subject.kind === 'agent'
      ? systemMessage("system-line.identity-mention", agentHandle(phrase.subject.name))
      : phrase.subject.kind === githubProviderKey
        ? phrase.kind === 'subscription-fired' && phrase.subject.name === 'GitHub'
          ? systemMessage("system-line.github")
          : systemMessage("system-line.identity-mention", clause(phrase.subject.name).replace(/^@/, ''))
        : phrase.subject.name;
  return {
    ...phrase,
    subject: {
      ...phrase.subject,
      name:
        plainSubjectId && phrase.subject.id === plainSubjectId
          ? subjectRow?.name ?? phrase.subject.name
          : subjectRow
            ? systemIdentityMention(subjectRow)
            : fallbackSubjectName,
    },
    ...(objectRow && object && clause(object.text) === clause(objectRow.name)
      ? { object: { ...object, text: systemIdentityMention(objectRow) } }
      : {}),
    ...(phrase.attribution && attributionRow
      ? {
          attribution: {
            ...phrase.attribution,
            actor: {
              ...phrase.attribution.actor,
              name: systemIdentityMention(attributionRow),
            },
          },
        }
      : {}),
  };
}


type Cascade = { causeId: string | null; rootCauseId: string; depth: number };

/**
 * The instant a caused line must not precede: its cause's second, exhausted.
 *
 * `RoomViewMessage.createdAt` reaches the phone floored to whole seconds, and
 * every transcript sort tie-breaks on the row id — a random 64-hex string. A
 * line written microseconds after the message that provoked it shares that
 * message's second, so the tie could order the consequence ABOVE its cause.
 * The write therefore stamps `created_at` at least one second past the cause's
 * second, and only then: when `now()` has already moved on, `GREATEST` keeps
 * the natural time and the row is never future-dated by more than that one
 * second. A miss or a failed lookup writes the line unpinned — an ordering
 * courtesy must never fail a write (the caller's transaction aside).
 */
async function orderingFloor(
  database: SqlDatabase,
  roomId: string,
  causeId: string | undefined,
): Promise<Date | null> {
  if (!causeId) return null;
  try {
    const cause = await database.query<{ created_at: Date }>(
      `SELECT created_at FROM messages WHERE id=$1 AND room_id=$2`,
      [causeId, roomId],
    );
    const created = cause.rows[0]?.created_at;
    return created ? new Date(created.getTime() + 1_000) : null;
  } catch (error) {
    console.error('[system-line] ordering lookup failed', roomId, causeId, error);
    return null;
  }
}

/** Derive causal trace metadata from the committed cause, never caller-supplied bounds. */
async function resolveCascade(
  database: SqlDatabase,
  causeId: string,
): Promise<Cascade> {
  const cause = await database.query<{
    event_root_cause_id: string | null;
    event_depth: number | null;
  }>(`SELECT event_root_cause_id,event_depth FROM messages WHERE id=$1`, [causeId]);
  const row = cause.rows[0];
  if (!row) {
    throw new EventCascadeRefusedError(
      'the message that caused this turn is no longer in the chat, so this event has nothing to cite; nothing was posted',
    );
  }
  const rootCauseId = row.event_root_cause_id ?? causeId;
  const depth = (row.event_depth ?? 0) + 1;
  return { causeId, rootCauseId, depth };
}

type SystemRow = {
  id: string;
  roomId: string;
  authorId: string;
  text: string;
  presentation: NonNullable<SystemLineInput['presentation']>;
  event?: SystemEvent;
  cardType?: string;
  card?: Record<string, unknown>;
  requestId?: string;
  durableFact?: SystemLineInput['durableFact'];
  cascade?: Cascade;
  notBefore?: Date | null;
  replyToMessageId?: string;
};

type SystemRowUpdate = {
  id: string;
  text?: string;
  event?: SystemEvent;
  eventKind?: SystemEventKind;
  deletedAt?: Date;
  deletedBy?: string;
  card?: Record<string, unknown>;
  presentation?: SystemLineInput['presentation'];
  createdAt?: Date;
  authorId?: string;
  clearCard?: boolean;
  transcript?: SystemTranscript;
  durableFact?: SystemLineInput['durableFact'];
};

type SystemLineOperation =
  | { operation: 'insert'; rows: readonly SystemRow[] }
  | { operation: 'update'; rows: readonly SystemRowUpdate[] };

async function persistSystemRows(database: SqlDatabase, input: SystemLineOperation): Promise<Set<string>> {
  if (!input.rows.length) return new Set();
  if (input.operation === 'update') {
    const result = await database.query<{ id: string }>(
      `UPDATE messages message SET
        text=CASE WHEN line."deletedBy" IS NOT NULL THEN '' ELSE COALESCE(line.text,message.text) END,
        attachments=CASE WHEN line."deletedBy" IS NOT NULL THEN '[]'::jsonb ELSE message.attachments END,
        reactions=CASE WHEN line."deletedBy" IS NOT NULL THEN '{}'::jsonb ELSE message.reactions END,
        system_event=CASE WHEN line."eventKind" IS NOT NULL
          THEN message.system_event || jsonb_build_object('kind',line."eventKind")
          ELSE COALESCE(line.event,message.system_event) END,
        deleted_at=COALESCE(message.deleted_at,line."deletedAt",CASE WHEN line."deletedBy" IS NOT NULL THEN now() END),
        deleted_by=COALESCE(message.deleted_by,line."deletedBy"),
        card=CASE WHEN line."clearCard" THEN NULL ELSE COALESCE(line.card,message.card) END,
        card_type=CASE WHEN line."clearCard" THEN NULL ELSE message.card_type END,
        author_id=COALESCE(line."authorId",message.author_id),
        presentation=COALESCE(line.presentation,message.presentation),
        created_at=COALESCE(line."createdAt",message.created_at),
        system_transcript=COALESCE(line.transcript,message.system_transcript),
        durable_fact=COALESCE(line."durableFact",message.durable_fact)
       FROM jsonb_to_recordset($1::jsonb) AS line(id text,text text,event jsonb,card jsonb,
         "eventKind" text,"deletedAt" timestamptz,"deletedBy" text,"clearCard" boolean,"authorId" text,
         presentation text,"createdAt" timestamptz,transcript jsonb,"durableFact" text)
       WHERE message.id=line.id RETURNING message.id`,
      [JSON.stringify(input.rows)],
    );
    return new Set(result.rows.map(row => row.id));
  }

  const rows = input.rows.map(row => ({
    ...row,
    causeId: row.cascade?.causeId,
    rootCauseId: row.cascade?.rootCauseId,
    depth: row.cascade?.depth,
    transcript: systemTranscript(row.authorId, row.presentation, row.cardType, row.event, row.durableFact),
  }));
  const result = await database.query<{ id: string }>(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,request_id,durable_fact,
       card_type,card,system_event,system_transcript,event_cause_id,event_root_cause_id,event_depth,
       created_at,reply_to_message_id)
     SELECT id,"roomId","authorId",text,presentation,"requestId","durableFact",
       "cardType",card,event,transcript,"causeId","rootCauseId",depth,
       GREATEST(now(),COALESCE("notBefore",now())),"replyToMessageId"
     FROM jsonb_to_recordset($1::jsonb) AS line(id text,"roomId" uuid,"authorId" text,text text,
       presentation text,"requestId" text,"durableFact" text,"cardType" text,card jsonb,event jsonb,
       transcript jsonb,"causeId" text,"rootCauseId" text,depth integer,"notBefore" timestamptz,"replyToMessageId" text)
     ON CONFLICT DO NOTHING RETURNING id`,
    [JSON.stringify(rows)],
  );
  return new Set(result.rows.map(row => row.id));
}

/** Write system-origin records, including batches and in-place transitions. */
export function systemLine(database: SqlDatabase, input: SystemLineInput): Promise<SystemLineResult>;
export function systemLine(database: SqlDatabase, input: SystemLineOperation): Promise<Set<string>>;
export async function systemLine(
  database: SqlDatabase,
  input: SystemLineInput | SystemLineOperation,
): Promise<SystemLineResult | Set<string>> {
  if ('operation' in input) return persistSystemRows(database, input);
  database = new CornerAccessDatabase(database);
  const authorId = input.authorId ?? input.subject.id;
  if (!authorId) throw new Error('system line needs an author identity');
  // Workflow cards name their own author without a self-address.
  const { text, event } = composeSystemLine(
    await canonicalPhrase(
      database,
      input,
      input.cardType === 'workflow-handoff' ? authorId : undefined,
      input.roomId,
    ),
  );
  const id = input.id ?? randomBytes(32).toString('hex');
  let subscriptions: Awaited<ReturnType<typeof roomEventSubscriptions>> = [];
  const passive = ['corner-opened', 'opened', 'merged', 'closed', 'reopened'].includes(input.kind ?? '');
  let wakes = passive ? [] : [...new Set(input.wakes ?? [])];
  // Only an event carries a cascade. A line with no kind is one nothing reacts
  // to, so it has no causal trace.
  const write = async (
    db: SqlDatabase,
    cascade: Cascade | undefined,
    notBefore: Date | null,
  ) => {
    const inserted = (await persistSystemRows(db, { operation: 'insert', rows: [{
      id, roomId: input.roomId, authorId, text, event,
      presentation: input.presentation ?? 'system',
      requestId: input.requestId,
      durableFact: input.durableFact,
      cardType: input.cardType,
      card: input.card ? { ...input.card, ask: approvalAsk(input.cardType, input.card) } : undefined,
      cascade, notBefore, replyToMessageId: input.replyToMessageId,
    }] })).has(id);
    if (inserted) {
      // Preserve message-before-subscription lock order. One capture chooses each
      // subscription's mode, so a prompt edit cannot dispatch twice on two cuts.
      if (!passive && input.kind && isSubscribableEventKind(input.kind)) {
        await db.query('SAVEPOINT room_event_recipients');
        try {
          subscriptions = await roomEventSubscriptions(db, input.roomId, input.kind, true);
        } catch (error) {
          // Preserve the fact and explicit targets even after a failed SQL lookup.
          await db.query('ROLLBACK TO SAVEPOINT room_event_recipients');
          console.error('[system-line] subscriber lookup failed', input.roomId, input.kind, error);
        }
        await db.query('RELEASE SAVEPOINT room_event_recipients');
        wakes = [...new Set([...wakes, ...subscriptions
          .filter(row => row.prompt === null).map(row => row.agent_id)])];
      }

      if (!passive && input.routeCommands !== false) await routeSystemCommand(db, {
        roomId: input.roomId,
        sourceMessageId: id,
        kind: input.kind,
        targets: wakes,
        assignmentTargets: input.kind === 'workflow-handoff' ? input.wakes : undefined,
        requestId: input.requestId,
        causeId: input.causeId,
        commandId: input.commandId,
      });
      if (input.kind && isSubscribableEventKind(input.kind) && subscriptions.some(row => row.prompt !== null)) {
        for (const subscription of subscriptions.filter(row => row.prompt !== null)) {
          if (input.kind === 'corner-opened' && subscription.agent_id === input.subject.id) continue;
          const firedId = createHash('sha256').update(`room-subscription:${id}:${subscription.id}`).digest('hex');
          const fired = await systemLine(db, {
            id: firedId, roomId: input.roomId, authorId: SYSTEM_IDENTITY_ID,
            subject: { kind: 'system', id: SYSTEM_IDENTITY_ID, name: systemMessage("system-line.beeline") },
            verb: systemMessage("system-line.received"), object: systemMessage("system-line.a-room-event"), consequence: input.kind,
            kind: 'subscription-fired', causeId: id, wakes: [subscription.agent_id],
            payload: { source: 'room', event: input.kind, text },
            subscriptionId: subscription.id,
            subscriptionPrompt: subscription.prompt!,
            subscriptionWorkflowSlug: subscription.workflow_slug ?? undefined,
          });
          if (fired.inserted) await db.query(`UPDATE agent_subscriptions
            SET last_fired_at=now(),fired_count=fired_count+1 WHERE id=$1`, [subscription.id]);
        }
      }
    }
    return { id, text, event, inserted };
  };
  return database.transaction(async (tx) => {
    const cascade = !input.kind
      ? undefined
      : input.causeId === undefined
        ? { causeId: null, rootCauseId: id, depth: 0 }
        : await resolveCascade(tx, input.causeId);
    const notBefore = await orderingFloor(
      tx,
      input.roomId,
      input.kind ? input.causeId : input.afterMessageId,
    );
    return write(tx, cascade, notBefore);
  });
}

/**
 * The same unkinded line in each of a Workspace's Rooms, as one statement.
 * Nothing subscribes to a line with no kind and it wakes no one, so each Room
 * keeps its own row without a label read and an insert per Room.
 */
export async function systemLineInRooms(
  database: SqlDatabase,
  workspaceId: string,
  roomIds: readonly string[],
  input: Pick<SystemLineInput, 'subject' | 'verb' | 'object' | 'consequence' | 'cardType' | 'card'>,
): Promise<void> {
  if (!roomIds.length) return;
  const authorId = input.subject.id;
  if (!authorId) throw new Error('system line needs an author identity');
  const { text, event } = composeSystemLine(
    await canonicalPhrase(database, input, undefined, undefined, undefined, workspaceId),
  );
  const card = input.card ? { ...input.card, ask: approvalAsk(input.cardType, input.card) } : undefined;
  await systemLine(database, { operation: 'insert', rows: roomIds.map((roomId): SystemRow => ({
    id: randomBytes(32).toString('hex'), roomId, authorId, text, event,
    presentation: 'system', cardType: input.cardType, card,
  })) });
}

/** One committed batch of per-offer answers, with the same grammar and resume
 * owner as individual system lines. Per-item decisions have no subscribers. */
export async function connectorOfferDecisionLines(database: SqlDatabase,
  inputs: readonly (SystemLineInput & { kind: 'connector-offer-decided' })[]): Promise<void> {
  if (!inputs.length) return;
  const ids = [...new Set(inputs.flatMap(input => [input.subject.id,
    typeof input.object === 'string' ? undefined : input.object?.id, input.attribution?.actor.id])
    .filter((id): id is string => Boolean(id)))];
  const labels = (await database.query<IdentityLabelRow & {room_id:string}>(
    `SELECT identity.id,kind,name,beeline_room_handle(identity.id,place.room_id) handle,place.room_id
     FROM identities identity CROSS JOIN unnest($2::uuid[]) place(room_id) WHERE identity.id=ANY($1::text[])`,
    [ids,[...new Set(inputs.map(input => input.roomId))]])).rows;
  const lines = new Map<string, SystemRow & { wakes: string[]; commandId?: string; event: SystemEvent }>();
  for (const input of inputs) {
    const id = input.id ?? randomBytes(32).toString('hex');
    if (lines.has(id)) continue;
    const authorId = input.authorId ?? input.subject.id;
    if (!authorId) throw new Error('system line needs an author identity');
    const identities = new Map(labels.filter(row => row.room_id === input.roomId).map(row => [row.id, row]));
    lines.set(id, {
      id, roomId: input.roomId, authorId, ...composeSystemLine(labeledPhrase(input, identities)),
      presentation: 'system', cardType: input.cardType,
      card: input.card ? { ...input.card, ask: approvalAsk(input.cardType, input.card) } : undefined,
      cascade: { causeId: null, rootCauseId: id, depth: 0 },
      wakes: [...new Set(input.wakes ?? [])], commandId: input.commandId, requestId: input.requestId,
    });
  }
  const winners = await systemLine(database, { operation: 'insert', rows: [...lines.values()] });
  for (const line of lines.values()) {
    if (!winners.has(line.id) || !line.wakes.length) continue;
    await routeSystemCommand(database,{
      roomId:line.roomId,sourceMessageId:line.id,kind:line.event.kind,targets:line.wakes,
      ...(line.commandId ? {commandId:line.commandId} : {}),...(line.requestId ? {requestId:line.requestId} : {}),
    });
  }
}

/**
 * Restate an existing line in place (a retried failure, a settled failure, a
 * grant card that gained another ask). The row keeps its id, so a push claimed
 * on it never fires twice.
 */
type SystemLineChanges = Pick<SystemRowUpdate, 'presentation' | 'createdAt' | 'durableFact'>;

export async function restateSystemLine(
  database: SqlDatabase,
  messageId: string,
  phrase: SystemPhrase,
  card?: Record<string, unknown>,
  changes: SystemLineChanges = {},
): Promise<{ text: string; event: SystemEvent; updated: boolean }> {
  const { text, event } = composeSystemLine(await canonicalPhrase(database, phrase, undefined, undefined, messageId));
  const updated = await systemLine(database, { operation: 'update', rows: [{
    id: messageId, text, event, card, ...changes,
    ...(changes.presentation ? { transcript: systemTranscript(phrase.subject.id ?? SYSTEM_IDENTITY_ID, changes.presentation, undefined, event) } : {}),
  }] });
  return { text, event, updated: updated.has(messageId) };
}

/** Restate committed facts as one batch, without query loops under their rows. */
export async function restateSystemLines(database: SqlDatabase, lines: readonly ({
  id: string; phrase: SystemPhrase; card?: Record<string, unknown>;
} & SystemLineChanges)[]): Promise<void> {
  if (!lines.length) return;
  const ids = [...new Set(lines.flatMap(({ phrase }) => [phrase.subject.id,
    typeof phrase.object === 'string' ? undefined : phrase.object?.id, phrase.attribution?.actor.id]
    .filter((id): id is string => Boolean(id))))];
  const labels = ids.length ? (await database.query<IdentityLabelRow & { message_id: string }>(
    `SELECT identity.id,kind,name,beeline_room_handle(identity.id,message.room_id) handle,message.id message_id
     FROM messages message CROSS JOIN identities identity
     WHERE identity.id=ANY($1::text[]) AND message.id=ANY($2::text[])`, [ids, lines.map(line => line.id)])).rows : [];
  const rows = lines.map(({ phrase, ...line }) => {
    const identities = new Map(labels.filter(row => row.message_id === line.id).map(row => [row.id, row]));
    const composed = composeSystemLine(labeledPhrase(phrase, identities));
    return {
      ...line, ...composed,
      ...(line.presentation ? { transcript: systemTranscript(phrase.subject.id ?? SYSTEM_IDENTITY_ID, line.presentation, undefined, composed.event) } : {}),
    };
  });
  await systemLine(database, { operation: 'update', rows });
}

/** Replace an actionable card with its completion line, retaining its id. */
export async function settleSystemCard(
  database: SqlDatabase,
  messageId: string,
  phrase: SystemPhrase & { readonly authorId: string },
): Promise<{ id: string; text: string; event: SystemEvent }> {
  const { text, event } = composeSystemLine(await canonicalPhrase(database, phrase, undefined, undefined, messageId));
  await systemLine(database, { operation: 'update', rows: [{
    id: messageId, text, event, authorId: phrase.authorId, presentation: 'system', clearCard: true,
    transcript: systemTranscript(phrase.authorId, 'system', undefined, event),
  }] });
  return { id: messageId, text, event };
}

/** Erase a member message and leave its tombstone in the same write. The caller locks the authorized row. */
export async function tombstoneSystemLine(
  database: SqlDatabase,
  messageId: string,
  deleterId: string,
  authorId: string,
  roomId: string,
): Promise<void> {
  const rows = await database.query<IdentityLabelRow>(
    `SELECT id,kind,name,beeline_room_handle(id,$2) handle FROM identities WHERE id=ANY($1::text[])`,
    [[...new Set([deleterId, authorId])], roomId],
  );
  const identities = new Map(rows.rows.map(row => [row.id, row]));
  const deleter = identities.get(deleterId);
  const author = identities.get(authorId);
  if (!deleter || !author) throw new Error('deleted message identities are missing');
  const { event } = composeSystemLine(await canonicalPhrase(database, {
    subject: identitySubject(deleter),
    verb: systemMessage("system-line.deleted"),
    object: systemMessage("system-line.a-message"),
    ...(authorId === deleterId ? {} : { attribution: { verb: 'sent by', actor: identitySubject(author) } }),
  }, undefined, roomId));
  await systemLine(database, { operation: 'update', rows: [{
    id: messageId, event, deletedBy: deleterId, transcript: { origin: 'system', visibility: 'notice' },
  }] });
}

/** The subject shape for a Room identity row. */
export function identitySubject(row: {
  id: string;
  kind: 'human' | 'agent';
  name: string;
}): SystemSubject {
  return { kind: row.kind === 'agent' ? 'agent' : 'person', id: row.id, name: row.name };
}

export const GITHUB_SUBJECT: SystemSubject = { kind: githubProviderKey, name: systemMessage("system-line.github") };

/** A plain operator notice in the recipient's existing System thread. */
export async function sendSystemDirectMessage(database: SqlDatabase, workspaceId: string, recipientId: string,
  text: string, id: string): Promise<boolean> {
  const member = await database.query(`SELECT 1 FROM memberships WHERE workspace_id=$1 AND identity_id=$2
    AND room_id IS NULL AND removed_at IS NULL`, [workspaceId, recipientId]);
  if (!member.rowCount) throw new Error('System DM recipient has no active Workspace');
  const roomId = await ensureSystemDirectMessageRoom(database, workspaceId, recipientId);
  const inserted = await systemLine(database, { operation: 'insert', rows: [{
    id, roomId, authorId: SYSTEM_IDENTITY_ID, text, presentation: 'system',
  }] });
  return inserted.has(id);
}
