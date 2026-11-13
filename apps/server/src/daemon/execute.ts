import { typedMentionHandles } from '../message-mentions.js';
import { endAgentTurn } from '../agent-turn-end.js';
import { cleanVoiceReply } from '../voice-reply.js';
import { queueDatabaseWork } from '../database-work-queue.js';
import { CommandRefusalError } from '../commander.js';
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
      throw new Error('daemon token does not own requested agent');
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
    if (walletCall && !scopedRoom) throw new Error('wallet access requires an active Room command');
    let cornerReviewer = false;
    let isCorner = false;
    let privateCommand = false;
    let voiceAgentName: string | null | undefined;
    if (addressedRoom && name !== 'ensureAgentMembership' && !ctx.commandTransaction)
      ({ cornerReviewer, isCorner, privateCommand, voiceAgentName } = await daemonAccess(ctx, addressedRoom, authenticatedAgentId, candidate.requestId ?? candidate.turnId).catch(
        (error: unknown) => {
          if (error instanceof AccessDeniedError &&
              (name === 'getRoomConversation' || name === 'getRoomMessage'))
            return daemonReviewSourceAccess(ctx, addressedRoom, authenticatedAgentId).then(() => ({
              cornerReviewer: false, isCorner: false, privateCommand: false, voiceAgentName: null,
            })).catch((sourceError: unknown) => {
              if (sourceError instanceof AccessDeniedError)
                return daemonReach(ctx, addressedRoom, authenticatedAgentId).then(() => ({
                  cornerReviewer: false, isCorner: true, privateCommand: false, voiceAgentName: null,
                }));
              throw sourceError;
            });
          // Reachable corner operations also admit a parent Room member.
          if (error instanceof AccessDeniedError &&
              (CORNER_REACH_OPERATIONS.has(name) || CORNER_CLEANUP_OPERATIONS.has(name)))
            return daemonReach(ctx, addressedRoom, authenticatedAgentId).then(() => ({
              cornerReviewer: false,
              isCorner: true,
              privateCommand: false,
              voiceAgentName: null,
            }));
          throw error;
        },
      ));
    // Provider reads happen before the command transaction. Reports may be
    // delivered in the commander's Room, so refresh their origin corners too.
    if (!ctx.commandTransaction && scopedRoom && ctx.github) {
      if (isCorner && !cornerReviewer && name === 'report' && candidate.status === 'done') {
        await ctx.github.resolveUnregisteredCornerPullRequest(scopedRoom, authenticatedAgentId);
      } else if (isCorner && (['order', 'report', 'postCornerMessage'].includes(name) ||
        name === 'postRoomMessage' && candidate.relay === undefined)) {
        await ctx.github.refreshCornerReviewHead?.(scopedRoom);
      }
    }
    if (voiceAgentName && typeof candidate.text === 'string')
      candidate.text = cleanVoiceReply(candidate.text, voiceAgentName);
    if (name === 'postRoomMessage' && candidate.relay !== undefined)
      throw new CommandRefusalError('relay cards are retired; use order and report', 410);

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
      if (isCorner)
        await daemonReconcileZeroCheckWorkerCompletion(ctx, scopedRoom!, authenticatedAgentId);
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
            `SELECT id,created_at FROM messages WHERE id=$1`, [command.result_message_id])).rows[0] : undefined;
          return (saved ? { id: saved.id, createdAt: seconds(saved.created_at) } : daemonWriteResult(ctx)) as Output<Name>;
        }
        // A corner is the ordered work's own address: its viewers watch the
        // turn's live work there. Elsewhere the final prose of a private item
        // (an order or report) goes privately to its return route.
        if (command.private_payload && ((name === 'postRoomMessage' && (/^(blocked|failed|needs-decision):\s*\S/.test(String(candidate.text ?? '')) || !(await db.query(
          `SELECT 1 FROM corner_facts WHERE corner_id=$1`, [scopedRoom])).rowCount)) || ([
          'postAgentDraft', 'postAgentThought', 'postAgentActivity',
        ].includes(name) && !(await db.query(
          `SELECT 1 FROM corner_facts WHERE corner_id=$1`, [scopedRoom])).rowCount))) {
          if (name !== 'postRoomMessage') return daemonWriteResult(ctx) as Output<Name>;
          const text = String(candidate.text ?? '').trim();
          // A report the return route refuses (no commander left) is posted
          // here in the item's place instead of being dropped.
          const reported = !text || await db.query('SAVEPOINT private_answer')
            .then(() => daemonReport(ctx, text, authenticatedAgentId, command, db, true))
            .then(async result => { await db.query('RELEASE SAVEPOINT private_answer'); return !('delivered' in result && result.delivered === false); })
            .catch(async (error: unknown) => {
              if (!(error instanceof CommandRefusalError)) throw error;
              await db.query('ROLLBACK TO SAVEPOINT private_answer');
              return false;
            });
          if (reported) {
            await endAgentTurn(db, command, 'complete');
            return daemonWriteResult(ctx) as Output<Name>;
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
      for (const task of committedTasks) {
        try {
          await task(ctx.database);
        } catch (error) {
          console.error('[daemon] post-commit task failed', error);
        }
      }
      for (const event of events) {
        if (event.type !== 'invalidate' || !event.committedRow) {
          ctx.live.publish(event);
          continue;
        }
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
      if (name === 'postRoomMessage' && candidate.relay === undefined && isCorner) {
        await daemonReconcileZeroCheckWorkerCompletion(ctx,
          scopedRoom!,
          authenticatedAgentId,
        );
      }
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
