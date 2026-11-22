import { COMMAND_SECRET_NAME } from '@beeline/api-contract/agent-grants';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';

/** Secret grants: which live grant lets a granted command receive a named secret. */

type LiveGrant = DaemonOperationMap['listAgentGrants']['output']['grants'][number];

const MAX_REQUESTED_SECRETS = 8;

/** The `secrets` a run_granted_command call asks for: distinct UPPER_CASE names. */
export function validateRequestedSecrets(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REQUESTED_SECRETS)
    throw new Error(`secrets must be an array of at most ${MAX_REQUESTED_SECRETS} names`);
  const names = value.map((name) => {
    if (typeof name !== 'string' || !COMMAND_SECRET_NAME.test(name))
      throw new Error('secrets must be UPPER_CASE names such as FLY_TOKEN');
    return name;
  });
  if (new Set(names).size !== names.length) throw new Error('secrets must not repeat a name');
  return names;
}

/** A live, unexpired secret grant for exactly this name in this workspace. */
export function liveSecretGrant(
  grants: readonly LiveGrant[],
  workspaceId: string,
  name: string,
): LiveGrant | undefined {
  return grants.find(
    (grant) =>
      grant.kind === 'secret' &&
      grant.workspaceId === workspaceId &&
      grant.target.trim() === name &&
      (grant.status === 'approved' || grant.status === 'once') &&
      !(grant.expiresAt && grant.expiresAt <= Date.now() / 1000),
  );
}

/** The live grant for each requested secret, or a refusal naming the first one missing. */
export function requireSecretGrants(
  grants: readonly LiveGrant[],
  workspaceId: string,
  names: readonly string[],
): LiveGrant[] {
  return names.map((name) => {
    const found = liveSecretGrant(grants, workspaceId, name);
    if (!found)
      throw new Error(
        `no approved secret grant for ${name} in this session; ask with request_grant kind=secret target=${name}, or name it in the command grant with --with ${name}.`,
      );
    return found;
  });
}
