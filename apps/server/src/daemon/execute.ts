import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { WallRefusal } from '@beeline/api-contract/daemon';
import { createHash,randomBytes } from 'node:crypto';
import { authorizeCommandOutput } from '../agent-command-route-agent-result.js';
import { answerQueuedMessage } from '../agent-command.js';
import { sendOrder } from '../commander.js';
import { CornerAccessDatabase } from '../corner-access-database.js';
import { lockCornerLifecycle } from '../corner-lifecycle.js';
import { createDaemonCommandService } from '../daemon-service.js';
import { queueDatabaseWork } from '../database-work-queue.js';
import type { AfterCommit } from '../institutional-memory-embeddings.js';
import { precomputeInstitutionalQueryEmbedding } from '../institutional-memory-shadow.js';
import { LiveHub,type LiveEvent } from '../live.js';
import { cleanVoiceReply } from '../voice-reply.js';
import { daemonAccess,daemonReviewSourceAccess } from './access.js';
import type { DaemonContext } from './context.js';
import { daemonPostCornerMessage,daemonReach,daemonWriteResult } from './corner-messages.js';
import { daemonAuthorizeScopedGrant } from './grants.js';
import { recordReportedReviewApproval } from './corner-reads.js';
import { daemonPostRoomMessage } from './messages.js';
import { daemonExecuteOperation } from './operations.js';
import { daemonTurnReceipt } from './turn-receipts.js';
import { AccessDeniedError,CORNER_CLEANUP_OPERATIONS,CORNER_REACH_OPERATIONS,Input,Output } from './values.js';
import { modelText } from '../message-origin.js';
import { sendMessage,replyToMessage } from '../agent-messaging.js';


  /** One request from an agent: the membership wall, then the queue item the
   * call serves (its `requestId`), then the operation. An answer for an item
   * that is already done returns the stored result. */
  async function daemonExecuteTool<Name extends keyof DaemonOperationMap>(ctx: DaemonContext,
    name: Name,
    input: Input<Name>,
    authenticatedAgentId: string,
  ): Promise<Output<Name>> {
    // Diagnostics are written after the answer and never change the item.
    if (name === 'postAgentTurnReceipt') {
      await daemonAccess(ctx, (input as Input<'postAgentTurnReceipt'>).roomId, authenticatedAgentId);
      await daemonTurnReceipt(ctx, input as Input<'postAgentTurnReceipt'>, authenticatedAgentId)
        .catch((error: unknown) => console.warn('[turn-receipt] diagnostics dropped', error instanceof Error ? error.message : String(error)));
      return daemonWriteResult(ctx) as Output<Name>;
    }
    const turnWrites = new Set([
      'becomeImplementer',
      'postVaultSaveCard',
      'postAgentAvatar',
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
      'stopAgentTurn',
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
      'askOwnerQuestion',
      'addWorkNote',
      'attachToWorkItem',
      'updateWorkItem',
      'openRoomPoll',
      'renameCorner',
      'getInstitutionalContext',
      'saveInstitutionalMemory',
      'updateInstitutionalMemory',
      'deleteInstitutionalMemory',
      'reportInstitutionalMemoryUsed',
      'searchInstitutionalMemory',
      'loadWorkspaceSkill',
      'saveSkill',
      'deleteSkill',
      'saveWorkflow',
      'startWorkflow',
      'cancelWorkflowRun',
      'handoff',
      'archiveWorkflow',
      'assignWorkflowRole',
      'notifyFeedbackFixed',
      'sendOperatorSystemDm',
      'readOperatorSystemDm',
    ]);
    input = { ...input };
    const candidate = input as Record<string, unknown>;
    if (typeof candidate.agentId === 'string' && candidate.agentId !== authenticatedAgentId)
      throw new AccessDeniedError();
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
    if (walletCall && !scopedRoom) throw new AccessDeniedError();
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
              throw sourceError;
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
          throw error;
        },
      ));
    // Repository tools resolve provider facts themselves; an answer never
    // depends on a GitHub read or a successful token refresh.
    if (voiceAgentName && typeof candidate.text === 'string')
      candidate.text = cleanVoiceReply(candidate.text, voiceAgentName);

    if (
      !ctx.commandTransaction && scopedRoom && turnWrites.has(name)
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
        if (command.state === 'complete' && name === 'markAgentTurnSilent')
          return daemonWriteResult(ctx) as Output<Name>;
        // Drafts for private commands remain private; answers use the queue exit.
        if (command.private_payload && ['postAgentDraft', 'postAgentThought', 'postAgentActivity'].includes(name) &&
            !(await db.query('SELECT 1 FROM corner_facts WHERE corner_id=$1', [scopedRoom])).rowCount)
          return daemonWriteResult(ctx) as Output<Name>;
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
    return daemonExecuteOperation(ctx, name, input, authenticatedAgentId, candidate, scopedRoom);

  }


