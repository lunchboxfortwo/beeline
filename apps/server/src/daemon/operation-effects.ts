import { normalizeAgentApprovalIntent } from '../tray-approval-ask.js';
import { isBeelineGuideName } from '@beeline/api-contract/beeline-guides';
import { workflowOutputBindingCtes } from '../workflow-step-output.js';
import { createHash } from 'node:crypto';
import { endAgentTurn } from '../agent-turn-end.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { clearOwedMention, mentionReplyKey } from '../owed-mentions.js';
import { postRepositoryOnboarding } from '../repository-onboarding.js';
import { CommandRefusalError } from '../commander.js';
import { isBackgroundCommand, vaultSaveRequest, type VaultSaveCard } from '@beeline/api-contract/daemon';
import { FIRST_PARTY_INTEGRATIONS } from '../first-party-integrations.js';
import { setCornerHold } from '../corner-holds.js';
import { authorizeCommandOutput } from '../agent-command-route-agent-result.js';
import { endComputerSession, getComputerSession } from '../computer-session.js';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { recordPersonMergeYes } from '../corner-merge-approval.js';
import { advanceCorner, lockCornerLifecycle } from '../corner-lifecycle.js';
import { systemLine } from '../system-line.js';
import { appIdentity } from '@beeline/api-contract/workbench';
import { connectorIntentIndex } from '../connector-intent-index.js';
import { composioToolkitForApp } from '../composio-apps.js';
import { deleteInstitutionalMemory, getInstitutionalContext, reportInstitutionalMemoryUsed, saveInstitutionalMemory, searchInstitutionalMemory, updateInstitutionalMemory } from '../institutional-memory-shadow.js';
import { searchInstitutionalHistory } from '../institutional-history.js';
import { loadWorkspaceSkill } from '../institutional-skills.js';
import type { DaemonContext } from './context.js';
import { Input, Output, id, seconds } from './values.js';
import { daemonWriteResult } from './corner-messages.js';
import { daemonPostRoomMessage } from './messages.js';
import { daemonAccess } from './access.js';
import { daemonLinkSpendApproval, daemonSquireApprovalDecision } from './approvals.js';
import { daemonGrantRequester } from './grants.js';
import { daemonAgentWorkbench, daemonOfferContext } from './workbench.js';

export async function getInstitutionalContextOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {
if (!ctx.commandTransaction || !ctx.authorizedCommand) {
          throw new Error('institutional context requires an active command');
        }
        if (!ctx.institutionalMemoryShadow.live) {
          return {
            snapshotRevision: 0,
            text: '',
            itemIds: [],
            totalBytes: 0,
            omitted: {},
          } as Output<Name>;
        }
        return (await getInstitutionalContext(
          ctx.database,
          ctx.authorizedCommand,
          ctx.memoryEmbed,
        )) as Output<Name>;
}

export async function saveInstitutionalMemoryOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {

        if (!ctx.commandTransaction || !ctx.authorizedCommand) {
          throw new Error('institutional memory changes require an active command');
        }
        if (!ctx.institutionalMemoryShadow.live) {
          throw new Error('institutional memory is disabled');
        }
        const command = ctx.authorizedCommand;
        if (name === 'saveInstitutionalMemory') {
          return (await saveInstitutionalMemory(
            ctx.database,
            command,
            input as Input<'saveInstitutionalMemory'>,
            ctx.afterCommit,
          )) as Output<Name>;
        }
        if (name === 'updateInstitutionalMemory') {
          return (await updateInstitutionalMemory(
            ctx.database,
            command,
            input as Input<'updateInstitutionalMemory'>,
            ctx.afterCommit,
          )) as Output<Name>;
        }
        if (name === 'deleteInstitutionalMemory') {
          return (await deleteInstitutionalMemory(
            ctx.database,
            command,
            input as Input<'deleteInstitutionalMemory'>,
          )) as Output<Name>;
        }
        return (await reportInstitutionalMemoryUsed(
          ctx.database,
          command,
          input as Input<'reportInstitutionalMemoryUsed'>,
        )) as Output<Name>;

}

export async function searchInstitutionalMemoryOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {
if (!ctx.commandTransaction || !ctx.authorizedCommand) {
          throw new Error('institutional memory search requires an active command');
        }
        if (!ctx.institutionalMemoryShadow.live) {
          throw new Error('institutional memory is disabled');
        }
        return (await searchInstitutionalMemory(
          ctx.database,
          ctx.authorizedCommand,
          input as Input<'searchInstitutionalMemory'>,
          ctx.memoryEmbed,
        )) as Output<Name>;
}

export async function searchInstitutionalHistoryOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {
if (!ctx.commandTransaction || !ctx.authorizedCommand) {
          throw new Error('institutional history search requires an active command');
        }
        if (!ctx.institutionalMemoryShadow.live) {
          throw new Error('institutional memory is disabled');
        }
        return (await searchInstitutionalHistory(
          ctx.database,
          ctx.authorizedCommand,
          input as Input<'searchInstitutionalHistory'>,
        )) as Output<Name>;
}

export async function loadWorkspaceSkillOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {
if (!ctx.commandTransaction || !ctx.authorizedCommand) {
          throw new Error('workspace skill load requires an active command');
        }
        if (!ctx.institutionalMemoryShadow.live && !isBeelineGuideName((input as Input<'loadWorkspaceSkill'>).slug.trim())) {
          throw new Error('institutional memory is disabled');
        }
        return (await loadWorkspaceSkill(
          ctx.database,
          ctx.authorizedCommand,
          input as Input<'loadWorkspaceSkill'>,
        )) as Output<Name>;
}

/** Compatibility read for older installed helpers; never issues or negotiates authority. */
export async function getModelCredentialOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {
        const request = input as Input<'getModelCredential'>;
        return await ctx.database.transaction(async db => {
          const command = await authorizeCommandOutput(db, request.roomId, authenticatedAgentId, request.requestId);
          return { modelCredential: (await db.ownedModelCredentials?.forCommands(db, [command.id]))?.get(command.id) } as Output<Name>;
        });
}

