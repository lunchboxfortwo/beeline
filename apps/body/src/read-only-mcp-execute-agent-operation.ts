import { readAgentMessagePage, readAgentMessageResult } from '@beeline/api-contract/daemon';
import { normalizeApprovalIntent } from '@beeline/api-contract/phone';
import { normalizeAppContinuation } from "@beeline/api-contract/app-connections";
import { fixCornerText,readAgentUsage,usageIsOld,usageSummary,type ConnectResult,type CornerRestoreResult,type RoomConversationResult,type RoomMessageResult } from "@beeline/api-contract/daemon";
import { createHash,randomUUID } from "node:crypto";
import { join } from "node:path";
import { attachmentId,deliverAttachments,withoutImageData } from "./attachment-delivery.js";
import { beelineManagedSkills,runningBeelineReleaseId } from "./beeline-skill.js";
import { listGrants,requestGrant,shareBrowser,storeSecret,workbenchStatus } from './read-only-mcp-agent-grant-deps.js';
import { agentScheduleRoomId,bindBriefFiles,postArtifact } from './read-only-mcp-download-attachment.js';
import { approveMerge,closeCorner,openCorner,prChecksStatus,readCornerBrief,reportFeedback,reviseCornerBrief,targetCornerId,writeScratchFile } from './read-only-mcp-open-corner.js';
import { runGrantedCommand } from './read-only-mcp-open-poll.js';
import { activeCommandContext,asObject,connectorOfferDepsFromEnv,daemonExecute,downloadAttachment,fetchImage,JsonObject,memorySources,requiredEnv,stringArg } from './read-only-mcp.js';
import { allocatedDirectoryBytes,scratchBudgetMessage } from "./scratch-lifecycle.js";
import { sessionToolRequest } from './session-tool-connection.js';
import { squireSessionSignedIn } from "./squire-sign-in.js";









export async function executeAgentOperation(name:string,args:JsonObject,toolCallId:string):Promise<string> {
  if (name === 'message') return JSON.stringify(await daemonExecute(name,args));
  return executeResourceOperation(name,args,toolCallId);
}

function deterministicWorkItemUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function executeResourceOperation(name:string,args:JsonObject,toolCallId:string):Promise<string> {
  switch (name) {
    case 'create_work_item':
    case 'update_work': {
      const context = await activeCommandContext();
      const update = name === 'create_work_item' ? {
        ...args,
        id: deterministicWorkItemUuid(`work-item:${context.requestId}:${toolCallId}`),
        state: args.state ?? 'backlog',
      } : args;
      const result = await daemonExecute('updateWorkItem', {
        ...update, targetRoomId: args.roomId, roomId: context.roomId,
      });
      return JSON.stringify({...result, id: update.id ?? args.roomId});
    }
    case 'list_tasks':
      return JSON.stringify(await daemonExecute('listWorkItems', {
        ...(typeof args.address === 'string' && args.address ? { roomId: args.address } : {}),
        ...(typeof args.state === 'string' ? { state: args.state } : {}),
      }));
    case 'close_ask':
      return JSON.stringify(await daemonExecute('closeAgentAsk', { messageId: args.id, reason: args.reason }));
    case 'get_chat_message': {
      const result = await daemonExecute('getRoomMessage', {
        roomId: typeof args.address === 'string' ? args.address : agentScheduleRoomId(),
        messageId: args.messageId,
        ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
      });
      if ('attachmentId' in result) throw new Error('expected a message result');
      const message = readAgentMessageResult(result as unknown as RoomMessageResult);
      const attachments = message.attachments ?? [];
      if (!attachments.length) return JSON.stringify(message);
      const scratch = process.env.BEELINE_ATTACH_SCRATCH_ROOT?.trim();
      const delivered = scratch
        ? withoutImageData(
            await deliverAttachments(
              attachments,
              join(
                scratch,
                'beeline-attachments',
                createHash('sha256').update(String(message.messageId)).digest('hex'),
              ),
            ),
          )
        : attachments.map((attachment) => ({
            attachment,
            reason: 'download failed: no session scratch directory',
          }));
      return JSON.stringify({
        ...message,
        attachments: delivered.map(({ attachment, ...local }) => ({
          ...attachment,
          ...(attachmentId(attachment) ? { attachmentId: attachmentId(attachment) } : {}),
          ...local,
        })),
      });
    }
    case 'download_attachment':
      return downloadAttachment(args);
    case 'load_workspace_skill': {
      // Workspace procedures retain precedence over shipped skills with the same slug.
      try {
        return JSON.stringify(await daemonExecute('loadWorkspaceSkill', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          slug: args.slug,
        }));
      } catch (error) {
        // Only a missing procedure falls back; authorization and service failures stay visible.
        if (!(error instanceof Error) || !error.message.startsWith('daemon operation loadWorkspaceSkill failed (404:'))
          throw error;
        const skill = beelineManagedSkills(runningBeelineReleaseId(), { isReviewer: true })
          .find((candidate) => candidate.name === args.slug);
        if (!skill) throw error;
        return JSON.stringify({ slug: skill.name, markdown: skill.content, source: 'built-in' });
      }
    }
    case 'save_skill':
      return JSON.stringify(
        await daemonExecute('saveSkill', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          slug: args.slug,
          description: args.description,
          markdown: args.markdown,
        }),
      );
    case 'delete_skill':
      return JSON.stringify(
        await daemonExecute('deleteSkill', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          slug: args.slug,
          version: args.version,
          sourceMessageIds: memorySources(args),
        }),
      );
    case 'save_workflow':
      return JSON.stringify(
        await daemonExecute('saveWorkflow', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          contract: args.contract,
        }),
      );
    case 'start_workflow':
      return JSON.stringify(
        await daemonExecute('startWorkflow', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          name: args.name,
          roleBindings: args.roleBindings,
        }),
      );
    case 'get_workflow_run':
      return JSON.stringify(await daemonExecute('getWorkflowRun', {
        agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
        roomId: agentScheduleRoomId(),
        runId: args.runId,
      }));
    case 'cancel_workflow_run':
      return JSON.stringify(await daemonExecute('cancelWorkflowRun', {
        agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
        roomId: agentScheduleRoomId(),
        runId: args.runId,
        reason: args.reason,
      }));
    case 'handoff':
      return JSON.stringify(
        await daemonExecute('handoff', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          runId: args.runId,
          outcome: args.outcome,
          contents: args.contents,
          ...(args.receipt !== undefined ? { receipt: args.receipt } : {}),
          ...(args.attempt !== undefined ? { attempt: args.attempt } : {}),
        }),
      );
    case 'archive_workflow':
      return JSON.stringify(
        await daemonExecute('archiveWorkflow', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          name: args.name,
        }),
      );
    case 'assign_workflow_role':
      return JSON.stringify(
        await daemonExecute('assignWorkflowRole', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          runId: args.runId,
          role: args.role,
          targetAgentId: args.agentId,
        }),
      );
    case 'search_history':
      return JSON.stringify(
        await daemonExecute('searchInstitutionalHistory', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          query: args.query,
          ...(typeof args.limit === 'number' ? { limit: Math.floor(args.limit) } : {}),
        }),
      );
    case 'search_memory':
      return JSON.stringify(
        await daemonExecute('searchInstitutionalMemory', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          query: args.query,
          ...(typeof args.limit === 'number' ? { limit: Math.floor(args.limit) } : {}),
        }),
      );
    case 'report_feedback':
      if(args.action==='fixed') return JSON.stringify(await daemonExecute('notifyFeedbackFixed',{
        ...await activeCommandContext(),itemIds:args.item_ids,title:args.title,prUrl:args.pr_url,
        ...(typeof args.notify==='boolean'?{notify:args.notify}:{}),
      }));
      return reportFeedback(args);
    case 'save_memory':
      return JSON.stringify(
        await daemonExecute('saveInstitutionalMemory', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          memoryKind: args.subject_is_requester ? 'human_profile_fact' : 'workspace_fact',
          canonicalKey: args.canonical_key,
          body: args.body,
          keywords: Array.isArray(args.keywords) ? args.keywords : [],
          sourceMessageIds: memorySources(args),
          personAsked: args.person_asked,
          confidence: args.confidence,
        }),
      );
    case 'update_memory':
      return JSON.stringify(
        await daemonExecute('updateInstitutionalMemory', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          itemId: args.item_id,
          version: args.version,
          body: args.body,
          ...(Array.isArray(args.keywords) ? { keywords: args.keywords } : {}),
          sourceMessageIds: memorySources(args),
          personAsked: args.person_asked,
        }),
      );
    case 'delete_memory':
      return JSON.stringify(
        await daemonExecute('deleteInstitutionalMemory', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          itemId: args.item_id,
          version: args.version,
          reason: args.reason,
          sourceMessageIds: memorySources(args),
          personAsked: args.person_asked,
        }),
      );
    case 'report_memory_used':
      return JSON.stringify(
        await daemonExecute('reportInstitutionalMemoryUsed', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          itemIds: Array.isArray(args.item_ids) ? args.item_ids : [],
          snapshotItems: Array.isArray(args.snapshot_items) ? args.snapshot_items : [],
        }),
      );
    case 'wallet_address':
      return JSON.stringify(
        await daemonExecute('getWalletToolState', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
        }),
      );
    case 'wallet_balance':
      return JSON.stringify(
        await daemonExecute('getWalletToolBalance', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
        }),
      );
    case 'wallet_chains':
      return JSON.stringify(
        await daemonExecute('getWalletToolChains', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
        }),
      );
    case 'wallet_history':
      return JSON.stringify(
        await daemonExecute('getWalletToolHistory', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          ...(typeof args.limit === 'number' ? { limit: Math.floor(args.limit) } : {}),
        }),
      );
    case 'wallet_quote':
      return JSON.stringify(
        await daemonExecute('getWalletToolQuote', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          ...(typeof args.chain === 'string' ? { chain: args.chain } : {}),
          asset: String(args.asset ?? 'usdc'),
          amount: String(args.amount ?? ''),
        }),
      );
    case 'wallet_pay':
      return JSON.stringify(
        await daemonExecute('walletPay', {
          completionV1: true,
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          ...(typeof args.chain === 'string' ? { chain: args.chain } : {}),
          asset: String(args.asset ?? 'usdc'),
          amount: String(args.amount ?? ''),
          to: String(args.to ?? ''),
        }),
      );
    case 'wallet_swap':
      return JSON.stringify(
        await daemonExecute('walletSwap', {
          completionV1: true,
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          ...(typeof args.chain === 'string' ? { chain: args.chain } : {}),
          fromAsset: String(args.fromAsset ?? 'usdc'),
          toAsset: String(args.toAsset ?? 'eth'),
          amount: String(args.amount ?? ''),
        }),
      );
    case 'wallet_contract_call': {
      const approve = args.approve as JsonObject | undefined;
      return JSON.stringify(
        await daemonExecute('walletContractCall', {
          completionV1: true,
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          chain: String(args.chain ?? ''),
          contract: String(args.contract ?? ''),
          data: String(args.data ?? ''),
          ...(typeof args.value === 'string' ? { value: args.value } : {}),
          ...(approve && typeof approve === 'object'
            ? { approve: { asset: String(approve.asset ?? ''), amount: String(approve.amount ?? '') } }
            : {}),
        }),
      );
    }
    case 'wallet_sign_typed_data':
      return JSON.stringify(
        await daemonExecute('walletSignTypedData', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          domain: args.domain,
          types: args.types,
          primaryType: args.primaryType,
          message: args.message,
        }),
      );
    case 'set_thread_hold':
      return JSON.stringify(
        await daemonExecute('setCornerHold', {
          ...await activeCommandContext(),
          cornerId: typeof args.cornerId === 'string'
            ? args.cornerId : requiredEnv('BEELINE_DAEMON_CORNER_ID'),
          ...(typeof args.sourceMessageId === 'string' ? { sourceMessageId: args.sourceMessageId } : {}),
          ...(args.releaseHoldId !== undefined ? { releaseHoldId: args.releaseHoldId } : {}),
        }),
      );
    case 'send_operator_system_dm':
      return JSON.stringify(await daemonExecute('sendOperatorSystemDm', {
        ...await activeCommandContext(),
        agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
        recipients: args.recipients as string | string[], text: String(args.text ?? ''),
      }));
    case 'read_operator_system_dm':
      return JSON.stringify(await daemonExecute('readOperatorSystemDm', {
        ...await activeCommandContext(),
        agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'), sendId: String(args.sendId ?? ''),
      }));
    case 'claim_thread': {
      const context = await activeCommandContext();
      const cornerId = typeof args.cornerId === 'string' ? args.cornerId : typeof args.address === 'string' ? args.address : undefined;
      return JSON.stringify(await daemonExecute('becomeImplementer', {
        ...context, ...(cornerId && cornerId !== context.roomId ? { cornerId } : {}),
      }));
    }
    case 'open_thread':
      return openCorner(args, toolCallId);
    case 'revise_thread_brief':
      return reviseCornerBrief(args);
    case 'read_thread_brief':
      return readCornerBrief(args);
    case 'read_agent_usage': {
      // The server answers only for the token's own agent; no provider is called here.
      const usage = readAgentUsage(
        await daemonExecute('getAgentUsage', { agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID') }),
      );
      return JSON.stringify({
        summary: usageSummary(usage),
        ...(usage ? { usage, old: usageIsOld(usage) } : {}),
      });
    }
    case 'stop':
      return JSON.stringify(await daemonExecute('stopAgentTurn', { address: args.address as string, agent: args.agent as string | undefined }));
    case 'inspect_thread': {
      if (typeof args.cornerId !== 'string' || !args.cornerId)
        throw new Error('cornerId is required');
      if (args.mode === 'transcript') {
        const page = await readAgentMessagePage({
          roomId: args.cornerId,
          from: args.from as 'oldest' | 'newest' | undefined,
          limit: args.limit as number | undefined,
          cursor: {before: args.before as string | undefined, after: args.after as string | undefined, offset: args.offset as number | undefined},
        }, async input => await daemonExecute('getRoomConversation', input) as unknown as RoomConversationResult);
        return JSON.stringify(page);
      }
      if (args.mode !== undefined && args.mode !== 'status')
        throw new Error('mode must be status or transcript');
      const status = (await daemonExecute('getCornerRestoreState', {
        cornerId: args.cornerId,
      })) as unknown as CornerRestoreResult;
      const pr = status.lifecycle?.pr;
      // GitHub can be unavailable while the server-owned lifecycle remains readable.
      const verdict = pr
        ? await daemonExecute('getPrChecksStatus', {
            cornerId: args.cornerId,
            pullRequest: pr.number,
          }).catch(() => undefined)
        : undefined;
      return JSON.stringify({
        cornerId: args.cornerId,
        state: status.state ?? 'unknown',
        lifecycle: status.lifecycle?.lifecycle ?? 'unknown',
        activity: status.activity ?? 'unknown',
        ...(status.awaiting ? { awaiting: status.awaiting } : {}),
        ...(status.lastMessage ? { lastMessage: status.lastMessage } : {}),
        ...(pr ? { pr: { number: pr.number, url: pr.url, title: pr.title } } : {}),
        ...(verdict?.headSha || pr?.headSha ? { headSha: verdict?.headSha ?? pr?.headSha } : {}),
        checks: verdict?.checks ?? status.lifecycle?.checks ?? 'unknown',
        verdict: verdict
          ? {
              stage: verdict.stage,
              approved: verdict.approved,
              held: verdict.held,
              holds: verdict.holds,
              mergeAllowed: verdict.mergeAllowed,
              ...(verdict.blockedReason ? { blockedReason: verdict.blockedReason } : {}),
              reviewer: verdict.reviewer,
              reviewerExists: verdict.reviewerExists,
              reviewerWake: verdict.reviewerWake,
            }
          : { mergeAllowed: false, status: 'unavailable', held: status.held === true, holds: status.holds ?? [] },
        merge: {
          mergeability: pr?.mergeability ?? 'unknown',
          ...(pr?.mergedAt ? { mergedAt: pr.mergedAt } : {}),
        },
      });
    }
    case 'close_thread':
      return closeCorner(args);
    case 'pr_checks_status':
      return prChecksStatus(args);
    case 'approve_merge':
      return approveMerge(args);
    case 'dispatch_release':
      return JSON.stringify(await daemonExecute('dispatchRoomWorkflow', {
        ...await activeCommandContext(),
        ...(args.inputs === undefined ? {} : { inputs: args.inputs }),
      }));
    case 'list_chats':
      return JSON.stringify(await daemonExecute('listRooms', { roomId: agentScheduleRoomId() }));
    case 'list_threads':
      return JSON.stringify(
        await daemonExecute('listReachableCorners', {
          roomId: typeof args.address === 'string' ? args.address : requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          ...(typeof args.activeOnly === 'boolean' ? { activeOnly: args.activeOnly } : {}),
        }),
      );
    case 'list_chat_members':
      return JSON.stringify(
        await daemonExecute('listRoomMembers', {
          roomId:
            typeof args.address === 'string' ? args.address : typeof args.cornerId === 'string' && args.cornerId
              ? args.cornerId
              : process.env.BEELINE_DAEMON_CORNER_ID?.trim() ||
                requiredEnv('BEELINE_DAEMON_ROOM_ID'),
        }),
      );
    case 'read_pull_request':
      return JSON.stringify(
        await daemonExecute('readCornerPullRequest', { cornerId: targetCornerId(args) }),
      );
    case 'write_scratch_file':
      return writeScratchFile(args);
    case 'scratch_status': {
      const root = requiredEnv('BEELINE_CORNER_SCRATCH_ROOT');
      return scratchBudgetMessage(await allocatedDirectoryBytes(root));
    }
    case 'get_avatar':
      return JSON.stringify(
        await daemonExecute('getAgentAvatar', { roomId: agentScheduleRoomId() }),
      );
    case 'set_avatar':
      return JSON.stringify(
        await daemonExecute('postAgentAvatar', {
          roomId: agentScheduleRoomId(),
          drawing: args.drawing,
          background: args.background as string | undefined,
        }),
      );
    case 'fetch_image':
      return fetchImage(args);
    case 'post_artifact':
      return postArtifact(args);
    case 'post_vault_save_card':
      return JSON.stringify(await daemonExecute('postVaultSaveCard', { ...args, roomId: agentScheduleRoomId() } as never));
    case 'share_browser':
      return shareBrowser(args);
    case 'end_browser_share': {
      if (typeof args.sessionId !== 'string' || !args.sessionId.trim())
        throw new Error('A shared browser sessionId is required');
      await daemonExecute('endComputerSession', { roomId: agentScheduleRoomId(), sessionId: args.sessionId });
      return 'Browser share ended';
    }
    case 'rename_thread': {
      const cornerId = targetCornerId(args);
      const fixedName = args.name === undefined && args.reviewer !== undefined ? undefined : fixCornerText('name', args.name);
      const fixedObjective = args.objective === undefined ? undefined : fixCornerText('objective', args.objective);
      const result = await daemonExecute('renameCorner', {
        cornerId,
        ...(fixedName ? { name: fixedName.text } : {}),
        ...(args.reviewer !== undefined ? { reviewer: args.reviewer as string } : {}),
        ...(fixedObjective ? { objective: fixedObjective.text } : {}),
        ...(args.brief !== undefined ? { brief: await bindBriefFiles(asObject(args.brief)) } : {}),
      });
      const notes = [fixedName?.note, fixedObjective?.note].filter(Boolean).join('; ');
      const baseReceipt =
        typeof result.receipt === 'string' && result.receipt
          ? result.receipt
          : args.name === undefined
            ? 'Updated thread reviewer'
            : `Renamed thread to #${String(result.name)}`;
      return JSON.stringify({
        cornerId,
        name: result.name,
        ...(result.approvedBy ? { approvedBy: result.approvedBy } : {}),
        receipt: notes ? `${baseReceipt} (${notes})` : baseReceipt,
      });
    }
    case 'create_subscription': {
      const source = stringArg(args, 'source');
      const event = stringArg(args, 'event');
      const prompt = stringArg(args, 'prompt');
      if (source !== 'room' && source !== 'repository' && source !== 'service' && source !== 'webhook')
        throw new Error('source must be chat, repository, service, or webhook');
      if (!event) throw new Error('event is required');
      if (!prompt) throw new Error('prompt is required');
      const result = await daemonExecute('createAgentSubscription', {
        roomId: agentScheduleRoomId(), source, event, prompt,
        title: args.title, when: args.when,
        ...(typeof args.repository === 'string' ? { repository: args.repository } : {}),
        ...(typeof args.channelId === 'string' ? { channelId: args.channelId } : {}),
        ...(typeof args.channelName === 'string' ? { channelName: args.channelName } : {}),
        ...(typeof args.workflowName === 'string' ? { workflowName: args.workflowName } : {}),
      });
      const receipt =
        typeof result.receipt === 'string' && result.receipt
          ? result.receipt
          : `Created subscription ${String(result.id)} · ${source} ${event} · ${result.registrationStatus === 'registering' ? 'registering webhook' : 'active'}`;
      return JSON.stringify({ ...result, receipt });
    }
    case 'delete_subscription': {
      const subscriptionId = stringArg(args, 'subscriptionId');
      if (!subscriptionId) throw new Error('subscriptionId is required');
      const deleted = await daemonExecute('deleteAgentSubscription', { roomId: agentScheduleRoomId(), subscriptionId });
      const receipt =
        typeof deleted.receipt === 'string' && deleted.receipt
          ? deleted.receipt
          : `Deleted subscription ${subscriptionId}`;
      return JSON.stringify({ ...deleted, subscriptionId, receipt });
    }
    case 'request_grant':
      return requestGrant(args);
    case 'list_grants':
      return listGrants();
    case 'connectors_status':
      return workbenchStatus();
    case 'create_link_spend_request': {
      const intent = normalizeApprovalIntent(args);
      const context = await activeCommandContext();
      const merchant = stringArg(args, 'merchant')?.trim();
      const merchantUrl = stringArg(args, 'merchantUrl')?.trim();
      const description = stringArg(args, 'description')?.trim();
      const amount = args.amount;
      if (!merchant || (args.credentialType !== 'shared_payment_token' && !merchantUrl)
        || !description || typeof amount !== 'number'
        || !Number.isSafeInteger(amount) || amount <= 0)
        throw new Error('merchant, merchantUrl, positive amount in cents, and description are required');
      const idempotencyKey = createHash('sha256').update(
        `link:${context.requestId}:${toolCallId || randomUUID()}`).digest('hex');
      return JSON.stringify(await daemonExecute('createLinkSpendRequest', {
        ...context, agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
        ...intent, merchant, ...(merchantUrl ? { merchantUrl } : {}), amount, description, idempotencyKey,
        ...(args.test === true ? { test: true } : {}),
        ...(args.credentialType === 'shared_payment_token'
          ? { credentialType: 'shared_payment_token', networkId: stringArg(args, 'networkId') }
          : {}),
      }));
    }
    case 'wait_link_spend_request': {
      const id = stringArg(args, 'id')?.trim();
      if (!id || !/^lsrq_[A-Za-z0-9]+$/.test(id)) throw new Error('valid Link request ID required');
      const context = await activeCommandContext();
      // Provider without correlated push support stays pending until an
      // explicit later tool action. A tool named wait cannot hide status polls.
      return JSON.stringify(await daemonExecute('retrieveLinkSpendRequest',{
        ...context,agentId:requiredEnv('BEELINE_DAEMON_AGENT_ID'),id}));
    }
    case 'connect': {
      const intent = normalizeApprovalIntent(args);
      const service = stringArg(args, 'service')?.trim();
      const reason = stringArg(args, 'reason')?.trim();
      if (!service || !reason) throw new Error('service and reason are required');
      const continuation = normalizeAppContinuation(args.continuation);
      const signedInUrl = stringArg(args, 'signedInUrl')?.trim();
      const { squireReach: reach, squireCall } = connectorOfferDepsFromEnv();
      // Refresh vault metadata before the server decides whether this app is ready.
      const squireAvailable = reach ? (await reach())?.reachable === true : false;
      const input = {
        ...await activeCommandContext(), service, reason, ...intent,
        squireAvailable,
        ...(continuation ? { continuation } : {}),
        ...(args.reconnect === true ? { reconnect: true } : {}),
        ...(args.noApi === true ? { noApi: true } : {}),
        ...(args.switchGoogleAccount === true ? { switchGoogleAccount: true } : {}),
        ...(signedInUrl ? { signedInUrl } : {}),
      };
      const result = await daemonExecute('connect', input) as unknown as ConnectResult;
      // A browser app signed in through OAuth or SSO has no login to save:
      // the agent's own signed-in Squire session is what makes it ready.
      if (result.status === 'needs_squire' && result.transport === 'squire-browser' && result.appKey &&
          signedInUrl && squireCall && await squireSessionSignedIn(squireCall, signedInUrl, result.appKey))
        return JSON.stringify(await daemonExecute('connect', { ...input, squireSignedIn: true }));
      return JSON.stringify(result);
    }
    case 'find_connectors': {
      const query = stringArg(args, 'query')?.trim();
      if (!query) throw new Error('query is required');
      return JSON.stringify(await daemonExecute('findConnectors', { roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'), query }));
    }
    case 'list_app_tools': {
      const appId = stringArg(args, 'appId');
      if (!appId) throw new Error('appId is required');
      return JSON.stringify(await daemonExecute('listAppTools', {
        ...await activeCommandContext(),
        agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
        appId,
        ...(typeof args.query === 'string' ? { query: args.query } : {}),
      }));
    }
    case 'execute_app_tool': {
      const appId = stringArg(args, 'appId');
      const tool = stringArg(args, 'tool');
      if (!appId || !tool || !args.arguments || typeof args.arguments !== 'object' ||
        Array.isArray(args.arguments)) throw new Error('appId, tool, and arguments are required');
      return JSON.stringify(await daemonExecute('executeAppTool', {
        ...await activeCommandContext(),
        agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
        appId, tool, arguments: args.arguments,
      }));
    }
    case 'post_starter_game':
      return JSON.stringify(await daemonExecute('postStarterGame', { ...await activeCommandContext() }));
    case 'post_starter_welcome':
      return JSON.stringify(await daemonExecute('postStarterWelcome', { ...await activeCommandContext() }));
    case 'post_chat_invite':
      return JSON.stringify(await daemonExecute('postRoomInvite', { ...await activeCommandContext() }));
    case 'post_repository_card':
    case 'post_starters_card':
      return JSON.stringify(await daemonExecute('postRepositoryOnboarding', {
        ...await activeCommandContext(), kind: name === 'post_repository_card' ? 'repository' : 'starters',
        ...(typeof args.repository === 'string' && args.repository.trim() ? { repository: args.repository.trim() } : {}),
      }));
    case 'store_secret':
      return storeSecret(args);
    case 'run_granted_command':
      return runGrantedCommand(args);
    case 'read_session_context':
    case 'call_session_mcp':
      return JSON.stringify(await sessionToolRequest('/session', {
        placeId: process.env.BEELINE_DAEMON_CORNER_ID || requiredEnv('BEELINE_DAEMON_ROOM_ID'),
        action: name === 'read_session_context' ? 'context' : 'mcp', ...args,
      }));
    case 'workspace': {
      const body = await sessionToolRequest('/workspace', {
        placeId: process.env.BEELINE_DAEMON_CORNER_ID || requiredEnv('BEELINE_DAEMON_ROOM_ID'),
        ...(process.env.BEELINE_DAEMON_CORNER_ID ? { parentRoomId: requiredEnv('BEELINE_DAEMON_ROOM_ID') } : {}),
      }) as { text: string };
      return body.text;
    }
    default:
      throw new Error(`tool is not available on the agent surface: ${name}`);
  }
}
