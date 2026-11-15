import { readIdentity } from './phone-guards.js';
import type { NeedsYouItemView, RoomViewIdentity } from './phone-types.js';

export const WORK_STATES = ['needs-you', 'in-progress', 'in-review', 'backlog', 'done'] as const;
export type WorkState = (typeof WORK_STATES)[number];
export const WORK_PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;
export type WorkPriority = (typeof WORK_PRIORITIES)[number];
export type WorkAbout =
  | { readonly kind: 'thread'; readonly roomId: string }
  | { readonly kind: 'pr'; readonly roomId: string }
  | { readonly kind: 'request'; readonly roomId: string; readonly messageId: string };
export type WorkItemView = {
  readonly id: string;
  readonly roomId: string;
  readonly roomKind?: NeedsYouItemView['roomKind'];
  readonly chatId: string;
  readonly chatName: string;
  readonly title: string;
  readonly threadName: string;
  readonly state: WorkState;
  readonly priority: WorkPriority;
  readonly assignee: RoomViewIdentity | null;
  readonly openedBy: RoomViewIdentity;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageId?: string;
  readonly ask?: NeedsYouItemView;
  readonly recommendedOptionId?: string;
};
export type WorkBoardView = {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly viewerId: string;
  readonly items: readonly WorkItemView[];
  readonly chats: readonly { readonly id: string; readonly name: string }[];
  readonly people: readonly RoomViewIdentity[];
};
export type UpdateWorkItemInput = {
  readonly id?: string;
  readonly roomId: string;
  readonly title?: string;
  readonly state?: WorkState;
  readonly priority?: WorkPriority;
  readonly assigneeId?: string | null;
};
export type AskOwnerQuestionInput = {
  readonly about: WorkAbout;
  readonly question: string;
  readonly options?: readonly { readonly label: string; readonly recommended?: boolean }[];
  readonly freeText?: boolean;
};

/** Same word grammar in the advertised schema and the server. */
export const WORK_QUESTION_PATTERN = '^\\S+(?:[ \t]+\\S+){0,19}$';
export const WORK_OPTION_PATTERN = '^\\S+(?:[ \t]+\\S+){0,2}$';
export function validateWorkQuestion(input: AskOwnerQuestionInput): void {
  const short = (value: unknown, words: number) =>
    typeof value === 'string' &&
    !!value.trim() &&
    !/[\r\n]/.test(value) &&
    value.trim().split(/\s+/).length <= words;
  if (!short(input.question, 20))
    throw new Error('Shorten question to 20 words or fewer on one line.');
  if (
    input.options &&
    (input.options.length < 2 ||
      input.options.length > 4 ||
      input.options.some((option) => !short(option.label, 3)))
  )
    throw new Error('Shorten options to 2–4 labels of 3 words or fewer.');
  if (input.options?.filter((option) => option.recommended).length! > 1)
    throw new Error('Choose one recommended option.');
  if (Boolean(input.options) === (input.freeText === true))
    throw new Error('Use options or freeText.');
}

/** Optional thread metadata survives the same validated Room projection as messages. */
export function readWorkItem(value: unknown): WorkItemView | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const openedBy = readIdentity(v.openedBy),
    assignee = v.assignee === null ? null : readIdentity(v.assignee);
  if (
    !openedBy ||
    (v.assignee !== null && !assignee) ||
    !['id', 'roomId', 'chatId', 'chatName', 'title', 'threadName'].every(
      (key) => typeof v[key] === 'string',
    ) ||
    !WORK_STATES.includes(v.state as WorkState) ||
    !WORK_PRIORITIES.includes(v.priority as WorkPriority) ||
    typeof v.createdAt !== 'number' ||
    typeof v.updatedAt !== 'number'
  )
    return undefined;
  return {
    id: v.id as string,
    roomId: v.roomId as string,
    ...(['direct', 'room', 'corner'].includes(v.roomKind as string)
      ? { roomKind: v.roomKind as NeedsYouItemView['roomKind'] }
      : {}),
    chatId: v.chatId as string,
    chatName: v.chatName as string,
    title: v.title as string,
    threadName: v.threadName as string,
    state: v.state as WorkState,
    priority: v.priority as WorkPriority,
    openedBy,
    assignee,
    ...(typeof v.messageId === 'string' ? { messageId: v.messageId } : {}),
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}
