import { systemMessage } from './system-message-catalog.js';
/** Safe, non-secret presentation metadata relayed with a Squire approval. */
export type SquireApprovalDetails = {
  readonly action?: string;
  readonly purpose?: string;
  readonly reason?: string;
  readonly facts?: readonly { readonly label: string; readonly value: string }[];
  readonly reference?: string;
};

/** Older helpers supply only title/detail; keep their approval cards readable. */
export function squireApprovalAction(tool: string, detail: string, linkKind?: string): string {
  const first = detail.split(' · ')[0]?.trim() ?? '';
  switch (tool) {
    case 'fetch_credential': return systemMessage("approval-copy.reveal-a-key");
    case 'inject_card': return systemMessage("approval-copy.buy", first || systemMessage("approval-copy.an-item"));
    case 'edit_credential': return systemMessage("approval-copy.edit-a-key");
    case 'delete_credential': return systemMessage("approval-copy.delete-a-key");
    case 'edit_payment_card': return systemMessage("approval-copy.edit-a-card");
    case 'operate_login':
    case 'operate_fill_credential': return systemMessage("approval-copy.sign-in-to", first.replace(/^Sign in to /i, '') || systemMessage("approval-copy.a-site"));
    case 'Link': return systemMessage("approval-copy.confirm-a-purchase");
    default: return linkKind === 'vouch' ? systemMessage("approval-copy.request-a-vouch") : linkKind === 'passkey' ? systemMessage("approval-copy.use-a-passkey") : systemMessage("approval-copy.use-trusty-squire");
  }
}

/** Agent-written approval copy. Display DTOs remain optional for older cards. */
export type ApprovalIntent = { readonly action: string; readonly purpose: string };

export const APPROVAL_ACTION_SCHEMA = {
  type: 'string', minLength: 1, maxLength: 120,
  description: 'What you will do: a verb phrase with the concrete object, at most 12 words. Example: Connect Stripe Link. No commands or scripts.',
} as const;
export const APPROVAL_PURPOSE_SCHEMA = {
  type: 'string', minLength: 1, maxLength: 240,
  description: 'Why: at most 20 words, starting with a verb. Example: pay for the $29 domain renewal for whitejade.xyz. Rendered as action to purpose.',
} as const;

/** Refuse before posting anything; these diagnostics are for the requesting agent. */
export function normalizeApprovalIntent(input: { action?: unknown; purpose?: unknown }): ApprovalIntent {
  const read = (key: 'action' | 'purpose', words: number, chars: number) => {
    const value = typeof input[key] === 'string' ? input[key].replace(/\s+/g, ' ').trim() : '';
    if (!value) throw new Error(`Supply ${key}: ${key === 'action' ? 'what you will do, with the concrete object' : 'why you will do it'}.`);
    if (value.length > chars || value.split(' ').length > words)
      throw new Error(`Shorten ${key} to at most ${words} words and ${chars} characters.`);
    return value;
  };
  return { action: read('action', 12, 120), purpose: read('purpose', 20, 240) };
}

/** Do not truncate a supplied purpose or substitute raw commands for the action. */
export function approvalSentence(action: string, purpose?: string): string {
  const clean = (value: string) => value.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  const what = clean(action);
  const why = purpose ? clean(purpose).replace(/^to\s+/i, '') : '';
  return why ? `${what} to ${why}` : what;
}

/** Harness prompts carry tool metadata rather than agent-written approval copy. */
export function harnessApprovalIntent(title: string, narration?: string): { action: string; purpose?: string } {
  const heading = title.split(/[\n:`]/, 1)[0]?.trim() ?? '';
  const action = !heading || /[;|&{}=<>]|^(?:bash|sh|zsh|node|python\d*|npm|npx|curl|git)\b/i.test(heading)
    ? 'Run a command' : heading;
  const prose = narration?.replace(/```[\s\S]*?```/g, '').trim();
  const sentence = prose?.split(/(?<=[.!?])\s+|\n+/).filter(Boolean).at(-1)?.trim()
    .replace(/^(?:I(?:['’]ll| will| am going to)|Let me)\s+/i, '').replace(/[.!?]+$/, '');
  return { action, ...(sentence ? { purpose: sentence } : {}) };
}
