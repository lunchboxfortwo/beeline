import { randomBytes } from 'node:crypto';
import { GITHUB_IDENTITY_AUDIENCE } from '@beeline/auth/github';
import { challenge, hash, type GitHubOperations } from './github-operations.js';
import { STAR_PROMPT_REPOSITORY } from './github-star-prompt.js';
import { githubProviderKey } from './providers/index.js';

/** Use the existing one-use App authorization flow, without installing repositories. */
export async function beginGitHubStarAuthorization(ctx: GitHubOperations, viewerId: string, redirectUri: string) {
  const state = `github_star_${randomBytes(32).toString('base64url')}`;
  await ctx.database.query(`INSERT INTO github_auth_flows(state_hash,identity_id,redirect_uri,purpose,expires_at)
    VALUES($1,$2,$3,'installation',now()+interval '15 minutes')`, [hash(state), viewerId, redirectUri]);
  // Starring: write is already an App account permission in github-manifest.ts.
  // GitHub Apps use that permission at sign-in; adding an OAuth scope would not grant it.
  return { url: ctx.oauth.authorizationUrl({ state, codeChallenge: challenge(state) }) };
}

export async function completeGitHubStarAuthorization(ctx: GitHubOperations, state: string, code?: string, callbackUri?: string) {
  // Consume before provider HTTP so a replay cannot exchange or star twice.
  const flow = (await ctx.database.query<{ identity_id: string; redirect_uri: string }>(`
    UPDATE github_auth_flows SET consumed_at=now() WHERE state_hash=$1 AND purpose='installation'
      AND consumed_at IS NULL AND expires_at>now() RETURNING identity_id,redirect_uri`, [hash(state)])).rows[0];
  if (!flow) throw new Error('GitHub star flow not found or expired');
  const redirect = new URL(flow.redirect_uri);
  redirect.searchParams.set('githubStar', 'failed');
  if (!code || !callbackUri) return redirect.toString();
  try {
    const identity = await ctx.oauth.exchangeCode(code, callbackUri, state);
    await ctx.database.transaction(async database => {
      const current = (await database.query<{ subject: string }>(`SELECT subject FROM identity_external_links
        WHERE provider='${githubProviderKey}' AND identity_id=$1 FOR UPDATE`, [flow.identity_id])).rows[0];
      if (current && current.subject !== identity.subject) throw new Error('github_account_mismatch');
      const bound = await database.query(`WITH linked AS (
        INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
        VALUES('${githubProviderKey}',$1,$2,$3,$4,$5) ON CONFLICT(provider,subject) DO UPDATE SET provider_login=EXCLUDED.provider_login
          WHERE identity_external_links.identity_id=EXCLUDED.identity_id RETURNING subject
      ), bound AS (
        UPDATE identities SET github_subject=linked.subject,updated_at=now() FROM linked WHERE id=$2 RETURNING id
      ) INSERT INTO github_user_tokens(subject,encrypted_token,encrypted_refresh_token,expires_at)
        SELECT linked.subject,$6,$7,$8 FROM linked CROSS JOIN bound
        ON CONFLICT(subject) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,
          encrypted_refresh_token=EXCLUDED.encrypted_refresh_token,expires_at=EXCLUDED.expires_at,stale_at=NULL,updated_at=now()
        RETURNING subject`, [identity.subject, flow.identity_id, identity.issuer, GITHUB_IDENTITY_AUDIENCE, identity.login,
        ctx.seal(identity.accessToken), identity.refreshToken ? ctx.seal(identity.refreshToken) : null,
        identity.tokenExpiresIn ? new Date(Date.now() + identity.tokenExpiresIn * 1000) : null]);
      if (!bound.rowCount) throw new Error('github_account_already_linked');
    });
    if (await ctx.app.starRepository(identity.accessToken, STAR_PROMPT_REPOSITORY)) {
      await ctx.database.query(`INSERT INTO github_star_prompts(identity_id,closed) VALUES($1,'starred')
        ON CONFLICT(identity_id) DO UPDATE SET closed='starred',updated_at=now()`, [flow.identity_id]);
      redirect.searchParams.set('githubStar', 'starred');
    }
  } catch {
    // A denial, account mismatch, or GitHub restriction returns to the same chat.
    // Keep the card eligible, and never claim a star that GitHub did not confirm.
  }
  return redirect.toString();
}
