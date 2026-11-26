import { ModelSelectionUnavailableError } from './model-config.js';
import { classifyTurnSilence, type TurnReceiptReasonKind } from '@beeline/api-contract/daemon';

/**
 * A failed turn receipt retains the complete diagnostic, including child
 * stderr. Callers scrub secrets before publishing; JavaScript stacks stay in
 * the daemon log.
 */

export interface DistilledTurnFailureReason {
  readonly text: string;
  readonly kind?: TurnReceiptReasonKind;
}

/** Keep wire-visible tool detail useful without ever carrying credentials. */
export function redactToolDetail(value: string): string {
  return value
    .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b(Bearer\s+)[^\s,"'}\]]+/gi, '$1[REDACTED]')
    .replace(
      /(["']?)\b(api[_-]?key|token|secret|password|passwd|authorization|credential|cookie|private[_-]?key)\1\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)/gi,
      '"$2": "[REDACTED]"',
    )
    .replace(
      /\b(password|passwd)(\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"']+)/gi,
      '$1$2[REDACTED]',
    )
    .replace(
      /(\b(?:machine\s+\S+|default)\s+[\s\S]*?\blogin\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(^|[\s;|&])((?:export\s+)?[A-Z_][A-Z0-9_]*)=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;|&"']+)/g,
      (match, prefix: string, name: string, offset: number, source: string) => {
        if (prefix === '&') {
          const tokenStart =
            Math.max(
              source.lastIndexOf(' ', offset),
              source.lastIndexOf('\t', offset),
              source.lastIndexOf('\n', offset),
              source.lastIndexOf('\r', offset),
              source.lastIndexOf('"', offset),
              source.lastIndexOf("'", offset),
            ) + 1;
          const tokenBeforeAmp = source.slice(tokenStart, offset);
          if (
            tokenBeforeAmp.includes('?') &&
            (tokenBeforeAmp.includes('://') || tokenBeforeAmp.startsWith('?'))
          ) {
            return match;
          }
        }
        return `${prefix}${name}=[REDACTED]`;
      },
    )
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/gi, '[REDACTED]')
    .replace(/\b(?:bat|brt|bdt|bde|bfm)_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, '[REDACTED]')
    .replace(/\bbfmc_v1\.[a-f0-9]{32}\.[a-f0-9]{64}\b/gi, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(
      /(--?(?:api[_-]?key|token|secret|password|authorization|credential|cookie)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1[REDACTED]',
    );
}

/**
 * CLIProxyAPI's refusal when no login it holds serves the model: the
 * account was never signed in there. Codex shows it as its whole reply;
 * Claude fails the turn with it.
 */
export const CLIPROXY_SIGNED_OUT = /unknown provider for model \S+/i;

/** Preserve diagnostic stacks in the helper journal. */
export function turnErrorDetail(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

export function distillTurnFailureReason(error: unknown): DistilledTurnFailureReason {
  if (error instanceof ModelSelectionUnavailableError) {
    return { text: 'model selection unavailable', kind: 'model-selection-unavailable' };
  }
  let raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error && typeof error === 'object' && 'message' in error
          ? String((error as { message: unknown }).message)
          : error == null
            ? ''
            : String(error);
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr :
      Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : '';
    if (stderr.trim() && !raw.includes(stderr.trim())) raw += `\n${stderr}`;
  }
  // ACP -32000 is the harness's explicit authentication-required refusal.
  // Unlike a provider token-refresh race, retrying it cannot sign the agent in.
  if (/^ACP error -32000: Authentication required(?:[.;]|$)/i.test(raw.trim()) || CLIPROXY_SIGNED_OUT.test(raw)) {
    return { text: 'Authentication required: the agent needs to sign in again', kind: 'not-signed-in' };
  }
  const informative = raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s/.test(line));
  const classified = classifyTurnSilence(
    informative.join(' ').replace(/\s+/g, ' '),
  );
  const text = informative.join('\n').trim().replace(/^(?:[A-Za-z]*Error|Error):\s*/, '') || 'turn failed';
  // Keep the diagnostic wire classification; the server records the result
  // without a retry budget or automatic escalation.
  const kind: TurnReceiptReasonKind =
    classified.kind === 'wrong-model'
      ? 'model-selection-unavailable'
      : classified.kind === 'not-signed-in'
        ? 'hiccup'
        : classified.kind;
  return { text, kind };
}
