import { parseHostGrantTarget, type HostGrantLogin } from '@beeline/api-contract/agent-grants';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';

/** Host grants: which live `user@host` login an ssh argv may run under. */

type LiveGrant = DaemonOperationMap['listAgentGrants']['output']['grants'][number];

function liveHostGrant(grant: LiveGrant, workspaceId: string): HostGrantLogin | undefined {
  if (grant.kind !== 'host' || grant.workspaceId !== workspaceId) return undefined;
  if (grant.status !== 'approved' && grant.status !== 'once') return undefined;
  if (grant.expiresAt && grant.expiresAt <= Date.now() / 1000) return undefined;
  return parseHostGrantTarget(grant.target.trim());
}

/**
 * `ssh user@host <command...>` runs under a live host grant for exactly that
 * login. The agent supplies no ssh options; the runner adds its own fixed set.
 */
export function matchHostGrant(
  grants: readonly LiveGrant[],
  workspaceId: string,
  argv: readonly string[],
): { grant: LiveGrant; login: HostGrantLogin } | undefined {
  if (argv[0] !== 'ssh' || argv.length < 3) return undefined;
  for (const grant of grants) {
    const login = liveHostGrant(grant, workspaceId);
    if (login && argv[1] === `${login.user}@${login.host}`) return { grant, login };
  }
  return undefined;
}

/** Why an ssh argv found no host grant, or undefined when no host grant is live. */
export function hostGrantRefusal(grants: readonly LiveGrant[], workspaceId: string, argv: readonly string[]): string | undefined {
  const logins = grants.flatMap((grant) => {
    const login = liveHostGrant(grant, workspaceId);
    return login ? [`${login.user}@${login.host}`] : [];
  });
  if (!logins.length) return undefined;
  return `no approved host grant matches ${argv[1] ?? '(no login)'}. Live host grants: ${logins.join(', ')}. ${HOST_GRANT_ARGV_HINT}`;
}

export const HOST_GRANT_ARGV_HINT =
  'Call it as ["ssh", "user@host", "<command>", ...] with no ssh options; Beeline adds its own.';

/**
 * A host run spawns outside the Room sandbox, so it must be the installed ssh:
 * root-owned in a tree the agent cannot modify, never a writable or shadowing
 * file earlier on PATH. Returns its absolute path or refuses.
 */
export function trustedHostSsh(
  resolve: (name: string, cwd: string, env: NodeJS.ProcessEnv) => string | undefined,
  cwd: string,
  path: string | undefined,
): string {
  const ssh = resolve('ssh', cwd, { PATH: path ?? '' });
  if (!ssh)
    throw new Error(
      'the first ssh on PATH is not a trusted installed executable (missing, writable by this agent, or shadowing the system one), so the host grant did not run.',
    );
  return ssh;
}
