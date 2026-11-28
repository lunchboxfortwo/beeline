import { randomUUID } from 'node:crypto';
import { GitHubHttpError } from '@beeline/auth/github';
import { CommandRefusalError } from '../command-refusal.js';
import { phoneIdentity as identity } from '../phone-identity.js';
import { postRepositoryOnboarding, validateRepositoryName } from '../repository-onboarding.js';
import { readRepositoryOnboardingCard } from '@beeline/api-contract/phone';
import { settleWorkflowGate } from '../workflow-runs.js';
import { answerRoomChoice, postRoomChoice, skipRoomChoice } from '../room-choice.js';
import type { PhoneContext } from './context.js';
import { Input, Output } from './types.js';
import { phoneHasRoomAccess, phoneAssertRoomIsWritable, phoneRequireRoomWorkspaceManager, phoneRequireTopLevelChatMember, phoneRequireGitHub } from './access.js';
import { messageId } from './values.js';
import { PhoneService } from '../phone-service.js';


  export async function phoneCreateRoomPoll(ctx: PhoneContext, input: Input<'createRoomPoll'>, viewerId: string) {
    if (!(await phoneHasRoomAccess(ctx, input.roomId, viewerId))) throw new Error('room access denied');
    await phoneAssertRoomIsWritable(ctx, input.roomId, viewerId);
    const identity = await ctx.database.query<{ kind: string }>(
      `SELECT kind FROM identities WHERE id=$1`,
      [viewerId],
    );
    if (identity.rows[0]?.kind !== 'human') throw new Error('poll creator must be human');
    return ctx.database.transaction(async (database) => {
      const result = await postRoomChoice(database, {
        roomId: input.roomId,
        agentId: viewerId,
        mode: 'poll',
        prompt: input.prompt,
        options: input.options,
        ttlSeconds: input.ttlSeconds,
      });
      return {
        choiceId: result.choiceId,
        messageId: result.messageId,
        roomId: input.roomId,
        closesAt: result.closesAt!,
      };
    });
  }

  const CREATE_LOCK_TTL_MS = 120_000;

  type RecordedCreatedRepository = {
    id: number;
    fullName: string;
    installationId: number;
    defaultBranch: string;
    requestedName: string;
  };

  function readRecordedCreatedRepository(raw: Record<string, unknown> | null | undefined): RecordedCreatedRepository | undefined {
    const value = raw?.createdRepository;
    if (!value || typeof value !== 'object') return undefined;
    const item = value as Record<string, unknown>;
    if (
      typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id <= 0 ||
      typeof item.installationId !== 'number' || !Number.isSafeInteger(item.installationId) || item.installationId <= 0 ||
      typeof item.fullName !== 'string' || !item.fullName ||
      typeof item.defaultBranch !== 'string' || !item.defaultBranch ||
      typeof item.requestedName !== 'string' || !item.requestedName
    ) return undefined;
    return {
      id: item.id,
      fullName: item.fullName,
      installationId: item.installationId,
      defaultBranch: item.defaultBranch,
      requestedName: item.requestedName,
    };
  }

  function hasActiveCreateLock(raw: Record<string, unknown> | null | undefined, now = Date.now()): boolean {
    if (typeof raw?.creatingToken !== 'string' || !raw.creatingToken) return false;
    const startedAt = typeof raw.creatingAt === 'number' ? raw.creatingAt : 0;
    return startedAt > 0 && now - startedAt < CREATE_LOCK_TTL_MS;
  }

  async function bootstrapLinkedEmptyRepository(ctx: PhoneContext, roomId: string): Promise<void> {
    if (!ctx.github?.bootstrapEmptyRoomRepository) return;
    try {
      await ctx.github.bootstrapEmptyRoomRepository(roomId);
    } catch (error) {
      console.warn(`[server] empty repository bootstrap skipped for room ${roomId}:`, error);
    }
  }

  export async function phoneActOnRepositoryCard(ctx: PhoneContext, input: Input<'actOnRepositoryCard'>, viewerId: string): Promise<Output<'actOnRepositoryCard'>> {
    if (['create', 'link', 'install', 'organization'].includes(input.action)) await phoneRequireRoomWorkspaceManager(ctx, input.roomId, viewerId);
    else {
      if (!(await phoneHasRoomAccess(ctx, input.roomId, viewerId))) throw new Error('room access denied');
      await phoneRequireTopLevelChatMember(ctx, input.roomId, viewerId);
    }
    if (input.action === 'create') {
      const lockToken = randomUUID();
      const prepared = await ctx.database.transaction(async database => {
        const row = (await database.query<{ card: Record<string, unknown> | null }>(
          `SELECT card FROM messages WHERE id=$1 AND room_id=$2 AND card_type='repository-onboarding' FOR UPDATE`,
          [input.cardId, input.roomId])).rows[0];
        const card = readRepositoryOnboardingCard(row?.card);
        if (!card || card.requesterId !== viewerId) throw new Error('repository card access denied');
        if (card.status === 'settled') return { done: true as const, linkedNow: false, result: { selected: card.selected } };
        if (hasActiveCreateLock(row?.card)) {
          throw new CommandRefusalError('A repository creation is already in progress for this card. Wait for it to finish.', 409);
        }
        const requestedName = input.name !== undefined ? validateRepositoryName(input.name) : card.defaultName;
        const recorded = readRecordedCreatedRepository(row?.card);
        if (recorded) {
          // Recover only the exact repository ID recorded from a successful create on this card.
          if (recorded.requestedName.toLowerCase() !== requestedName.toLowerCase()) {
            throw new CommandRefusalError(
              `This card already created "${recorded.fullName}". Retry with "${recorded.requestedName}" or tap Link existing.`,
              409,
            );
          }
          const service = new PhoneService(database, ctx.publicOrigin, ctx.github, ctx.sendPushTest, ctx.live, true);
          await service.setRepository({ roomId: input.roomId, key: `github:${recorded.id}`, name: recorded.fullName,
            remote: `git://github.com/${recorded.fullName}`, targetBranch: recorded.defaultBranch,
            githubInstallationId: recorded.installationId }, viewerId);
          await database.query(
            `UPDATE messages SET card=(card - 'creatingToken' - 'creatingAt' - 'createdRepository') || $2::jsonb,version=version+1 WHERE id=$1`,
            [
              input.cardId,
              JSON.stringify({
                status: 'settled',
                resolution: 'created',
                selected: recorded.requestedName,
                repository: recorded.fullName,
                defaultName: recorded.requestedName,
              }),
            ],
          );
          return { done: true as const, linkedNow: true, result: { selected: recorded.requestedName } };
        }
        if (!card.installationId) throw new Error('Install Beeline on all personal repositories first');
        const service = new PhoneService(database, ctx.publicOrigin, ctx.github, ctx.sendPushTest, ctx.live, true);
        await phoneRequireGitHub(ctx).refresh(viewerId);
        const available = await service.listRepositories(viewerId);
        const existing = available.repositories.find(r =>
          r.installationId === card.installationId && r.fullName.split('/')[1]?.toLowerCase() === requestedName.toLowerCase(),
        );
        if (existing) {
          throw new CommandRefusalError(
            `Repository "${existing.fullName}" already exists. Choose a different name or tap Link existing.`,
            409,
          );
        }
        // Hold one active create lock per card while GitHub creates the repository.
        await database.query(
          `UPDATE messages SET card=card || jsonb_build_object('creatingToken', $2::text, 'creatingAt', $3::double precision) WHERE id=$1`,
          [input.cardId, lockToken, Date.now()],
        );
        return { done: false as const, installationId: card.installationId, requestedName };
      });
      if (prepared.done) {
        if (prepared.linkedNow) await bootstrapLinkedEmptyRepository(ctx, input.roomId);
        ctx.live?.publish({ type: 'invalidate', roomId: input.roomId, reason: 'message' });
        return prepared.result;
      }
      const releaseCreateLock = async () => {
        await ctx.database.query(
          `UPDATE messages SET card=card - 'creatingToken' - 'creatingAt' WHERE id=$1 AND card->>'creatingToken'=$2 AND card->>'status'='open'`,
          [input.cardId, lockToken],
        );
      };
      let created;
      try {
        created = await phoneRequireGitHub(ctx).createRepository(viewerId, {
          installationId: prepared.installationId, name: prepared.requestedName, private: true,
        }, ctx.database);
      } catch (error) {
        await releaseCreateLock();
        if (error instanceof CommandRefusalError) throw error;
        if (error instanceof GitHubHttpError && error.status === 422) {
          const detail = error.detail?.trim();
          if (detail && /name already exists|already exists on this account/i.test(detail)) {
            throw new CommandRefusalError(
              `Repository "${prepared.requestedName}" already exists on GitHub. Choose a different name or tap Link existing.`,
              409,
            );
          }
          throw new CommandRefusalError(
            detail
              ? `GitHub rejected creating "${prepared.requestedName}": ${detail}`
              : `GitHub rejected creating "${prepared.requestedName}" (HTTP 422). Check the repository name and GitHub permissions, then try again.`,
            400,
          );
        }
        if (error instanceof GitHubHttpError && error.status >= 400 && error.status < 500) {
          throw error;
        }
        if (error instanceof Error && /GitHub user authorization is required/i.test(error.message)) {
          throw new CommandRefusalError(
            'GitHub authorization is required to create a personal repository. Reconnect GitHub and try again.',
            403,
          );
        }
        if (error instanceof Error && /GitHub installation not found/i.test(error.message)) {
          throw new CommandRefusalError(
            'GitHub installation not found. Reconnect GitHub and try again.',
            404,
          );
        }
        throw new Error(
          'GitHub did not confirm whether the repository was created. Check Link existing to link it if it appeared, or try again.',
        );
      }
      const recordedCreated: RecordedCreatedRepository = {
        id: created.id,
        fullName: created.fullName,
        installationId: created.installationId,
        defaultBranch: created.defaultBranch,
        requestedName: prepared.requestedName,
      };
      // Durably record the exact created repository ID before linking so only this repo can be recovered if linking fails.
      await ctx.database.query(
        `UPDATE messages SET card=card || jsonb_build_object('createdRepository', $2::jsonb) WHERE id=$1 AND card->>'creatingToken'=$3 AND card->>'status'='open'`,
        [input.cardId, JSON.stringify(recordedCreated), lockToken],
      );
      try {
        const result = await ctx.database.transaction(async database => {
          const row = (await database.query<{ card: Record<string, unknown> | null }>(
            `SELECT card FROM messages WHERE id=$1 AND room_id=$2 AND card_type='repository-onboarding' FOR UPDATE`,
            [input.cardId, input.roomId])).rows[0];
          const card = readRepositoryOnboardingCard(row?.card);
          if (!card || card.requesterId !== viewerId) throw new Error('repository card access denied');
          if (card.status !== 'open' || row?.card?.creatingToken !== lockToken) {
            throw new CommandRefusalError(
              `Repository "${created.fullName}" was created, but this card changed before linking. Tap Link existing to attach it.`,
              409,
            );
          }
          const service = new PhoneService(database, ctx.publicOrigin, ctx.github, ctx.sendPushTest, ctx.live, true);
          await service.setRepository({ roomId: input.roomId, key: `github:${created.id}`, name: created.fullName,
            remote: `git://github.com/${created.fullName}`, targetBranch: created.defaultBranch,
            githubInstallationId: created.installationId }, viewerId);
          await database.query(
            `UPDATE messages SET card=(card - 'creatingToken' - 'creatingAt' - 'createdRepository') || $2::jsonb,version=version+1 WHERE id=$1`,
            [
              input.cardId,
              JSON.stringify({
                status: 'settled',
                resolution: 'created',
                selected: prepared.requestedName,
                repository: created.fullName,
                defaultName: prepared.requestedName,
              }),
            ],
          );
          return { linkedNow: true, result: { selected: prepared.requestedName } };
        });
        if (result.linkedNow) await bootstrapLinkedEmptyRepository(ctx, input.roomId);
        ctx.live?.publish({ type: 'invalidate', roomId: input.roomId, reason: 'message' });
        return result.result;
      } catch (error) {
        await releaseCreateLock();
        throw error;
      }
    }

    let followup: { roomId: string; agentId: string; requesterId: string; kind: 'repository' } | undefined;
    let linkedNow = false;
    // Serialize taps and make a retried response return the committed selection.
    const result = await ctx.database.transaction(async database => {
      const row = (await database.query<{ card: Record<string, unknown> | null }>(
        `SELECT card FROM messages WHERE id=$1 AND room_id=$2 AND card_type='repository-onboarding' FOR UPDATE`,
        [input.cardId, input.roomId])).rows[0];
      const card = readRepositoryOnboardingCard(row?.card);
      if (!card || card.requesterId !== viewerId) throw new Error('repository card access denied');
      if (input.action === 'refresh') followup = { roomId: input.roomId, agentId: card.agentId, requesterId: viewerId, kind: 'repository' };
      if (card.status === 'settled') { followup = undefined; return { selected: card.selected }; }
      if (input.action === 'link' && hasActiveCreateLock(row?.card)) {
        throw new CommandRefusalError('A repository creation is already in progress for this card. Wait for it to finish.', 409);
      }
      if (input.action === 'refresh') {
        await phoneRequireGitHub(ctx).refresh(viewerId);
        return {};
      }
      const service = new PhoneService(database, ctx.publicOrigin, ctx.github, ctx.sendPushTest, ctx.live, true);
      if (input.action === 'install' || input.action === 'organization') {
        if (!input.redirectUri) throw new Error('installation return is required');
        if (input.action === 'install') {
          await phoneRequireGitHub(ctx).refresh(viewerId);
          const covered = (await database.query(
            `SELECT installation_id FROM github_installations WHERE owner_id=$1 AND status='active' LIMIT 1`,
            [viewerId],
          )).rows.length > 0;
          if (covered) {
            followup = { roomId: input.roomId, agentId: card.agentId, requesterId: viewerId, kind: 'repository' };
            return { openPicker: true };
          }
        }
        return phoneRequireGitHub(ctx).beginInstallation(viewerId, {
          redirectUri: input.redirectUri, selectTarget: input.action === 'organization',
        });
      }
      if (input.action !== 'link') throw new Error('invalid repository action');
      const repository = card.repositories.find(r => r.id === input.repositoryId);
      if (!repository) throw new Error('repository not found');
      await service.setRepository({ roomId: input.roomId, key: `github:${repository.id}`, name: repository.fullName,
        remote: `git://github.com/${repository.fullName}`, targetBranch: repository.defaultBranch,
        githubInstallationId: repository.installationId }, viewerId);
      const selected = String(input.repositoryId);
      await database.query(`UPDATE messages SET card=(card - 'creatingToken' - 'creatingAt' - 'createdRepository') || $2::jsonb,version=version+1 WHERE id=$1`, [
        input.cardId,
        JSON.stringify({
          status: 'settled',
          resolution: 'linked',
          selected,
          repository: repository.fullName,
        }),
      ]);
      linkedNow = true;
      return { selected };
    });
    if (linkedNow) await bootstrapLinkedEmptyRepository(ctx, input.roomId);
    if (followup) await ctx.database.transaction(db => postRepositoryOnboarding(db, ctx.github, followup!));
    ctx.live?.publish({ type: 'invalidate', roomId: input.roomId, reason: 'message' });
    return result;
  }


  export async function phoneAnswerChoice(ctx: PhoneContext, input: Input<'answerChoice'>, viewerId: string) {
    return ctx.database.transaction(async database => {
      const result = await ((await settleWorkflowGate(database, {
        choiceId: input.choiceId, optionId: input.optionId, viewerId, note: input.note,
      })) ?? answerRoomChoice(database, { choiceId: input.choiceId, optionId: input.optionId, viewerId, note: input.note }));
      return result;
    });
  }

  export async function phoneSkipChoice(ctx: PhoneContext, input: Input<'skipChoice'>, viewerId: string) {
    return ctx.database.transaction(
      async (database) => {
        const result = await (
          (await settleWorkflowGate(database, { choiceId: input.choiceId, viewerId, skip: true })) ??
          skipRoomChoice(database, { choiceId: input.choiceId, viewerId }));
        return result;
      },
    );
  }
