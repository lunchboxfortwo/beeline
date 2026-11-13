import { wall, WallRefusal } from '@beeline/api-contract/daemon';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { typedMentionHandles } from '../message-mentions.js';
import { endAgentTurn } from '../agent-turn-end.js';
import { cleanVoiceReply } from '../voice-reply.js';
import { queueDatabaseWork } from '../database-work-queue.js';
import { routeAgentResult } from '../agent-command.js';
import { authorizeCommandOutput } from '../agent-command-route-agent-result.js';
import { randomBytes } from 'node:crypto';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { lockCornerLifecycle } from '../corner-lifecycle.js';
import { LiveHub, type LiveEvent } from '../live.js';
import { precomputeInstitutionalQueryEmbedding } from '../institutional-memory-shadow.js';
import type { AfterCommit } from '../institutional-memory-embeddings.js';
import type { DaemonContext } from './context.js';
import { Input, OwnedModelClaimCapability, Output, CORNER_REACH_OPERATIONS, AccessDeniedError, CORNER_CLEANUP_OPERATIONS, seconds } from './values.js';
import { daemonAccess, daemonReviewSourceAccess } from './access.js';
import { daemonReach, daemonWriteResult } from './corner-messages.js';
import { daemonPostRoomMessage } from './messages.js';
import { daemonReconcileZeroCheckWorkerCompletion } from './corner-completion.js';
import { createDaemonCommandService } from '../daemon-service.js';
import { daemonReport } from './corner-reports.js';
import { daemonAuthorizeScopedGrant } from './grants.js';
import { daemonExecuteOperation } from './operations.js';
import { daemonTurnReceipt } from './turn-receipts.js';


  /** One request from an agent: the membership wall, then the queue item the
   * call serves (its `requestId`), then the operation. An answer for an item
   * that is already done returns the stored result. */
  export async function daemonExecute<Name extends keyof DaemonOperationMap>(ctx: DaemonContext,
    name: Name,
    input: Input<Name>,
    authenticatedAgentId: string,
    modelClaim?: OwnedModelClaimCapability,
  ): Promise<Output<Name>> {
    // Diagnostics are written after the answer and never change the item.
    if (name === 'postAgentTurnReceipt') {
      await daemonAccess(ctx, (input as Input<'postAgentTurnReceipt'>).roomId, authenticatedAgentId);
      await daemonTurnReceipt(ctx, input as Input<'postAgentTurnReceipt'>, authenticatedAgentId)
        .catch((error: unknown) => console.warn('[turn-receipt] diagnostics dropped', error instanceof Error ? error.message : String(error)));
      return daemonWriteResult(ctx) as Output<Name>;
    }
    const turnWrites = new Set([
      'postVaultSaveCard',
      'postAgentAvatar',
      'postRoomMessage',
      'postCornerMessage',
      'postAgentAttachment',
      'postAgentDraft',
      'postAgentThought',
      'retractAgentLiveOutput',
      'markAgentTurnSilent',
      'postAgentActivity',
      'postSquireApproval',
      'postComputerSession',
      'postSquireLoginWall',
      'createLinkSpendRequest',
      'retrieveLinkSpendRequest',
      'order',
      'stopAgentTurn',
      'report',
      'createCorner',
      'reviseCornerBrief',
      'postRoomEvent',
      'requestAgentGrant',
      'createAgentSubscription',
      'deleteAgentSubscription',
      'setAgentWakePaused',
      'authorizeSquireCall',
      'authorizeResourceCall',
      'authorizeRepositoryCall',
      'authorizeHostCall',
      'getWalletToolState',
      'getWalletToolBalance',
      'getWalletToolChains',
      'getWalletToolHistory',
      'getWalletToolQuote',
      'walletPay',
      'walletSwap',
      'walletContractCall',
      'walletSignTypedData',

      'listTurnAgentGrants',
      'offerConnector',
      'connectMcpServer',
      'connectApp',
      'connect',
      'listAppTools',
      'executeAppTool',
      'postRepositoryOnboarding',
      'postRoomInvite',
      'postStarterWelcome',
      'postStarterGame',
      'askRoomChoice',
      'openRoomPoll',
      'renameCorner',
      'getInstitutionalContext',
      'saveInstitutionalMemory',
      'updateInstitutionalMemory',
      'deleteInstitutionalMemory',
      'reportInstitutionalMemoryUsed',
      'searchInstitutionalMemory',
      'searchInstitutionalHistory',
      'getRoomMessage',
      'loadWorkspaceSkill',
      'saveSkill',
      'deleteSkill',
      'saveWorkflow',
      'startWorkflow',
      'cancelWorkflowRun',
      'handoff',
      'archiveWorkflow',
      'assignWorkflowRole',
      'reportFeedback',
      'notifyFeedbackFixed',
      'sendOperatorSystemDm',
      'readOperatorSystemDm',
    ]);
    input = { ...input };
    const candidate = input as Record<string, unknown>;
    if (typeof candidate.agentId === 'string' && candidate.agentId !== authenticatedAgentId)
      throw wall('credentials', 'daemon token does not own requested agent');
    // Command writes authorize their source before the operation checks its
    // target. Lifecycle and read operations authorize the addressed corner,
    // independently of any source context the helper also supplies.
    const scopedRoom =
      CORNER_REACH_OPERATIONS.has(name) && typeof candidate.cornerId === 'string'
        ? candidate.cornerId
        : typeof candidate.roomId === 'string'
          ? candidate.roomId
          : typeof candidate.cornerId === 'string'
            ? candidate.cornerId
            : undefined;
    const addressedRoom = !turnWrites.has(name) && typeof candidate.cornerId === 'string'
      ? candidate.cornerId : scopedRoom;
    const walletCall = [
      'getWalletToolState',
      'getWalletToolBalance',
      'getWalletToolChains',
      'getWalletToolHistory',
      'getWalletToolQuote',
      'walletPay',
      'walletSwap',
      'walletContractCall',
      'walletSignTypedData',
    ].includes(name);
    if (walletCall && !scopedRoom) throw wall('credentials', 'wallet access requires an active Room command');
    let cornerReviewer = false;
    let isCorner = false;
    let privateCommand = false;
    let voiceAgentName: string | null | undefined;
    if (addressedRoom && name !== 'ensureAgentMembership' && !ctx.commandTransaction)
      ({ cornerReviewer, isCorner, privateCommand, voiceAgentName } = await daemonAccess(ctx, addressedRoom, authenticatedAgentId, candidate.requestId ?? candidate.turnId).catch(
        (error: unknown) => {
          if ((error instanceof AccessDeniedError || error instanceof WallRefusal && error.kind === 'membership' && error.status < 500) &&
              (name === 'getRoomConversation' || name === 'getRoomMessage'))
            return daemonReviewSourceAccess(ctx, addressedRoom, authenticatedAgentId).then(() => ({
              cornerReviewer: false, isCorner: false, privateCommand: false, voiceAgentName: null,
            })).catch((sourceError: unknown) => {
              if (sourceError instanceof AccessDeniedError || sourceError instanceof WallRefusal && sourceError.kind === 'membership' && sourceError.status < 500)
                return daemonReach(ctx, addressedRoom, authenticatedAgentId).then(() => ({
                  cornerReviewer: false, isCorner: true, privateCommand: false, voiceAgentName: null,
                }));
              throw wall('membership', sourceError instanceof Error ? sourceError : { message: String(sourceError), status: 503 });
            });
          // Reachable corner operations also admit a parent Room member.
          if ((error instanceof AccessDeniedError || error instanceof WallRefusal && error.kind === 'membership' && error.status < 500) &&
              (CORNER_REACH_OPERATIONS.has(name) || CORNER_CLEANUP_OPERATIONS.has(name)))
            return daemonReach(ctx, addressedRoom, authenticatedAgentId).then(() => ({
              cornerReviewer: false,
              isCorner: true,
              privateCommand: false,
              voiceAgentName: null,
            }));
          throw wall('membership', error instanceof Error ? error : { message: String(error), status: 503 });
        },
      ));
    // Repository tools resolve provider facts themselves; an answer never
    // depends on a GitHub read or a successful token refresh.
    if (voiceAgentName && typeof candidate.text === 'string')
      candidate.text = cleanVoiceReply(candidate.text, voiceAgentName);

    if (
      !ctx.commandTransaction &&
      scopedRoom &&
      name === 'postRoomMessage' &&
      candidate.relay === undefined &&
      typedMentionHandles(String(candidate.text ?? '')).size === 0 &&
      typeof candidate.replyToMessageId !== 'string' &&
      // A reply naming nobody normally has nothing to route, which is the whole
      // reason for this shorter write: one autocommit statement that commits
      // and publishes on its own. A corner reviewer's reply is the exception —
      // it hands the branch back — and that handoff must not be a second write
      // AFTER the commit. Losing it there is permanent: the verdict is durable,
      // its command output authority is spent, and no retry can re-create the
      // turn, which is exactly the stall this handback exists to remove. So the
      // reviewer takes the transactional path below, where the verdict and the
      // handoff commit together or not at all.
      !cornerReviewer &&
      !privateCommand &&
      // A same-turn post needs the transactional path: insert the ordinary
      // reply, then demote repeated prose before any reader can observe it.
      !(await ctx.database.query(
        `SELECT 1 FROM messages WHERE room_id=$1 AND author_id=$2 AND request_id=$3
           AND presentation='message' AND deleted_at IS NULL LIMIT 1`,
        [scopedRoom, authenticatedAgentId, candidate.requestId],
      )).rowCount
    ) {
      const output = await queueDatabaseWork(ctx.database, `turn:${scopedRoom}:${authenticatedAgentId}`, () => daemonPostRoomMessage(ctx,
        input as Input<'postRoomMessage'>,
        authenticatedAgentId,
        true,
      ));
      if (isCorner) void daemonReconcileZeroCheckWorkerCompletion(ctx, scopedRoom!, authenticatedAgentId)
        .catch(error => console.error('[daemon] post-answer reconciliation failed', error));
      return output as Output<Name>;
    }
    if (
      !ctx.commandTransaction && scopedRoom && turnWrites.has(name) &&
      (name !== 'getRoomMessage' || candidate.requestId !== undefined)
    ) {
      const writeStartedAt = Date.now();
      const events: LiveEvent[] = [];
      const buffered = new LiveHub();
      buffered.publish = (event) => {
        events.push(event);
      };
      const memoryEmbed = !ctx.institutionalMemoryShadow.live
        ? undefined
        : name === 'getInstitutionalContext'
          ? await precomputeInstitutionalQueryEmbedding(ctx.database, {
              kind: 'context',
              roomId: scopedRoom,
              agentId: authenticatedAgentId,
              requestId: String(candidate.requestId ?? candidate.turnId ?? ''),
            })
          : name === 'searchInstitutionalMemory'
            ? await precomputeInstitutionalQueryEmbedding(ctx.database, {
                kind: 'search',
                query: typeof candidate.query === 'string' ? candidate.query : '',
              })
            : undefined;
      const committedTasks: Parameters<AfterCommit>[0][] = [];
      const output = await queueDatabaseWork(ctx.database, `turn:${scopedRoom}:${authenticatedAgentId}`, () => ctx.database.transaction(async (db) => {
        if (name === 'createCorner' || name === 'reviseCornerBrief') await lockCornerLifecycle(db, scopedRoom);
        const requestId = candidate.requestId ?? candidate.turnId;
        const command = await authorizeCommandOutput(db, scopedRoom, authenticatedAgentId, requestId);
        // An answer or silence for an item that is already done is a resend:
        // return the stored result instead of writing again.
        if (command.state === 'complete' && name === 'markAgentTurnSilent')
          return daemonWriteResult(ctx) as Output<Name>;
        if (command.state === 'complete' && name === 'postRoomMessage' && candidate.presentation !== 'card') {
          const saved = command.result_message_id ? (await db.query<{ id: string; created_at: Date }>(
            `SELECT id,created_at FROM messages WHERE id=$1
             UNION ALL SELECT id,created_at FROM agent_commands WHERE id=$1 LIMIT 1`, [command.result_message_id])).rows[0] : undefined;
          return (saved ? { id: saved.id, createdAt: seconds(saved.created_at) } : daemonWriteResult(ctx)) as Output<Name>;
        }
        // Private inputs keep the return address recorded with the item.
        // A refused delivery keeps both the queue item and the helper's answer.
        const privateAnswer = command.private_payload && (command.private_payload.kind !== 'lifecycle' ||
          command.private_payload.authorId !== SYSTEM_IDENTITY_ID);
        if (privateAnswer && (name === 'postRoomMessage' || ([
          'postAgentDraft', 'postAgentThought', 'postAgentActivity',
        ].includes(name) && !(await db.query(
          `SELECT 1 FROM corner_facts WHERE corner_id=$1`, [scopedRoom])).rowCount))) {
          if (name !== 'postRoomMessage') return daemonWriteResult(ctx) as Output<Name>;
          const text = String(candidate.text ?? '').trim();
          if (text) {
            const reported = await daemonReport({ ...ctx, afterCommit: task => { committedTasks.push(task); } }, text, authenticatedAgentId, command, db, true);
            if ('delivered' in reported && reported.delivered === false)
              throw wall('membership', 'commander is no longer a member of the return address');
            await endAgentTurn(db, command, 'complete', null, reported.id);
            return reported as Output<Name>;
          }
        }
        const scoped = createDaemonCommandService(ctx.dependencies, {
          database: db, live: buffered, authorizedCommand: command,
          starterOnboarding: ctx.starterOnboarding, memoryEmbed,
          afterCommit: (task) => { committedTasks.push(task); },
        });
        let result: Output<Name> = await scoped.execute(name, input, authenticatedAgentId);
        if (name === 'requestAgentGrant') {
          await db.query(
            `UPDATE agent_grants SET command_id=$2 WHERE id=$1 AND command_id IS NULL`,
            [(result as { grantId: string }).grantId, command.id],
          );
        }
        if (
          [
            'authorizeSquireCall',
            'authorizeResourceCall',
            ...[
              'getWalletToolState',
              'getWalletToolBalance',
              'getWalletToolChains',
              'getWalletToolHistory',
              'getWalletToolQuote',
              'walletPay',
              'walletSwap',
              'walletContractCall',
              'walletSignTypedData',
            ],
          ].includes(name) &&
          ['pending', 'permission-required'].includes(
            (result as { status?: string }).status ?? '',
          ) &&
          (result as { grantId?: string }).grantId
        ) {
          await db.query(
            `UPDATE agent_grants SET command_id=$2 WHERE id=$1 AND command_id IS NULL`,
            [(result as { grantId: string }).grantId, command.id],
          );
        }
        if (name === 'offerConnector' || name === 'postSquireLoginWall') {
          // The accept's (or the reconnect's own) hidden `connector-offer-decided`
          // line resumes THIS command's turn, the way a grant decision resumes
          // its ask. A `postSquireLoginWall` call that produced no card (an
          // `awaiting_human` wall, or no connected connector) has no offerId.
          const offerId = (result as { offerId?: string }).offerId;
          if (offerId)
            await db.query(
              `UPDATE connector_offers SET command_id=$2 WHERE id::text=$1 AND command_id IS NULL`,
              [offerId, command.id],
            );
        }
        if (name === 'postRoomMessage' && candidate.relay === undefined) {
          // routeAgentResult reads the reply's own text for the agents it hands
          // work to, so there is nothing to pre-check here.
          const message = result as unknown as { id: string };
          await routeAgentResult(db, command, message.id);
        }
        return result;
      }));
      for (const event of events) {
        if (event.type !== 'invalidate' || !event.committedRow) {
          ctx.live.publish(event);
        } else {
        const emittedAt = Date.now();
        ctx.live.publish({
          ...event,
          trace: {
            id: randomBytes(16).toString('hex'),
            databaseAt: event.committedRow.row.created_at.getTime(),
            emittedAt,
            startedAt: event.committedRow.startedAt ?? writeStartedAt,
          },
        });
        }
      }
      for (const task of committedTasks) void Promise.resolve().then(() => task(ctx.database))
        .catch(error => console.error('[daemon] post-commit task failed', error));
      if (name === 'postRoomMessage' && candidate.relay === undefined && isCorner)
        void daemonReconcileZeroCheckWorkerCompletion(ctx, scopedRoom!, authenticatedAgentId)
          .catch(error => console.error('[daemon] post-answer reconciliation failed', error));
      return output;
    }
    if (walletCall && ctx.commandTransaction) {
      const permission = await daemonAuthorizeScopedGrant(ctx,
        input as Input<'authorizeSquireCall'>,
        authenticatedAgentId,
        'mcp',
        'wallet',
      );
      if (!permission.allowed)
        return { status: 'permission-required', grantId: permission.grantId } as Output<Name>;
    }
    return daemonExecuteOperation(ctx, name, input, authenticatedAgentId, modelClaim, candidate, scopedRoom);

  }
