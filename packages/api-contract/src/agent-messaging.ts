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
    question: { type: 'string', pattern: '^\\S+(?:[ \\t]+\\S+){0,19}$' },
    options: { type: 'array', minItems: 2, maxItems: 4,
      items: { type: 'string', pattern: '^\\S+(?:[ \\t]+\\S+){0,2}$' } },
    recommended: { type: 'string', description: 'One of the option labels.' },
  },
} as const;

/** The plain shortening error is shared by the tool validator and server. */
export function validateMessageAsk(ask: MessageAsk): void {
  const short = (text: unknown, words: number) => typeof text === 'string' &&
    new RegExp(`^\\S+(?:[ \\t]+\\S+){0,${words - 1}}$`).test(text);
  if (!short(ask.question, 20)) throw new Error('Shorten question to 20 words or fewer on one line.');
  if (!Array.isArray(ask.options) || ask.options.length < 2 || ask.options.length > 4 ||
      ask.options.some(option => !short(option, 3)))
    throw new Error('Shorten options to 2–4 labels of 3 words or fewer.');
}
