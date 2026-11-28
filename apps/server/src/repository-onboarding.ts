import { githubProviderKey } from './providers/index.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { createHash } from 'node:crypto';
import { CommandRefusalError } from './command-refusal.js';
import { isValidRepositoryName, type RepositoryOnboardingCard } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import type { GitHubOperations } from './github-operations.js';
import { systemLine } from './system-line.js';

const GENERIC_CHAT_NAMES = new Set(['general', 'random', 'lobby', 'chat', 'welcome', 'home', 'main', 'new-chat']);

/** Turn a requested repository or chat name into a safe GitHub repository slug. */
export function sanitizeRepositoryName(raw: string): string | undefined {
  const tail = raw.trim().split('/').pop() ?? '';
  const cleaned = tail
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[.-]+$/g, '')
    .replace(/(?:\.git)+$/i, '')
    .slice(0, 100)
    .replace(/[.-]+$/g, '');
  return isValidRepositoryName(cleaned) ? cleaned : undefined;
}

/** Validate a repository name chosen by a person before creating it on GitHub. */
export function validateRepositoryName(raw: string): string {
  const name = raw.trim();
  if (!isValidRepositoryName(name)) {
    throw new CommandRefusalError('Use letters, numbers, hyphens, dots, or underscores for the repository name.', 400);
  }
  return name;
}

function installedRepositoryName(repositories: readonly { full_name: string }[], requested: string): string | undefined {
  const needle = requested.trim().toLowerCase();
  if (!needle) return undefined;
  const full = repositories.filter((repo) => repo.full_name.toLowerCase() === needle);
  if (full.length === 1) return full[0]!.full_name;
  const bare = repositories.filter((repo) => repo.full_name.split('/').pop()!.toLowerCase() === needle);
  return bare.length === 1 ? bare[0]!.full_name : undefined;
}

