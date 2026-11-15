import { readIdentity } from './phone-guards.js';
import type { AttachmentReference, NeedsYouItemView, RoomViewIdentity } from './phone-types.js';

export const WORK_STATES = ['needs-you', 'in-progress', 'in-review', 'backlog', 'done'] as const;
export type WorkState = (typeof WORK_STATES)[number];
export type WorkAbout =
  | { readonly kind: 'thread'; readonly roomId: string }
  | { readonly kind: 'pr'; readonly roomId: string }
  | { readonly kind: 'request'; readonly roomId: string; readonly messageId: string };
export type WorkItemAddress = { readonly roomId: string; readonly id?: string };
export type WorkAttachmentInput =
  | { readonly kind: 'link'; readonly name: string; readonly url: string }
  | { readonly kind: 'file'; readonly name: string; readonly objectId: string };
export type AddWorkNoteInput = WorkItemAddress & { readonly text: string };
export type AttachToWorkItemInput = WorkItemAddress & { readonly attachment: WorkAttachmentInput };
export type WorkItemEntry = {
  readonly id: string;
  readonly author: RoomViewIdentity;
  readonly kind: 'note' | 'event';
  readonly text: string;
  readonly createdAt: number;
};
export type WorkItemAttachment = {
  readonly id: string;
  readonly addedBy: RoomViewIdentity;
  readonly createdAt: number;
} & (
  | { readonly kind: 'link'; readonly name: string; readonly url: string }
  | { readonly kind: 'file'; readonly name: string; readonly file: AttachmentReference }
);
export type WorkItemView = {
  readonly id: string;
  readonly roomId: string;
  readonly roomKind?: NeedsYouItemView['roomKind'];
  readonly chatId: string;
  readonly chatName: string;
  readonly title: string;
  readonly threadName: string;
  readonly state: WorkState;
  /** Retired. Always 'none': the previous app still requires the field. */
  readonly priority?: 'none';
  /** An open thread with nothing running: In progress, drawn as a hollow ring after active work. */
  readonly idle?: true;
  /** The latest brief objective, else the opening order or the item's own objective. */
  readonly objective?: string;
  readonly assignee: RoomViewIdentity | null;
  readonly openedBy: RoomViewIdentity;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageId?: string;
  /** Bounded recent detail, in chronological order. */
  readonly entries?: readonly WorkItemEntry[];
  readonly attachments?: readonly WorkItemAttachment[];
  readonly ask?: NeedsYouItemView;
  /** Every ask waiting in this thread, oldest first; `ask` is the first. Clearing the row clears all. */
  readonly askIds?: readonly string[];
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
  readonly objective?: string;
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
    ...(v.idle === true ? { idle: true as const } : {}),
    ...(typeof v.objective === 'string' && v.objective ? { objective: v.objective } : {}),
    ...(Array.isArray(v.entries) ? { entries: v.entries.flatMap(readWorkEntry) } : {}),
    ...(Array.isArray(v.attachments)
      ? { attachments: v.attachments.flatMap(readWorkAttachment) }
      : {}),
    openedBy,
    assignee,
    ...(typeof v.messageId === 'string' ? { messageId: v.messageId } : {}),
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

function readWorkEntry(value: unknown): WorkItemEntry[] {
  if (!value || typeof value !== 'object') return [];
  const v = value as Record<string, unknown>;
  const author = readIdentity(v.author);
  return author &&
    typeof v.id === 'string' &&
    (v.kind === 'note' || v.kind === 'event') &&
    typeof v.text === 'string' &&
    typeof v.createdAt === 'number'
    ? [{ id: v.id, author, kind: v.kind, text: v.text, createdAt: v.createdAt }]
    : [];
}
function readWorkAttachment(value: unknown): WorkItemAttachment[] {
  if (!value || typeof value !== 'object') return [];
  const v = value as Record<string, unknown>;
  const addedBy = readIdentity(v.addedBy);
  if (
    !addedBy ||
    typeof v.id !== 'string' ||
    typeof v.name !== 'string' ||
    typeof v.createdAt !== 'number'
  )
    return [];
  const base = { id: v.id, name: v.name, addedBy, createdAt: v.createdAt };
  if (v.kind === 'link' && typeof v.url === 'string' && /^https?:\/\//i.test(v.url))
    return [{ ...base, kind: 'link', url: v.url }];
  if (v.kind !== 'file' || !v.file || typeof v.file !== 'object') return [];
  const f = v.file as Record<string, unknown>;
  if (typeof f.url !== 'string' || typeof f.mimeType !== 'string' || typeof f.size !== 'number')
    return [];
  return [
    {
      ...base,
      kind: 'file',
      file: {
        url: f.url,
        name: v.name,
        mimeType: f.mimeType,
        size: f.size,
        ...(typeof f.sha256 === 'string' ? { sha256: f.sha256 } : {}),
        ...(f.expired === true ? { expired: true } : {}),
      },
    },
  ];
}
