import { phoneIdentity as identity } from '../phone-identity.js';
import { postRepositoryOnboarding } from '../repository-onboarding.js';
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
    let followup: { roomId: string; agentId: string; requesterId: string; kind: 'repository' | 'starters' } | undefined;
    // Serialize taps and make a retried response return the committed selection.
    const result = await ctx.database.transaction(async database => {
      const row = (await database.query<{ card: unknown }>(
        `SELECT card FROM messages WHERE id=$1 AND room_id=$2 AND card_type='repository-onboarding' FOR UPDATE`,
        [input.cardId, input.roomId])).rows[0];
      const card = readRepositoryOnboardingCard(row?.card);
      if (!card || card.requesterId !== viewerId) throw new Error('repository card access denied');
      if (['create', 'link', 'refresh'].includes(input.action)) followup = { roomId: input.roomId, agentId: card.agentId, requesterId: viewerId, kind: input.action === 'refresh' ? 'repository' : 'starters' };
      if (card.status === 'settled') { followup = undefined; return { selected: card.selected }; }
      const requestedSelection = input.action === 'create' ? card.defaultName : String(input.repositoryId);
      if (['create', 'link'].includes(input.action) && card.selected && card.selected !== requestedSelection)
        throw new Error('This card already linked a repository. Retry the same option or ask for a new card.');
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
      if (input.action === 'starter') {
        if (card.kind !== 'starters') throw new Error('this card does not offer starter tasks');
        const starter = card.starters.find(s => s.id === input.starterId);
        if (!starter) throw new Error('starter not found');
        const current = (await database.query<{ repository_name: string }>(
          `SELECT repository_name FROM rooms WHERE id=$1`, [input.roomId])).rows[0];
        if (current?.repository_name !== card.repository) throw new Error('Repository changed. Ask for fresh starters.');
        const agent = (await database.query<{ handle: string }>(`SELECT beeline_room_handle(id,$2) handle FROM identities WHERE id=$1`, [card.agentId,input.roomId])).rows[0];
        if (!agent?.handle) throw new Error('The offering agent is no longer available');
        await service.sendMessage({ roomId: input.roomId,
          text: `@${agent.handle} ${starter.title}\n${starter.task}\nStart this task now in a repository corner with a complete brief. Use this selection as approval. Keep the normal checks, independent review and merge gate.`,
          mentions: [card.agentId] }, viewerId);
      } else {
        if (card.kind !== 'repository' || !['create', 'link'].includes(input.action)) throw new Error('invalid repository action');
        let repository;
        if (input.action === 'create') {
          if (!card.installationId) throw new Error('Install Beeline on all personal repositories first');
          // The per-card name lets a retry recover a repository created before a lost response.
          await phoneRequireGitHub(ctx).refresh(viewerId);
          const available = await service.listRepositories(viewerId);
          repository = available.repositories.find(r => r.installationId === card.installationId && r.fullName.split('/')[1] === card.defaultName);
          repository ??= await phoneRequireGitHub(ctx).createRepository(viewerId, {
            installationId: card.installationId, name: card.defaultName, private: true,
          }, database);
        } else repository = card.repositories.find(r => r.id === input.repositoryId);
        if (!repository) throw new Error('repository not found');
        await service.setRepository({ roomId: input.roomId, key: `github:${repository.id}`, name: repository.fullName,
          remote: `git://github.com/${repository.fullName}`, targetBranch: repository.defaultBranch,
          githubInstallationId: repository.installationId }, viewerId);
      }
      const selected = input.action === 'starter' ? input.starterId! : input.action === 'create' ? card.defaultName : String(input.repositoryId);
      await database.query(`UPDATE messages SET card=card || $2::jsonb,version=version+1 WHERE id=$1`,
        [input.cardId, JSON.stringify({ status: followup ? 'open' : 'settled', selected })]);
      return { selected };
    });
    if (followup) {
      await ctx.database.transaction(db => postRepositoryOnboarding(db, ctx.github, followup!));
      if (followup.kind === 'starters') await ctx.database.query(`UPDATE messages SET card=jsonb_set(card,'{status}','"settled"') WHERE id=$1`, [input.cardId]);
    }
    ctx.live?.publish({ type: 'invalidate', roomId: input.roomId, reason: 'message' });
    return result;
  }


  export async function phoneAnswerChoice(ctx: PhoneContext, input: Input<'answerChoice'>, viewerId: string) {
    return ctx.database.transaction(async database => {
      return (await settleWorkflowGate(database, {
        choiceId: input.choiceId, optionId: input.optionId, viewerId, note: input.note,
      })) ?? answerRoomChoice(database, { choiceId: input.choiceId, optionId: input.optionId, viewerId, note: input.note });
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