export async function postRepositoryOnboarding(database: SqlDatabase, _github: GitHubOperations | undefined,
  input: { roomId: string; agentId: string; requesterId: string; kind?: 'repository'; repository?: string }): Promise<RepositoryOnboardingCard> {
  const room = (await database.query<{ repository_name: string | null; room_name: string | null; name: string; can_link: boolean; owner_handle: string | null; github_linked: boolean }>(
    `SELECT r.repository_name,r.name room_name,i.name,(w.role IN ('owner','admin')) can_link,
     (SELECT owner.handle FROM memberships membership JOIN identities owner ON owner.id=membership.identity_id
      WHERE membership.workspace_id=r.workspace_id AND membership.room_id IS NULL AND membership.role='owner'
      AND membership.removed_at IS NULL ORDER BY owner.id LIMIT 1) owner_handle,
     EXISTS(SELECT 1 FROM identity_external_links link WHERE link.identity_id=$3 AND link.provider='${githubProviderKey}') github_linked FROM rooms r
     JOIN memberships m ON m.room_id=r.id AND m.identity_id=$2 AND m.removed_at IS NULL
     JOIN memberships w ON w.workspace_id=r.workspace_id AND w.room_id IS NULL AND w.identity_id=$3 AND w.removed_at IS NULL
     JOIN identities i ON i.id=$2
     WHERE r.id=$1 AND r.parent_id IS NULL AND r.archived_at IS NULL`,
    [input.roomId, input.agentId, input.requesterId])).rows[0];
  if (!room) throw new Error('repository cards require an active top-level chat and current members');
  const repositories = (await database.query<{ repository_id: string; full_name: string; installation_id: string; default_branch: string }>(
    `SELECT r.* FROM github_repositories r JOIN github_installations i USING(installation_id)
     WHERE i.owner_id=$1 AND i.status='active' AND r.active ORDER BY lower(r.full_name)`, [input.requesterId])).rows;
  const installation = (await database.query<{ installation_id: string; account_login: string }>(
    `SELECT installation_id,account_login FROM github_installations WHERE owner_id=$1 AND status='active'
     AND account_type='User' AND repository_selection='all' ORDER BY installation_id LIMIT 1`, [input.requesterId])).rows[0];
  const kind = 'repository' as const;
  return database.transaction(async database => {
    const previous = (await database.query<{ id: string; author_id: string; card: RepositoryOnboardingCard }>(
      `SELECT id,author_id,card FROM messages WHERE room_id=$1 AND card_type='repository-onboarding'
       AND card->>'kind'=$2 AND card->>'requesterId'=$3
       ORDER BY created_at DESC,id DESC LIMIT 1`, [input.roomId, kind, input.requesterId])).rows[0];
    const reuse = previous?.card.status === 'open' && previous.author_id === input.agentId;
    // Calls observing the same predecessor choose the same next primary key.
    // A competing author cannot overwrite that winner or reopen a settled card.
    const id = reuse ? previous.id : createHash('sha256').update(JSON.stringify([
      'repository-onboarding', input.roomId, input.requesterId, kind, previous?.id ?? null])).digest('hex');
    const { repository: requestedRepository, kind: _kind, ...posted } = input;
    const selected = requestedRepository ? installedRepositoryName(repositories, requestedRepository) : undefined;
    const requestedDefault = requestedRepository && !selected ? sanitizeRepositoryName(requestedRepository) : undefined;
    const chatDefault = room.room_name && !GENERIC_CHAT_NAMES.has(room.room_name.trim().toLowerCase())
      ? sanitizeRepositoryName(room.room_name)
      : undefined;
    const defaultName = requestedDefault ?? (reuse ? previous.card.defaultName : undefined) ?? chatDefault ?? `new-project-${id.slice(0, 6)}`;
    const card: RepositoryOnboardingCard = {
      id, ...posted, ...(room.owner_handle ? { ownerHandle: room.owner_handle } : {}), githubLinked: room.github_linked, kind, status: 'open', canLink: room.can_link,
      ...(selected ? { selected } : {}),
      state: room.repository_name ? 'repo_linked' : installation ? 'no_repo_linked' : 'install_missing',
      ...(room.repository_name ? { repository: room.repository_name } : {}),
      defaultName,
      ...(installation ? { installationId: Number(installation.installation_id), ...(installation.account_login ? { installationAccount: installation.account_login } : {}) } : {}),
      repositories: repositories.map(r => ({ id: Number(r.repository_id), fullName: r.full_name,
        installationId: Number(r.installation_id), defaultBranch: r.default_branch, current: r.full_name === room.repository_name })),
    };
    await systemLine(database, { id, roomId: input.roomId, authorId: input.agentId,
      ...(previous ? { afterMessageId: previous.id } : {}),
      subject: { id: input.agentId, kind: 'agent', name: room.name },
      verb: systemMessage('repository-onboarding.offered-a-repository'),
      object: room.repository_name ?? systemMessage('repository-onboarding.choose-or-create-a-repository'), presentation: 'card',
      cardType: 'repository-onboarding', card: card as unknown as Record<string, unknown> });
    const applied = await database.query(`WITH applied AS (
      UPDATE messages SET card=$2::jsonb WHERE id=$1 AND author_id=$3
        AND card_type='repository-onboarding' AND card->>'status'='open' RETURNING id
    ), superseded AS (
      UPDATE messages SET card=card || '{"status":"settled","resolution":"superseded"}'::jsonb
      WHERE room_id=$4 AND id<>$1 AND card_type='repository-onboarding'
        AND card->>'kind'=$5 AND card->>'status'='open' AND card->>'requesterId'=$6
        AND EXISTS(SELECT 1 FROM applied)
    ) SELECT id FROM applied`, [id, JSON.stringify(card), input.agentId, input.roomId, kind, input.requesterId]);
    if (!applied.rowCount) throw new CommandRefusalError('Repository card changed; no card was posted', 409);
    return card;
  });
}
