import { type ViewerMessage } from '@/buzz/viewer-conversation';
import { type AgentPresentation, type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { buildTurnActivity } from '@/buzz/activity-timeline';
import { CHANNEL_MENTION_HANDLE, CHANNEL_MENTION_PUBKEY, SYSTEM_MENTION_HANDLE, SYSTEM_MENTION_PUBKEY } from '@/buzz/room-participants';
import { type MessageReplyTarget } from '@/buzz/message-reply';
import type { RoomMessagePresentation } from '@/buzz/room-message-cell';
import { type RoomRosterParticipant } from '@/buzz/room-participants';
import { COMPOSER_MAX_INPUT_HEIGHT, COMPOSER_SINGLE_LINE_INPUT_HEIGHT } from '@/components/buzz/ConversationComposer';



export type RoomMemberOption = RoomRosterParticipant;

export type MessageShortcut = {
  text: string;
  replyTarget?: MessageReplyTarget;
  viewer?: Omit<ViewerMessage, 'text'>;
};

export const NO_SELECTED_MENTIONS: ReadonlyMap<string, string> = new Map();

/**
 * The reserved `@channel` autocomplete row: tags every human in the Room (the
 * parent Room, for a corner) except the author, never an agent. It is not a
 * roster member — `CHANNEL_MENTION_PUBKEY` is a sentinel, never a real
 * identity — so it rides alongside `roomParticipants` only inside the
 * mention menu's own candidate list.
 */
export const CHANNEL_MENTION_OPTION: RoomMemberOption = {
  pubkey: CHANNEL_MENTION_PUBKEY,
  name: 'channel',
  handle: CHANNEL_MENTION_HANDLE,
  kind: 'person',
};


/**
 * The reserved `@system` autocomplete row: the feedback loop's report token,
 * offered in every Room, corner and DM. Picking it inserts `@system ` like any
 * mention, but System is never a member, so `SYSTEM_MENTION_PUBKEY` is a
 * sentinel that never reaches a send's mention list.
 */
export const SYSTEM_MENTION_OPTION: RoomMemberOption = {
  pubkey: SYSTEM_MENTION_PUBKEY,
  name: 'System',
  handle: SYSTEM_MENTION_HANDLE,
  kind: 'person',
};


export const COMPOSER_MIN_HEIGHT = COMPOSER_SINGLE_LINE_INPUT_HEIGHT;

export const COMPOSER_MAX_HEIGHT = COMPOSER_MAX_INPUT_HEIGHT;

// How close to the visual bottom counts as "already reading the newest end"
// for the layout-change tail snap (C97): offset 0 when native is inverted,
// or content height minus viewport height on the ordinary desktop list.
export const TAIL_PIN_THRESHOLD = 50;

// Keep earlier phone rows in the initial, retained FlatList window. Two
// short rows can leave earlier messages blank while arrivals move the batched
// window. Source landings also use this immediately available row budget.
export const PHONE_FIRST_RENDER_ROWS = 10;

// Open on the tail of a long transcript instead of the full history, then
// page older messages in as the reader scrolls up.
export const INITIAL_MESSAGE_WINDOW = 30;

// A corner's opening/progress prose is its audit trail. The cold tail already
// reads this many records; reveal that complete bounded page when its parent
// relation resolves instead of silently starting a reader 30 rows mid-story.
export const INITIAL_CORNER_MESSAGE_WINDOW = 200;


/**
 * The voice a transcript entry belongs to, or `null` for anything that is not
 * one, is decided by THE shared projection helper (`buzz/ledger-attribution.ts`
 * — Rooms and corners alike). This screen only supplies its roster union:
 * registered agents from the server-indexed roster.
 */
export const knownAgentPubkeysFor = (agentByPubkey: Map<string, unknown>): Set<string> =>
  new Set(agentByPubkey.keys());


/** The agent object this row paints. Presentation fields win over the map. */
export function rosterAgent(
  pubkey: string | undefined,
  presentation: Pick<
    RoomMessagePresentation,
    'agentPubkey' | 'agentName' | 'agentAvatar' | 'agentFace' | 'agentHandle'
  >,
  agents: ReadonlyMap<string, AgentPresentation>,
): AgentPresentation | undefined {
  if (!pubkey) return undefined;
  const fromMap = agents.get(pubkey);
  if (presentation.agentPubkey !== pubkey) return fromMap;
  if (
    presentation.agentName === undefined &&
    presentation.agentAvatar === undefined &&
    presentation.agentFace === undefined &&
    presentation.agentHandle === undefined
  ) {
    return fromMap;
  }
  const avatar = presentation.agentAvatar ?? fromMap?.avatar;
  const face = presentation.agentFace ?? fromMap?.face;
  const handle = presentation.agentHandle ?? fromMap?.handle;
  return {
    pubkey,
    displayName: presentation.agentName ?? fromMap?.displayName ?? '',
    ...(avatar ? { avatar } : {}),
    ...(face ? { face } : {}),
    ...(handle ? { handle } : {}),
    ...(fromMap?.soulProfile ? { soulProfile: fromMap.soulProfile } : {}),
  };
}


export function durableFactLine(message: ChatDisplayMessage): string {
  const turn = buildTurnActivity(message.activity ?? []);
  const step =
    message.durableFact?.kind === 'failure'
      ? [...turn.steps].reverse().find((candidate) => candidate.outcome === 'failure')
      : turn.steps.at(-1);
  const glyph = message.durableFact?.kind === 'failure' ? '✗' : '✓';
  const label = step?.label ?? (message.durableFact?.kind === 'merge' ? 'change merged' : 'action');
  return `${glyph} ${label}${step?.reason ? ` · ${step.reason}` : ''}`;
}
