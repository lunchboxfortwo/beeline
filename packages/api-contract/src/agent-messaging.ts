/** An identity in one place. The same agent in two places has two addresses. */
export type MessageAddress = { readonly agent: string; readonly place: string };
/** Existing immutable operator owner; shared so delivery can select its tool set. */
export const OPERATOR_OWNER_ID = '34cf4160723acd12d205dfbe292614bfec9489b78812d1cd9846c00346903334';
export type MessageAsk = {
  readonly question: string;
  readonly options: readonly string[];
  readonly recommended?: string;
};
export type MessageRoute = {
  readonly from: MessageAddress;
  readonly to: MessageAddress;
};

export const MESSAGE_ADDRESS_SCHEMA = {
  type: 'object', required: ['agent', 'place'], additionalProperties: false,
  properties: {
    agent: { type: 'string', description: 'Identity id or handle; implementer or reviewer selects that role at a thread.' },
    place: { type: 'string', description: 'Chat, DM or thread id from read.' },
  },
} as const;
export const MESSAGE_ASK_SCHEMA = {
  type: 'object', required: ['question', 'options'], additionalProperties: false,
  properties: {
    question: { type: 'string', minLength: 1, pattern: '^\\S+(?:[ \\t]+\\S+)*$', description: 'A clear question addressed to the person. Put the surrounding context in the message text.' },
    options: { type: 'array', minItems: 2, maxItems: 4,
      items: { type: 'string', pattern: '^\\S+(?:[ \\t]+\\S+){0,2}$' } },
    recommended: { type: 'string', description: 'One of the option labels.' },
  },
} as const;

/** Replies without a question are information, not another request. */
export function isInformationalReply(reason: string | null | undefined, ask: unknown): boolean {
  return reason === 'reply' && !ask;
}

/** A person's tag or message and an agent's message() are requests; a resumed turn still owes its request's answer. */
export const REQUEST_REASONS: readonly string[] = ['human_tag', 'direct_message', 'human_message', 'agent_tag',
  'message', 'order', 'voice_order', 'corner_objective', 'resume'];

/** Requests, and replies carrying an ask, need a reply; everything else is information. */
export function replyNeeded(reason: string | null | undefined, ask: unknown): boolean {
  return REQUEST_REASONS.includes(reason ?? '') || (reason === 'reply' && Boolean(ask));
}

/** The one message format every agent surface shows. */
export function agentMessageText(message: {
  readonly from: string; readonly place: string; readonly id: string; readonly replyNeeded: boolean;
  readonly text: string; readonly attachments?: readonly string[];
}): string {
  return [`From: ${message.from} in #${message.place}`, `id: ${message.id}`, `Reply needed: ${message.replyNeeded}`,
    `text: ${message.text}`, ...(message.attachments?.length ? [`attachment: ${message.attachments.join(', ')}`] : []),
    ...(message.replyNeeded ? [`Reply(id: ${message.id}, text: ...) with your reply`] : [])].join('\n');
}

/** The plain shortening error is shared by the tool validator and server. */
export function validateMessageAsk(ask: MessageAsk): void {
  const short = (text: unknown, words: number) => typeof text === 'string' &&
    new RegExp(`^\\S+(?:[ \\t]+\\S+){0,${words - 1}}$`).test(text);
  if (!Array.isArray(ask.options) || ask.options.length < 2 || ask.options.length > 4 ||
      ask.options.some(option => !short(option, 3)))
    throw new Error('Shorten options to 2–4 labels of 3 words or fewer.');
}