/** Conversational operations have one queue entry and one answer exit. */
export async function daemonExecute<Name extends keyof DaemonOperationMap>(ctx: DaemonContext,
  name: Name, input: Input<Name>, agentId: string,
  helperConnection?: { connectionId: string; epoch: number },
): Promise<Output<Name>> {
  const value = input as Record<string, unknown>;
  if (name==='message' || name==='reply') {
    const messageId=typeof value.transportRequestId==='string'
      ? createHash('sha256').update(`message:${agentId}:${value.transportRequestId}`).digest('hex') : undefined;
    if (name==='reply') {
      const request=input as Input<'reply'>;
      return replyToMessage(ctx.database,agentId,{...request,messageId},roomId=>{
        const refresh=()=>ctx.reconcileZeroCheckWorkerCompletion(roomId,agentId)
          .catch(error=>console.warn('[answer] optional lifecycle refresh omitted:',error));
        const background=CornerAccessDatabase.physical(ctx.database).backgroundWork;
        if (background) background.run(refresh); else void refresh();
      }) as Promise<Output<Name>>;
    }
    const request=input as Input<'message'>;
    const parent=request.requestId ? await authorizeCommandOutput(ctx.database,request.roomId,agentId,request.requestId) : undefined;
    return sendMessage(ctx.database,{route:{from:{agent:agentId,place:request.roomId},to:request.to},
      text:request.text,ask:request.ask,id:messageId,parent}) as Promise<Output<Name>>;
  }
  if (name === 'postRoomMessage' || name === 'report') {
    const saved=name==='postRoomMessage' ? await daemonPostRoomMessage(ctx,input as Input<'postRoomMessage'>,agentId) : await answerQueuedMessage(ctx.database, agentId, { roomId: String(value.roomId),
      requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
      text: String(value.text ?? ''), report: true, status: value.status,
      ask: typeof value.ask === 'string' ? value.ask : undefined,
    });
    if (!('answered' in saved) || saved.answered!==false) {
      const refresh=async()=>{
        await Promise.all([
          ctx.reconcileZeroCheckWorkerCompletion(String(value.roomId),agentId)
            .catch(error=>console.warn('[answer] optional lifecycle refresh omitted:',error)),
          name==='report' && value.status==='done' && /^\s*PASS\b/.test(String(value.text ?? '')) && typeof value.requestId==='string'
            ? recordReportedReviewApproval(ctx,agentId,value.requestId)
              .catch(error=>console.warn('[answer] optional reviewer approval omitted:',error)) : Promise.resolve(),
        ]);
      };
      const background=CornerAccessDatabase.physical(ctx.database).backgroundWork;
      if (background) background.run(refresh); else void refresh();
    }
    return saved as Output<Name>;
  }
  if (name === 'postCornerMessage' || name === 'order') {
    const parent = typeof value.requestId === 'string' ? (await ctx.database.query<import('../agent-command.js').CommandRow>(
      `SELECT * FROM agent_commands WHERE room_id::text=$1 AND agent_id=$2 AND turn_request_id=$3
       ORDER BY created_at DESC,id DESC LIMIT 1`, [String(value.roomId), agentId, value.requestId])).rows[0] : undefined;
    if (name === 'postCornerMessage')
      return daemonPostCornerMessage({ ...ctx, authorizedCommand: parent }, input as Input<'postCornerMessage'>, agentId) as Promise<Output<Name>>;
    return sendOrder(ctx.database, parent!, agentId, String(value.address), modelText(String(value.text ?? '')),
      typeof value.agent === 'string' ? value.agent : undefined, undefined,
      typeof value.transportRequestId === 'string' ? createHash('sha256').update(`order:${agentId}:${value.transportRequestId}`).digest('hex') : undefined) as Promise<Output<Name>>;
  }
  return daemonExecuteTool(helperConnection ? {...ctx,helperConnection} : ctx, name, input, agentId);
}