/** Status only: the helper handed this item to the agent session. */
export async function startAgentTurnOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {
        const request = input as Input<'startAgentTurn'>;
        if (request.available === false) {
          const command = await authorizeCommandOutput(ctx.database, request.roomId, authenticatedAgentId, request.requestId);
          if ((await ctx.database.query('SELECT 1 FROM free_agents WHERE agent_id=$1', [authenticatedAgentId])).rowCount) {
            const reason = request.failureReason?.trim() || 'Agent harness could not start';
            await ctx.database.transaction(async db => {
              const source = ctx.helperConnection;
              if (source && !(await db.query(`SELECT 1 FROM agent_connections WHERE agent_id=$1
                AND connection_id=$2 AND epoch=$3 FOR SHARE`, [authenticatedAgentId, source.connectionId, source.epoch])).rowCount) return;
              const current = await authorizeCommandOutput(db, request.roomId, authenticatedAgentId, request.requestId);
              if (current.state !== 'pending') return;
              await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status)
                VALUES($1,$2,$3,'working') ON CONFLICT(room_id,request_id,agent_id) DO NOTHING`,
                [request.roomId, request.requestId, authenticatedAgentId]);
              if (!await endAgentTurn(db, current, 'failed', reason)) return;
              await db.query('SELECT beeline_record_agent_answer($1,true,$2)', [current.id, reason]);
              const agent = (await db.query<{ name: string }>('SELECT name FROM identities WHERE id=$1', [authenticatedAgentId])).rows[0]!;
              await systemLine(db, {
                id: createHash('sha256').update(`failed:${command.id}`).digest('hex'),
                roomId: command.return_room_id ?? command.room_id,
                subject: { kind: 'agent', id: authenticatedAgentId, name: agent.name },
                verb: systemMessage('agent-turn.failed'),
                consequence: systemMessage('agent-turn.failure-reason', reason),
                requestId: request.requestId, commandId: command.id, durableFact: 'failure',
              });
            });
          }
          ctx.live.publish({ type: 'invalidate', roomId: request.roomId, reason: 'message', agentId: authenticatedAgentId });
          ctx.live.publish({ type: 'invalidate', roomId: command.return_room_id ?? request.roomId, reason: 'turn', agentId: authenticatedAgentId });
        } else {
        await ctx.database.transaction(async db=>{
        const source=ctx.helperConnection;
        const connection=await db.query<{epoch:string}>(`SELECT epoch FROM agent_connections WHERE agent_id=$1
          AND ($2::text IS NULL OR (connection_id=$2 AND epoch=$3)) FOR SHARE`,
          [authenticatedAgentId,source?.connectionId ?? null,source?.epoch ?? null]);
        if(source && !connection.rowCount) return;
        await db.query(`WITH delivered AS (SELECT * FROM agent_commands
          WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3 AND state='pending' FOR SHARE),
          ${workflowOutputBindingCtes('delivered')}
          INSERT INTO agent_turns(room_id,request_id,agent_id,status,connection_epoch)
          SELECT command.room_id,command.turn_request_id,command.agent_id,'working',$4::bigint FROM delivered command
          ORDER BY command.created_at DESC LIMIT 1
          ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET status='working',failure_reason=NULL,
            completion_kind=NULL,created_at=now(),started_at=now(),connection_epoch=EXCLUDED.connection_epoch`,
          [request.roomId, authenticatedAgentId, request.requestId,connection.rows[0]?.epoch ?? null]);
        });
        ctx.live.publish({ type: 'invalidate', roomId: request.roomId, reason: 'turn', agentId: authenticatedAgentId });
        }
        return daemonWriteResult(ctx) as Output<Name>;
}

export async function getRoomGitHubTokenOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {

        if (!ctx.roomGitHubToken) throw new Error('GitHub room token service unavailable');
        const roomId = (input as Input<'getRoomGitHubToken'>).roomId;
        try {
          return (await ctx.roomGitHubToken(roomId)) as Output<Name>;
        } catch (error) {
          // The exact missing-installation result is a Room configuration
          // fact. An upstream 404 alone does not establish that fact.
          if (
            error instanceof Error &&
            error.message === 'GitHub repository installation not found'
          ) {
            throw new CommandRefusalError('Room repository access needs the Beeline GitHub App', 409);
          }
          throw error;
        }

}

export async function markAgentTurnSilentOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {

        const declinedMessage = name === 'markAgentTurnSilent' ? (input as Input<'markAgentTurnSilent'>).messageId : undefined;
        if (name === 'markAgentTurnSilent') {
          const command = ctx.authorizedCommand;
          if (!command) throw new CommandRefusalError('silence requires an active turn', 409);
          if (declinedMessage && !await mentionReplyKey(ctx.database, authenticatedAgentId, command.room_id, declinedMessage))
            throw new CommandRefusalError('messageId must be a tagged message in this Room', 400);
          if (!(await ctx.database.query(`SELECT 1 FROM agent_pending_attachments
            WHERE room_id=$1 AND agent_id=$2 AND request_id=$3 LIMIT 1`,
            [command.room_id, authenticatedAgentId, command.turn_request_id])).rowCount) {
            const answered = command.state === 'complete' || command.action === 'restart'
              || isBackgroundCommand(command.private_payload?.automatic ? 'attention_report' : command.reason) || Boolean((await ctx.database.query(
              `SELECT 1 FROM messages WHERE room_id=$1 AND author_id=$2 AND request_id=$3
                AND presentation IN ('message','card') AND deleted_at IS NULL LIMIT 1`,
              [command.return_room_id, authenticatedAgentId, command.turn_request_id])).rowCount);
            if (answered) {
              await endAgentTurn(ctx.database, command, 'complete');
              if (declinedMessage) await clearOwedMention(ctx.database, authenticatedAgentId, command.room_id, declinedMessage);
            }
            return { ...daemonWriteResult(ctx), answered } as Output<Name>;
          }
          // Drain promised files through the same ordinary reply path before
          // recording silence; the reply writer never receives System prose.
          input = { roomId: command.room_id, requestId: command.turn_request_id!, text: '' } as Input<Name>;
        }
        const output = await daemonPostRoomMessage(ctx,
          input as Input<'postRoomMessage'>,
          authenticatedAgentId,
        );
        if (name === 'markAgentTurnSilent') {
          const command = ctx.authorizedCommand!;
          if (declinedMessage) await clearOwedMention(ctx.database, authenticatedAgentId, command.room_id, declinedMessage);
          return { ...daemonWriteResult(ctx), answered: true } as Output<Name>;
        }
        return output as Output<Name>;

}

export async function postBackgroundToolCompletionOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {

        const completion = input as Input<'postBackgroundToolCompletion'>;
        if (!completion.toolCallId || completion.toolCallId.length > 512 ||
            !['completed', 'failed'].includes(completion.status))
          throw new Error('invalid background tool completion');
        await daemonAccess(ctx, completion.roomId, authenticatedAgentId);
        return await ctx.database.transaction(async (db) => {
          const origin = await authorizeCommandOutput(db, completion.roomId, authenticatedAgentId, completion.requestId);
          // Older helpers may detach the terminal MCP call before its result
          // arrives. Its result cannot add work to a turn already ended silently.
          // Preserve every other background job and every later generation.
          if (/^(?:(?:mcp__)?beeline[-_]agent__|mcp\.beeline-agent\.)?no_reply_needed$/.test(completion.title) &&
              (await db.query(`SELECT 1 FROM agent_turns
                WHERE room_id=$1 AND agent_id=$2 AND request_id=$3
                  AND completion_kind='no-reply'`,
              [completion.roomId, authenticatedAgentId, completion.requestId])).rowCount)
            return daemonWriteResult(ctx);
          // Legacy helpers may acknowledge a detached tool. Its invocation owns
          // the result; a completion receipt never authorizes another model turn.
          await db.query(`INSERT INTO free_agent_events(agent_id,kind,detail)
            SELECT agent_id,'background_tool_result',$2::jsonb FROM free_agents WHERE agent_id=$1`,
            [authenticatedAgentId,JSON.stringify({commandId:origin.id,
              toolCallId:completion.toolCallId,status:completion.status})]);
          return daemonWriteResult(ctx);
        }) as Output<Name>;

}

export async function endComputerSessionOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {

        const ending = input as Input<'endComputerSession'>;
        const session = (await ctx.database.query<{ id: string }>(
          `SELECT id FROM computer_sessions WHERE room_id=$1 AND agent_id=$2 AND source_session_id=$3 AND status='live'`,
          [ending.roomId, authenticatedAgentId, ending.sessionId],
        )).rows;
        for (const found of session) {
          const row = await getComputerSession(ctx.database, found.id);
          if (row) await endComputerSession(ctx.database, ctx.live, row);
        }
        return daemonWriteResult(ctx) as Output<Name>;

}

export async function createLinkSpendRequestOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {

        if (!ctx.linkWallet) throw new Error('Link is not configured');
        const request = input as Input<'createLinkSpendRequest'>;
        normalizeAgentApprovalIntent(request);
        const owner = (await ctx.database.query<{ owner_id: string }>(
          `SELECT owner_id FROM agents WHERE agent_id=$1`, [authenticatedAgentId])).rows[0];
        if (!owner) throw new Error('agent owner not found');
        const created = await ctx.linkWallet.create(owner.owner_id, authenticatedAgentId,
          request.roomId, request);
        if (created.approval_url) await daemonLinkSpendApproval(ctx, request, authenticatedAgentId,
          owner.owner_id, created.id, created.approval_url);
        return { id: created.id, status: created.status,
          ...(created.approval_url ? { approvalUrl: created.approval_url } : {}) } as Output<Name>;

}

export async function retrieveLinkSpendRequestOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {

        if (!ctx.linkWallet) throw new Error('Link is not configured');
        const request = input as Input<'retrieveLinkSpendRequest'>;
        const owner = (await ctx.database.query<{ owner_id: string }>(
          `SELECT owner_id FROM agents WHERE agent_id=$1`, [authenticatedAgentId])).rows[0];
        if (!owner) throw new Error('agent owner not found');
        const result = await ctx.linkWallet.retrieve(owner.owner_id, authenticatedAgentId, request.id);
        // Provider reads settle the original approval, even when a later turn
        // retrieves it from another Room. Provenance is not the asking turn.
        if (result.status === 'approved' || result.status === 'denied' || result.status === 'expired') {
          const approvals = await ctx.database.query<{ room_id: string; request_id: string; title: string; detail: string }>(
            `SELECT spend.room_id,COALESCE(command.turn_request_id,message.request_id,
               message.card->>'sourceMessageId',message.id) request_id,
               message.card->>'title' title,message.card->>'detail' detail
             FROM link_spend_requests spend JOIN messages message
               ON message.card_type='squire-approval' AND message.card->>'approvalId'=spend.id
               AND message.card->>'tool'='Link' AND message.card->'agent'->>'pubkey'=spend.agent_id
               AND message.card->'owner'->>'pubkey'=spend.owner_identity_id
             LEFT JOIN agent_commands command ON command.id=message.card->>'commandId'
             WHERE spend.id=$1 AND spend.owner_identity_id=$2 AND spend.agent_id=$3`,
            [request.id, owner.owner_id, authenticatedAgentId]);
          for (const approval of approvals.rows) await daemonSquireApprovalDecision(ctx, {
            roomId: approval.room_id, requestId: approval.request_id, approvalId: request.id,
            status: result.status, tool: 'Link', title: approval.title, detail: approval.detail,
          }, authenticatedAgentId);
        }
        return { id: result.id, status: result.status,
          ...(result.approval_url ? { approvalUrl: result.approval_url } : {}),
          ...(result.status_details?.requires_action?.next_action ? { nextAction: {
            resolution: result.status_details.requires_action.next_action.resolution,
            displayMessage: result.status_details.requires_action.next_action.display_message,
            actionUrl: result.status_details.requires_action.next_action.action_url } } : {}),
          ...(result.card ? { card: { number: result.card.number, cvc: result.card.cvc,
            expMonth: result.card.exp_month, expYear: result.card.exp_year,
            billingAddress: result.card.billing_address ? {
              name: result.card.billing_address.name,
              postalCode: result.card.billing_address.postal_code,
              line1: result.card.billing_address.line1, city: result.card.billing_address.city,
              state: result.card.billing_address.state,
              country: result.card.billing_address.country } : undefined,
            validUntil: result.card.valid_until } } : {}),
          ...(result.shared_payment_token ? { sharedPaymentToken: {
            id: result.shared_payment_token.id,
            validUntil: result.shared_payment_token.valid_until } } : {}) } as Output<Name>;

}

export async function postStarterWelcomeOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {

        const request = input as Input<'postStarterWelcome'>;
        await daemonAccess(ctx, request.roomId, authenticatedAgentId);
        const requester = await daemonGrantRequester(ctx);
        const personId = requester.kind === 'human' ? requester.id : (await ctx.database.query<{ owner_id: string }>(
          `SELECT owner_id FROM agents WHERE agent_id=$1`, [authenticatedAgentId])).rows[0]?.owner_id;
        if (!personId) throw new Error('Onboarding requester unavailable');
        if (!ctx.starterOnboarding) throw new Error('Onboarding service unavailable');
        await ctx.starterOnboarding.queueRerun(ctx.database, request.roomId, personId, authenticatedAgentId);
        const service = ctx.starterOnboarding;
        ctx.afterCommit?.(() => {
          void service.prepare(request.roomId).then(() => service.open(request.roomId, personId))
            .catch(error => console.error('[onboarding] rerun failed', error));
        });
        const result = { status: 'started' as const };
        ctx.live.publish({ type: 'invalidate', roomId: request.roomId, reason: 'message' });
        return result as Output<Name>;

}

export async function postRepositoryOnboardingOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {

        const request = input as Input<'postRepositoryOnboarding'>;
        await daemonAccess(ctx, request.roomId, authenticatedAgentId);
        const requester = await daemonGrantRequester(ctx);
        const owner = requester.kind === 'human' ? requester.id : (await ctx.database.query<{ owner_id: string }>(
          `SELECT owner_id FROM agents WHERE agent_id=$1`, [authenticatedAgentId])).rows[0]?.owner_id;
        if (!owner) throw new Error('repository onboarding unavailable');
        if (!['repository', 'starters'].includes(request.kind)) throw new Error('invalid repository card kind');
        if (request.kind === 'repository') await ctx.github?.refresh(owner);
        const card = await ctx.database.transaction(database => postRepositoryOnboarding(database, ctx.github, {
          roomId: request.roomId, agentId: authenticatedAgentId, requesterId: owner, kind: request.kind,
          ...(request.repository ? { repository: request.repository } : {}),
        }));
        ctx.live.publish({ type: 'invalidate', roomId: request.roomId, reason: 'message', agentId: authenticatedAgentId });
        return card as Output<Name>;

}

export async function findConnectorsOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {

        const request = input as Input<'findConnectors'>;
        const query = typeof request.query === 'string' ? request.query.trim() : '';
        if (!query || query.length > 200) throw new Error('query is required and must be at most 200 characters');
        const view = await daemonAgentWorkbench(ctx, request, authenticatedAgentId);
        const index = connectorIntentIndex(ctx.mcpRegistry, ctx.composio);
        await index.refresh();
        const status = new Map<string, import('@beeline/api-contract/daemon').ConnectorSearchMatch['status']>();
        for (const entry of view.catalog) status.set(entry.connectorType,
          entry.paired?.status === 'connected' ? 'connected' : entry.paired?.status === 'error' ? 'broken' : 'not-connected');
        status.set('trusty-squire', view.machine.squire?.status === 'connected' ? 'connected'
          : view.machine.squire?.status === 'error' ? 'broken' : 'not-connected');
        for (const app of view.apps ?? []) {
          const value = app.status === 'connected' ? 'connected' : app.status === 'error' ? 'broken' : 'not-connected';
          status.set(app.appKey, value);
          status.set(composioToolkitForApp(app.appKey), value);
        }
        const personal = view.connections.flatMap(connection => {
          const key = connection.service && appIdentity(connection.service)?.key;
          if (!key) return [];
          if (!['wallet', 'tailscale', 'trusty-squire', ...FIRST_PARTY_INTEGRATIONS.map(entry => entry.key)].includes(key))
            status.set(key, connection.state === 'active' ? 'connected' : 'broken');
          return [{ key, service: connection.service!, name: connection.label, source: 'squire' as const,
            aliases: [connection.service!], intents: ['twilio', 'plivo', 'telnyx'].includes(key)
              ? ['send texts', 'text messages', 'sms'] : [] }];
        });
        for (const entry of view.firstPartyIntegrations ?? []) status.set(entry.key, entry.status);
        return index.search(query, status, personal) as Output<Name>;

}

export async function postVaultSaveCardOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {

        const cardInput = input as Input<'postVaultSaveCard'>;
        const metadata = vaultSaveRequest(cardInput);
        const context = await daemonOfferContext(ctx, cardInput.roomId, authenticatedAgentId);
        const card: VaultSaveCard = { ...metadata, agentId: authenticatedAgentId,
          ownerId: context.owner.pubkey, ownerName: context.owner.name, status: 'pending' };
        const line = await systemLine(ctx.database, { roomId: cardInput.roomId,
          subject: { kind: 'agent', id: authenticatedAgentId, name: context.agent.name },
          verb: systemMessage("daemon-service.wants-a-vault-entry"), object: systemMessage("daemon-service.vault-entry-title", metadata.service, metadata.label),
          consequence: metadata.purpose, presentation: 'card', cardType: 'vault-save',
          card: { ...card, originCommandId: ctx.authorizedCommand!.id } as unknown as Record<string, unknown> });
        return { id: line.id, createdAt: seconds(new Date()) } as Output<Name>;

}

export async function setCornerHoldOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {

        const hold = input as Input<'setCornerHold'>;
        await daemonAccess(ctx, hold.cornerId, authenticatedAgentId);
        const result = await ctx.database.transaction(async (db) => {
          await lockCornerLifecycle(db, hold.cornerId);
          const command = await authorizeCommandOutput(db, hold.roomId, authenticatedAgentId, hold.requestId);
          const actor = (await db.query<{ author_id: string }>(
            `SELECT message.author_id FROM messages message
             JOIN identities person ON person.id=message.author_id AND person.kind='human'
             WHERE message.id=$1`,
            [command.root_source_message_id],
          )).rows[0];
          if (!actor && hold.releaseHoldId !== undefined) throw new Error('hold requires a human requester');
          return setCornerHold(db, hold, actor?.author_id ?? authenticatedAgentId, authenticatedAgentId);
        });
        const reconcile = async () => { await ctx.github?.reconcileQueuedCorners(hold.cornerId); };
        if (ctx.afterCommit) ctx.afterCommit(reconcile);
        else await reconcile();
        return result as Output<Name>;

}

export async function orderCornerMergeOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, candidate: Record<string, unknown>, scopedRoom: string | undefined): Promise<Output<Name>> {

        const order = input as Input<'orderCornerMerge'>;
        await daemonAccess(ctx, order.cornerId, authenticatedAgentId);
        const actorId = await ctx.database.transaction(async (db) => {
          const command = await authorizeCommandOutput(db, order.roomId, authenticatedAgentId, order.requestId);
          const actor = (await db.query<{ author_id: string }>(
            `SELECT message.author_id FROM messages message
             JOIN identities person ON person.id=message.author_id AND person.kind='human'
             WHERE message.id=$1`,
            [command.root_source_message_id],
          )).rows[0];
          if (!actor) throw new Error('merge order requires a human requester');
          return actor.author_id;
        });
        const yes = await recordPersonMergeYes(ctx.database, order.cornerId, actorId);
        // Recording consent is a separate action from landing. The caller uses
        // merge_corner for the single agent-facing landing action.
        return { roomId: yes.roomId, headSha: yes.headSha } as Output<Name>;

}
