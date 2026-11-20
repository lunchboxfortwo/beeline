/** An identity in one place. The same agent in two places has two addresses. */
export type MessageAddress = { readonly agent: string; readonly place: string };
/** Existing immutable operator owner; shared so delivery can select its tool set. */
export const OPERATOR_OWNER_ID = '34cf4160723acd12d205dfbe292614bfec9489b78812d1cd9846c00346903334';
export type MessageDigest = { readonly question?: string; readonly brief?: string };
export type MessageAsk = {
  readonly question: string;
  /** Why it matters and what each option means; the card shows it under the question. Older helpers omit it. */
  readonly brief?: string;
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
/** A Needs you card shows only question, brief and option buttons; longer asks are refused, never truncated. */
export const ASK_QUESTION_MAX_CHARACTERS = 120;
export const ASK_BRIEF_MAX_CHARACTERS = 280;
/** The limits every tool that writes an ask states up front. */
const ASK_LIMITS_TEXT = `Character limits: question at most ${ASK_QUESTION_MAX_CHARACTERS} characters, brief at most ${ASK_BRIEF_MAX_CHARACTERS} characters, both counted in characters; an ask over either limit is refused with its counts, so rewrite it shorter.`;
/** The ask sentence for every message/reply tool description, before anything else about the tool. */
export const ASK_TOOL_TEXT = `Add ask only when a person must decide: their Needs you card shows only ask.question, ask.brief and the option buttons, with your full text one tap away. ${ASK_LIMITS_TEXT} Use 2–4 option labels of at most 3 words. For blocked:/needs-decision: reports, supply top-level question, brief and options (2–4 labels of at most 3 words), or use ask; both create the same decision buttons and enforce the same limits and refusals. Omit digest fields for a legacy report.`;
export const MESSAGE_ASK_SCHEMA = {
  type: 'object', required: ['question', 'options'], additionalProperties: false,
  description: `The person's Needs you card shows only question, brief and the option buttons; the full message text is one tap away. ${ASK_LIMITS_TEXT}`,
  properties: {
    question: { type: 'string', minLength: 1, pattern: '^\\S+(?:[ \\t]+\\S+)*$', description: `At most ${ASK_QUESTION_MAX_CHARACTERS} characters: one line ending with ?, the one decision the buttons answer.` },
    brief: { type: 'string', minLength: 1, description: `At most ${ASK_BRIEF_MAX_CHARACTERS} characters and at most 2 sentences: why it matters and what each option means. Plain text.` },
    options: { type: 'array', minItems: 2, maxItems: 4,
      items: { type: 'string', pattern: '^\\S+(?:[ \\t]+\\S+){0,2}$' } },
    recommended: { type: 'string', description: 'One of the option labels.' },
  },
} as const;

export const REPORT_DIGEST_PROPERTIES = {
  options: MESSAGE_ASK_SCHEMA.properties.options,
  question: { type: 'string', description: `Report question: at most ${ASK_QUESTION_MAX_CHARACTERS} characters, one line ending with ?.` },
  brief: { type: 'string', description: `Report brief: at most ${ASK_BRIEF_MAX_CHARACTERS} characters, at most 2 sentences explaining why it matters and the options.` },
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
export function validateMessageDigest(ask: MessageDigest, prefix = ''): void {
  const over = ([['question', ask.question, ASK_QUESTION_MAX_CHARACTERS], ['brief', ask.brief, ASK_BRIEF_MAX_CHARACTERS]] as const)
    .flatMap(([field, text, limit]) => {
      const length = typeof text === 'string' ? Array.from(text).length : 0;
      return length > limit ? [`${prefix}${field} is ${length} characters; the limit is ${limit}`] : [];
    });
  if (over.length) throw new Error(`${over.join('; ')}. Rewrite it shorter and send the ask again.`);
}

export function validateMessageAsk(ask: MessageAsk): void {
  validateMessageDigest(ask, 'ask.');
  const short = (text: unknown, words: number) => typeof text === 'string' &&
    new RegExp(`^\\S+(?:[ \\t]+\\S+){0,${words - 1}}$`).test(text);
  if (!Array.isArray(ask.options) || ask.options.length < 2 || ask.options.length > 4 ||
      ask.options.some(option => !short(option, 3)))
    throw new Error('Shorten options to 2–4 labels of 3 words or fewer.');
}

/** Report digests use the same persisted choices as asks, never a text-only card. */
export function reportMessageAsk(input: MessageDigest & { readonly options?: readonly string[] }): MessageAsk | undefined {
  validateMessageDigest(input);
  if (input.question === undefined && input.brief === undefined && input.options === undefined) return undefined;
  if (!input.question) throw new Error('Report digests require a question and 2–4 options; use ask or supply question, brief and options.');
  const ask = { question: input.question, brief: input.brief, options: input.options! };
  validateMessageAsk(ask);
  return ask;
}
