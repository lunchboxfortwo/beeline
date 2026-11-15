import { CommandRefusalError } from './command-refusal.js';
import { normalizeApprovalIntent, approvalSentence, AGENT_SIGN_IN_SERVICE_LABELS, normalizeTrayAsk, shortenAsk, type AgentSignInHarness } from '@beeline/api-contract/phone';

/** Explicit asks are stored with approval cards; full ceremony text stays intact. */
export function approvalAsk(type: string | undefined, card: Record<string, unknown>): string | undefined {
  const field = (key: string) => typeof card[key] === 'string' ? String(card[key]) : '';
  if (type === 'choice') return typeof card.ask === 'string' && card.ask.trim() ? shortenAsk(card.ask) : shortenAsk(field('prompt'));
  let action = field('action');
  let purpose = field('purpose');
  switch (type) {
    case 'permission':
      action ||= card.purpose === 'squire-spending' ? `Spend with ${field('tool')}` : `Open an edit corner for ${field('repository')}`;
      // purpose was a permission-kind discriminator before action/purpose copy.
      purpose = field('approvalPurpose') || field('reason');
      break;
    case 'connector-offer': action ||= `Connect ${field('connectorName')}`; purpose ||= field('reason'); break;
    case 'app-sign-in': action ||= `Connect ${field('name').replace(/^(?:sign|log)\s*in\s+(?:to|with)\s+/i, '').replace(/[?!.:]+$/, '')}`; break;
    case 'agent-sign-in': action ||= `Sign in to ${AGENT_SIGN_IN_SERVICE_LABELS[field('harness') as AgentSignInHarness] ?? field('harness')}`; break;
    case 'squire-approval': action ||= field('title'); purpose ||= field('reason'); break;
    case 'grant-request': {
      const grant = Array.isArray(card.grants) ? card.grants[0] : undefined;
      if (!grant) return undefined;
      // An old command target can contain inline code. Never use it as row copy.
      action = grant.action || (grant.kind === 'command' ? `Run a ${grant.script ? 'script' : 'command'}` : `Use ${grant.appName || grant.target}`);
      purpose = grant.purpose || grant.reason;
      break;
    }
    default: return undefined;
  }
  return action ? approvalSentence(action, purpose) : undefined;
}

/** Invalid tool asks are caller refusals, not server faults. */
export function normalizeAgentAsk(value: unknown): string {
  try {
    return normalizeTrayAsk(value);
  } catch (error) {
    throw new CommandRefusalError(error instanceof Error ? error.message : 'ask is invalid', 400);
  }
}

/** Refusals return directly to the agent before any card is written. */
export function normalizeAgentApprovalIntent(input: { action?: unknown; purpose?: unknown }) {
  try { return normalizeApprovalIntent(input); }
  catch (error) { throw new CommandRefusalError(error instanceof Error ? error.message : 'Supply action and purpose.', 400); }
}
