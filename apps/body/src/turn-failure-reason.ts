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

const SHELL_ENV_HEAD = /(^|[\s;|&])((?:export\s+)?[A-Z_][A-Z0-9_]*)=/g;

function enclosingQuoteAt(source: string, pos: number): '"' | "'" | null {
  const lineStart = source.lastIndexOf('\n', pos - 1) + 1;
  let quote: '"' | "'" | null = null;
  for (let i = lineStart; i < pos; i += 1) {
    const ch = source[i]!;
    if (quote === '"') {
      if (ch === '\\') i += 1;
      else if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (ch === '\\') {
      i += 1;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    }
  }
  return quote;
}

function scanShellAssignmentValueEnd(
  source: string,
  start: number,
  enclosingQuote: '"' | "'" | null,
): number {
  let i = start;
  while (i < source.length) {
    const ch = source[i]!;
    if (enclosingQuote && ch === enclosingQuote) break;
    if (/[\s;|&]/.test(ch)) break;
    if (ch === '"' || ch === "'") {
      const inner = ch;
      i += 1;
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') {
        if (enclosingQuote && source[i] === enclosingQuote) break;
        if (inner === '"' && source[i] === '\\' && i + 1 < source.length) {
          i += 2;
          continue;
        }
        if (source[i] === inner) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < source.length) {
      if (enclosingQuote === '"' && source[i + 1] === '"') {
        i += 2;
        while (i < source.length && source[i] !== '\n' && source[i] !== '\r') {
          if (source[i] === '"') break;
          if (source[i] === '\\' && source[i + 1] === '"') {
            i += 2;
            break;
          }
          i += 1;
        }
        continue;
      }
      i += 2;
      continue;
    }
    i += 1;
  }
  return i;
}

function redactShellEnvAssignments(source: string): string {
  SHELL_ENV_HEAD.lastIndex = 0;
  let out = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = SHELL_ENV_HEAD.exec(source)) !== null) {
    const prefix = match[1] ?? '';
    const name = match[2] ?? '';
    const offset = match.index;
    const valueStart = offset + match[0].length;
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
        continue;
      }
    }
    const enclosingQuote = enclosingQuoteAt(source, offset + prefix.length);
    const valueEnd = scanShellAssignmentValueEnd(source, valueStart, enclosingQuote);
    if (valueEnd === valueStart) continue;
    out += source.slice(cursor, offset) + `${prefix}${name}=[REDACTED]`;
    cursor = valueEnd;
    SHELL_ENV_HEAD.lastIndex = valueEnd;
  }
  return cursor === 0 ? source : out + source.slice(cursor);
}

/** Keep wire-visible tool detail useful without ever carrying credentials. */
export function redactToolDetail(value: string): string {
  const preEnv = value
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
    );
  return redactShellEnvAssignments(preEnv)
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
