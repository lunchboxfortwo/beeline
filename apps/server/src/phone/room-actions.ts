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

  export async function phoneActOnRepositoryCard(ctx: PhoneContext, input: Input<'actOnRepositoryCard'>, viewerId: string): Promise<Output<'actOnRepositoryCard'>> {
    if (['create', 'link', 'install', 'organization'].includes(input.action)) await phoneRequireRoomWorkspaceManager(ctx, input.roomId, viewerId);
    else {
      if (!(await phoneHasRoomAccess(ctx, input.roomId, viewerId))) throw new Error('room access denied');
      await phoneRequireTopLevelChatMember(ctx, input.roomId, viewerId);
    }
    if (input.action === 'create') {
      const prepared = await ctx.database.transaction(async database => {
        const row = (await database.query<{ card: Record<string, unknown> | null }>(
          `SELECT card FROM messages WHERE id=$1 AND room_id=$2 AND card_type='repository-onboarding' FOR UPDATE`,
          [input.cardId, input.roomId])).rows[0];
        const card = readRepositoryOnboardingCard(row?.card);
        if (!card || card.requesterId !== viewerId) throw new Error('repository card access denied');
        if (card.status === 'settled') return { done: true as const, result: { selected: card.selected } };
        const requestedName = input.name !== undefined ? validateRepositoryName(input.name) : card.defaultName;
        if (!card.installationId) throw new Error('Install Beeline on all personal repositories first');
        const priorAttempt = typeof row?.card?.creatingName === 'string' ? row.card.creatingName : undefined;
        const retryOfAttempt = Boolean(priorAttempt && priorAttempt.toLowerCase() === requestedName.toLowerCase());
        const service = new PhoneService(database, ctx.publicOrigin, ctx.github, ctx.sendPushTest, ctx.live, true);
        await phoneRequireGitHub(ctx).refresh(viewerId);
        const available = await service.listRepositories(viewerId);
        const existing = available.repositories.find(r =>
          r.installationId === card.installationId && r.fullName.split('/')[1]?.toLowerCase() === requestedName.toLowerCase(),
        );
        if (existing) {
          if (retryOfAttempt && existing.private) {
            await service.setRepository({ roomId: input.roomId, key: `github:${existing.id}`, name: existing.fullName,
              remote: `git://github.com/${existing.fullName}`, targetBranch: existing.defaultBranch,
              githubInstallationId: existing.installationId }, viewerId);
            await database.query(`UPDATE messages SET card=(card - 'creatingName') || $2::jsonb,version=version+1 WHERE id=$1`, [
              input.cardId,
              JSON.stringify({
                status: 'settled',
                resolution: 'created',
                selected: requestedName,
                repository: existing.fullName,
                defaultName: requestedName,
              }),
            ]);
            return { done: true as const, result: { selected: requestedName } };
          }
          if (retryOfAttempt) {
            await database.query(`UPDATE messages SET card=card - 'creatingName' WHERE id=$1 AND card->>'status'='open'`, [input.cardId]);
          }
          throw new CommandRefusalError(
            `Repository "${existing.fullName}" already exists. Choose a different name or tap Link existing.`,
            409,
          );
        }
        // Record this card's create attempt before calling GitHub so only a retry of this attempt can recover a private repo.
        await database.query(`UPDATE messages SET card=card || jsonb_build_object('creatingName', $2::text) WHERE id=$1`, [
          input.cardId, requestedName,
        ]);
        return { done: false as const, installationId: card.installationId, requestedName };
      });
      if (prepared.done) {
        ctx.live?.publish({ type: 'invalidate', roomId: input.roomId, reason: 'message' });
        return prepared.result;
      }
      let created;
      try {
        created = await phoneRequireGitHub(ctx).createRepository(viewerId, {
          installationId: prepared.installationId, name: prepared.requestedName, private: true,
        }, ctx.database);
      } catch (error) {
        if (error instanceof GitHubHttpError && error.status >= 400 && error.status < 500) {
          await ctx.database.query(`UPDATE messages SET card=card - 'creatingName' WHERE id=$1 AND card->>'status'='open'`, [input.cardId]);
          if (error.status === 422) {
            throw new CommandRefusalError(
              `Repository "${prepared.requestedName}" already exists on GitHub. Choose a different name or tap Link existing.`,
              409,
            );
          }
        }
        throw error;
      }
      const result = await ctx.database.transaction(async database => {
        const row = (await database.query<{ card: unknown }>(
          `SELECT card FROM messages WHERE id=$1 AND room_id=$2 AND card_type='repository-onboarding' FOR UPDATE`,
          [input.cardId, input.roomId])).rows[0];
        const card = readRepositoryOnboardingCard(row?.card);
        if (!card || card.requesterId !== viewerId) throw new Error('repository card access denied');
        if (card.status === 'settled') return { selected: card.selected };
        const service = new PhoneService(database, ctx.publicOrigin, ctx.github, ctx.sendPushTest, ctx.live, true);
        await service.setRepository({ roomId: input.roomId, key: `github:${created.id}`, name: created.fullName,
          remote: `git://github.com/${created.fullName}`, targetBranch: created.defaultBranch,
          githubInstallationId: created.installationId }, viewerId);
        await database.query(`UPDATE messages SET card=(card - 'creatingName') || $2::jsonb,version=version+1 WHERE id=$1`, [
          input.cardId,
          JSON.stringify({
            status: 'settled',
            resolution: 'created',
            selected: prepared.requestedName,
            repository: created.fullName,
            defaultName: prepared.requestedName,
          }),
        ]);
        return { selected: prepared.requestedName };
      });
      ctx.live?.publish({ type: 'invalidate', roomId: input.roomId, reason: 'message' });
      return result;
    }

    let followup: { roomId: string; agentId: string; requesterId: string; kind: 'repository' } | undefined;
    // Serialize taps and make a retried response return the committed selection.
    const result = await ctx.database.transaction(async database => {
      const row = (await database.query<{ card: unknown }>(
        `SELECT card FROM messages WHERE id=$1 AND room_id=$2 AND card_type='repository-onboarding' FOR UPDATE`,
        [input.cardId, input.roomId])).rows[0];
      const card = readRepositoryOnboardingCard(row?.card);
      if (!card || card.requesterId !== viewerId) throw new Error('repository card access denied');
      if (input.action === 'refresh') followup = { roomId: input.roomId, agentId: card.agentId, requesterId: viewerId, kind: 'repository' };
      if (card.status === 'settled') { followup = undefined; return { selected: card.selected }; }
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
      await database.query(`UPDATE messages SET card=(card - 'creatingName') || $2::jsonb,version=version+1 WHERE id=$1`, [
        input.cardId,
        JSON.stringify({
          status: 'settled',
          resolution: 'linked',
          selected,
          repository: repository.fullName,
        }),
      ]);
      return { selected };
    });
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
