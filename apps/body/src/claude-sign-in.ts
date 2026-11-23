/**
 * Claude Code's paste-back sign-in, run on the agent's own machine.
 *
 * The owner sends `@agent /login`; the server relays `start` here
 * (`agent-sign-in.ts` dispatches by harness). This helper builds Claude
 * Code's own manual-paste OAuth link (PKCE, S256) and keeps the verifier in
 * memory. The owner approves on claude.ai,
 * pastes the code back, and the server relays it here once. This helper
 * exchanges it once and hands the login to the machine's CLIProxyAPI
 * (`cliproxy.ts`), which alone refreshes it from then on.
 *
 * Claude's OAuth login is not a public API. The constants below mirror
 * Claude Code 2.1.280; `claude-sign-in.contract.test.ts` pins the request and
 * response shapes this file depends on, and a shape change surfaces to the
 * owner as `ClaudeSignInShapeError` instead of a corrupt login.
 */
import { createHash, randomBytes } from 'node:crypto';
import { AGENT_SIGN_IN_ATTEMPT_TTL_MS } from '@beeline/api-contract/daemon';
import { ask } from './wait.js';

export const CLAUDE_OAUTH = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  redirectUri: 'https://platform.claude.com/oauth/code/callback',
  scopes: [
    'org:create_api_key',
    'user:profile',
    'user:inference',
    'user:sessions:claude_code',
    'user:mcp_servers',
    'user:file_upload',
    'user:plugins',
  ],
} as const;

export const CLAUDE_SIGN_IN_EXPIRED_MESSAGE =
  'This sign-in expired or was already used. Send the agent `/login` again to start a new one.';
export const CLAUDE_SIGN_IN_REJECTED_MESSAGE =
  'Claude did not accept that code. Paste the newest code from claude.ai, or send the agent `/login` again.';
export const CLAUDE_SIGN_IN_WRONG_ATTEMPT_MESSAGE =
  'That code belongs to a different sign-in. Paste the code from the page this sign-in opened.';

/** Claude answered with a shape this helper does not know: never write it. */
export class ClaudeSignInShapeError extends Error {
  constructor(detail: string) {
    super(
      `Claude's sign-in answer changed shape (${detail}). Nothing was saved; update the helper with \`npx usebeeline update\`, or run \`beeline connect\` on the machine.`,
    );
    this.name = 'ClaudeSignInShapeError';
  }
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

export function claudeAuthorizeUrl(input: { codeChallenge: string; state: string }): string {
  const url = new URL(CLAUDE_OAUTH.authorizeUrl);
  url.searchParams.append('code', 'true');
  url.searchParams.append('client_id', CLAUDE_OAUTH.clientId);
  url.searchParams.append('response_type', 'code');
  url.searchParams.append('redirect_uri', CLAUDE_OAUTH.redirectUri);
  url.searchParams.append('scope', CLAUDE_OAUTH.scopes.join(' '));
  url.searchParams.append('code_challenge', input.codeChallenge);
  url.searchParams.append('code_challenge_method', 'S256');
  url.searchParams.append('state', input.state);
  return url.toString();
}

/** The manual-paste page shows `code#state`; a bare code is accepted too. */
export function splitPastedClaudeCode(pasted: string): { code: string; state?: string } {
  const trimmed = pasted.trim();
  const hash = trimmed.indexOf('#');
  if (hash < 0) return { code: trimmed };
  return { code: trimmed.slice(0, hash), state: trimmed.slice(hash + 1) };
}

/** Validate Claude's token answer, shaped as CLIProxyAPI stores a Claude account. */
export function claudeProxyLogin(body: unknown, now: number): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new ClaudeSignInShapeError('not a JSON object');
  const value = body as Record<string, unknown>;
  if (typeof value.access_token !== 'string' || !value.access_token)
    throw new ClaudeSignInShapeError('missing access_token');
  if (typeof value.refresh_token !== 'string' || !value.refresh_token)
    throw new ClaudeSignInShapeError('missing refresh_token');
  if (
    typeof value.expires_in !== 'number' ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0
  )
    throw new ClaudeSignInShapeError('missing expires_in');
  if (value.scope !== undefined && typeof value.scope !== 'string')
    throw new ClaudeSignInShapeError('scope is not a string');
  if (!(typeof value.scope === 'string' ? value.scope.split(' ') : []).includes('user:inference'))
    throw new ClaudeSignInShapeError('the login does not grant user:inference');
  const email = (value.account as { email_address?: unknown } | undefined)?.email_address;
  return {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expired: new Date(now + value.expires_in * 1000).toISOString(),
    last_refresh: new Date(now).toISOString(),
    ...(typeof email === 'string' && email ? { email } : {}),
  };
}

type PendingAttempt = {
  readonly verifier: string;
  readonly state: string;
  readonly expiresAt: number;
  completing: boolean;
};

export type ClaudeSignInOptions = {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
};

/** One agent runtime's in-memory sign-in attempts. Verifiers never leave it. */
export class ClaudeSignIn {
  readonly #attempts = new Map<string, PendingAttempt>();
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: ClaudeSignInOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  start(attemptId: string): string {
    this.#prune();
    const verifier = base64Url(randomBytes(32));
    const state = base64Url(randomBytes(32));
    this.#attempts.set(attemptId, {
      verifier,
      state,
      expiresAt: this.#now() + AGENT_SIGN_IN_ATTEMPT_TTL_MS,
      completing: false,
    });
    return claudeAuthorizeUrl({
      codeChallenge: base64Url(createHash('sha256').update(verifier).digest()),
      state,
    });
  }

  /** Exchange the pasted code for a login. A rejected code keeps the attempt for a retry. */
  async complete(attemptId: string, pasted: string): Promise<Record<string, unknown>> {
    this.#prune();
    const attempt = this.#attempts.get(attemptId);
    if (!attempt || attempt.completing) throw new Error(CLAUDE_SIGN_IN_EXPIRED_MESSAGE);
    const { code, state } = splitPastedClaudeCode(pasted);
    if (!code) throw new Error(CLAUDE_SIGN_IN_REJECTED_MESSAGE);
    if (state !== undefined && state !== attempt.state)
      throw new Error(CLAUDE_SIGN_IN_WRONG_ATTEMPT_MESSAGE);
    attempt.completing = true;
    try {
      const request = {
        grant_type: 'authorization_code',
        code,
        redirect_uri: CLAUDE_OAUTH.redirectUri,
        client_id: CLAUDE_OAUTH.clientId,
        code_verifier: attempt.verifier,
        state: attempt.state,
      };
      let response: Response;
      try {
        response = await ask(
          { url: CLAUDE_OAUTH.tokenUrl, peer: "Claude's sign-in service", fetch: this.#fetch },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
          },
        );
      } catch {
        throw new Error(
          "Could not reach Claude's sign-in service from the agent's machine. Try again.",
        );
      }
      if (response.status === 400 || response.status === 401)
        throw new Error(CLAUDE_SIGN_IN_REJECTED_MESSAGE);
      if (!response.ok)
        throw new Error(`Claude's sign-in service answered ${response.status}. Try again shortly.`);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ClaudeSignInShapeError('not JSON');
      }
      const login = claudeProxyLogin(body, this.#now());
      this.#attempts.delete(attemptId);
      return login;
    } finally {
      attempt.completing = false;
    }
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, attempt] of this.#attempts)
      if (attempt.expiresAt <= now && !attempt.completing) this.#attempts.delete(id);
  }
}
