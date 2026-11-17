import { commandGrantAction,connectionInstallName,interpreterScriptArgument,isCommandGrantScript,type AgentGrantKind,type CommandGrantRule,type CommandGrantScript } from '@beeline/api-contract/agent-grants';
import type { DaemonAttachment,DaemonOperationMap } from '@beeline/api-contract/daemon';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { createHash,randomBytes } from 'node:crypto';
import { MESSAGE_CURSOR_MS_SQL } from '../database.js';
import { mediaIdFromUrl } from '../media-ttl.js';
import { OwnedModelCredentials } from '../owned-model-credential.js';
import { type SystemPhrase } from '../system-line.js';



export type Input<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['input'];

export type Output<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['output'];

export const id = () => randomBytes(32).toString('hex');


/**
 * A system line's subject is spoken in the Ledger's own voice, so it is the
 * PINNED registry coordinate, never the publisher's free-text title: a title
 * of `@dani` would otherwise render as a person. The leading `@` is stripped
 * so no coordinate can read as a handle either.
 */
export function registrySubject(serverName: string | null): string {
  return serverName?.replace(/^@+/, '').trim() || systemMessage("daemon-service.mcp-server");
}


export function registryMcpRouteName(serverName: string, connectorId: string): string {
  const slug = serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `registry-${slug || 'mcp'}-${connectorId.slice(0, 8)}`;
}


export const seconds = (date: Date) => Math.floor(date.getTime() / 1_000);


export { MAX_REPLY_NOTE_LENGTH,MAX_REPLY_STEPS,MAX_REPLY_STEPS_BYTES,replySteps } from '../answer-activity.js';

/** Corner reads and merge writes that also admit a current parent Room member. */
export const CORNER_REACH_OPERATIONS = new Set<string>([
  'getCornerRestoreState',
  'getPrChecksStatus',
  'getRoomAuthority',
  'getRoomConversation',
  'listCornerBriefRevisions',
  'listRoomMembers',
  'readCornerPullRequest',
  'mergeCorner',
  'approveCornerMerge',
]);

/** Closed corners still expose cleanup/history facts. */
export const CORNER_CLEANUP_OPERATIONS = new Set<string>([
  'getCornerCloseRequests',
  'getRoomInbox',
]);


/**
 * An expired attachment is named, not hidden: the agent is told the bytes are
 * gone so it says so, instead of reporting a download that "failed".
 */
export function markExpiredAttachments(
  attachments: readonly DaemonAttachment[],
  expired: ReadonlySet<string>,
): DaemonAttachment[] {
  if (!expired.size) return [...attachments];
  return attachments.map((attachment) => {
    const id = mediaIdFromUrl(attachment.url);
    return id && expired.has(id) ? { ...attachment, expired: true } : attachment;
  });
}


export const MEDIA_URL_PATTERN = /\/v1\/media\/([0-9a-f-]{36})$/;

export const DEFAULT_MEDIA_MAXIMUM_BYTES = 25 * 1024 * 1024;


/**
 * The caller is not a current member of the Room or corner it addressed.
 *
 * This is the one refusal `access` itself makes. A database or transport
 * failure while checking membership is a different error and must stay one:
 * translating an outage into a membership refusal hides the outage from the
 * caller and from the route's 503 default.
 */
export class AccessDeniedError extends Error {
  constructor() {
    super('daemon chat access denied');
  }
}


export type OwnedModelConfiguration = Readonly<{ credentials: OwnedModelCredentials; ready(): boolean }>;



/**
 * The script bytes the daemon read for an interpreter command, checked against
 * the line they claim to belong to. The server never reads the operator's
 * filesystem, so this validates the daemon's reading rather than repeating it;
 * the runner re-hashes the file before every run.
 */
export function validateGrantScript(
  rule: CommandGrantRule,
  script: unknown,
): CommandGrantScript | undefined {
  const argument = interpreterScriptArgument(rule.argv);
  if (rule.stdin !== undefined && !argument?.stdin) throw new Error('grant stdin is invalid: only interpreter stdin code is supported');
  if (script === undefined || script === null) {
    if (argument?.inline !== undefined || argument?.stdin)
      throw new Error('grant script is required: show the exact inline or stdin code');
    return undefined;
  }
  if (!argument) throw new Error('grant script is only for an interpreter command');
  if (!isCommandGrantScript(script)) throw new Error('grant script is invalid');
  if (script.path !== argument.path) {
    throw new Error(`grant script must be the command's script argument (${argument.path})`);
  }
  if (argument.inline !== undefined && script.contents !== argument.inline)
    throw new Error('grant script is invalid: inline code does not match the command');
  if (argument.stdin && script.contents !== rule.stdin)
    throw new Error('grant script is invalid: stdin code does not match the command');
  // The hash is the binding, so the server re-derives it rather than trusting
  // the number it was handed: the bytes on the card and the bytes the runner
  // will check must be the same bytes.
  if (
    script.bytes !== Buffer.byteLength(script.contents) ||
    createHash('sha256').update(script.contents).digest('hex') !== script.sha256
  ) {
    throw new Error('grant script is invalid: its hash does not match its contents');
  }
  return { path: script.path, sha256: script.sha256, bytes: script.bytes, contents: script.contents };
}


/** One action line for each remaining permission ask. */
export function grantCardPhrase(
  _requester: { pubkey: string; kind: 'human' | 'agent'; name: string },
  agent: { pubkey: string; name: string },
  grants: readonly { kind: AgentGrantKind; target: string; appName?: string; purpose?: string; machine?: string; script?: unknown }[],
): SystemPhrase {
  if (grants.every(grant => connectionInstallName(grant))) {
    return { subject: { kind: 'agent', id: agent.pubkey, name: agent.name },
      verb: systemMessage("daemon-service.wants-to-connect"), object: grants.map(grant => connectionInstallName(grant)).join(systemMessage("daemon-service.and")) };
  }
  const verbs: Record<AgentGrantKind, string> = {
    command: systemMessage("daemon-service.run"),
    path: systemMessage("daemon-service.read"),
    repository: systemMessage("daemon-service.edit"),
    secret: systemMessage("daemon-service.use"),
    device: systemMessage("daemon-service.use"),
    mcp: systemMessage("daemon-service.use"),
    host: systemMessage("daemon-service.reach"),
    budget: systemMessage("daemon-service.spend"),
    shared_asset: systemMessage("daemon-service.isolate"),
  };
  return {
    subject: { kind: 'agent', id: agent.pubkey, name: agent.name },
    verb: systemMessage("daemon-service.wants-to"),
    object: grants.map(grant => {
      const app = connectionInstallName(grant);
      if (grant.kind === 'command') return commandGrantAction(grant);
      return app ? systemMessage("daemon-service.connect-app", app)
        : systemMessage("daemon-service.grant-action", verbs[grant.kind], grant.target);
    }).join(systemMessage("daemon-service.and")),
  };
}


/** The one projection an inbox or conversation row is read through. */
export const conversationColumns = `SELECT id,author_id,created_at,presentation,text,
        EXISTS(SELECT 1 FROM identities author
               WHERE author.id=messages.author_id AND author.kind='agent') agent_author,
        reply_to_message_id,
        (SELECT parent.author_id FROM messages parent WHERE parent.id=messages.reply_to_message_id) reply_to_author_id,
        (SELECT author.name FROM messages parent JOIN identities author ON author.id=parent.author_id
         WHERE parent.id=messages.reply_to_message_id) reply_to_author_name,
        (SELECT left(parent.text,16001) FROM messages parent
         WHERE parent.id=messages.reply_to_message_id) reply_to_excerpt,
        root_message_id,request_id,
        (SELECT request.author_id FROM messages request WHERE request.id=messages.request_id) request_author_id,
        agent_hop_count,attachments,system_event,
        CASE WHEN chat_seq IS NOT NULL THEN '¶'||beeline_room_handle(author_id,room_id)||'-'||chat_seq END message_link,
        ${MESSAGE_CURSOR_MS_SQL} cursor_ms,
        floor(extract(epoch FROM now())*1000)::bigint now_ms`;


export function laterCursor(
  candidate: string | undefined,
  previous: string | undefined,
): string | undefined {
  if (!candidate) return previous;
  if (!previous) return candidate;
  const [candidateMs, candidateId] = candidate.split(',') as [string, string];
  const [previousMs, previousId] = previous.split(',') as [string, string];
  const milliseconds = BigInt(candidateMs) - BigInt(previousMs);
  return milliseconds > 0 || (milliseconds === 0n && candidateId > previousId)
    ? candidate
    : previous;
}


/**
 * Every daemon operation the HTTP route serves, as an EXHAUSTIVE record so a
 * new operation cannot ship unroutable. `waitForCornerWake` did exactly that
 * in #912: the route answered every call 404 `unknown_daemon_operation`
 * instantly, and the corner intake loop's sleep-vs-wake race — which treated a
 * failed wake as "resolved" — became a spin against the server.
 */
export const DAEMON_OPERATION_ROUTES: Record<keyof DaemonOperationMap, true> = {
  getInstitutionalContext: true,
  saveInstitutionalMemory: true,
  updateInstitutionalMemory: true,
  deleteInstitutionalMemory: true,
  reportInstitutionalMemoryUsed: true,
  searchInstitutionalMemory: true,
  searchInstitutionalHistory: true,
  getInstitutionalMemoryTurnStats: true,
  loadWorkspaceSkill: true,
  saveSkill: true,
  deleteSkill: true,
  saveWorkflow: true,
  startWorkflow: true,
  getWorkflowRun: true,
  cancelWorkflowRun: true,
  handoff: true,
  archiveWorkflow: true,
  assignWorkflowRole: true,
  getDaemonBootstrap: true,
  getWorkspaceRoster: true,
  getOwedMentions: true,
  getRoomInbox: true,
  getRoomConversation: true,
  getRoomMessage: true,
  order: true,
  message: true,
  reply: true,
  stopAgentTurn: true,
  report: true,
  read: true,
  getRoomAuthority: true,
  getPermissionAuthority: true,
  getMissionAuthority: true,
  getWorkScheduleAuthority: true,
  createAgentSchedule: true,
  setEventSubscriptions: true,
  createAgentSubscription: true,
  listServiceSubscriptionEvents: true,
  listAgentSubscriptions: true,
  deleteAgentSubscription: true,
  setAgentWakePaused: true,
  watchCorner: true,
  listEventSubscriptions: true,
  postRoomEvent: true,
  listAgentSchedules: true,
  listAgentWatches: true,
  deleteAgentSchedule: true,
  updateAgentSchedule: true,
  getAgentToolMandate: true,
  getTargetAgentAuthority: true,
  listRoomCorners: true,
  getCornerRestoreState: true,
  listCornerBriefRevisions: true,
  reviseCornerBrief: true,
  getPrChecksStatus: true,
  approveCornerMerge: true,
  mergeCorner: true,
  listRooms: true,
  listReachableCorners: true,
  listRoomMembers: true,
  readCornerPullRequest: true,
  postCornerMessage: true,
  getCornerCloseRequests: true,
  listUntrackedCorners: true,
  getRoomRepositoryState: true,
  getRoomGitHubToken: true,
  becomeImplementer: true,
  dispatchRoomWorkflow: true,
  getRoomTargetBranch: true,
  getIdentitySuccession: true,
  getAgentConfiguration: true,
  getAgentPresence: true,
  getRequestCompletion: true,
  getAgentCommands: true,
  getModelCredential: true,
  startAgentTurn: true,
  postRoomMessage: true,
  reactToRoomMessage: true,
  postAgentAttachment: true,
  postAgentDraft: true,
  postAgentThought: true,
  retractAgentLiveOutput: true,
  postAgentTurnReceipt: true,
  markAgentTurnSilent: true,
  postAgentActivity: true,
  postBackgroundToolCompletion: true,
  postSquireApproval: true,
  postComputerSession: true,
  endComputerSession: true,
  refreshComputerSession: true,
  postSquireLoginWall: true,
  postSquireApprovalDecision: true,
  postPermissionRequest: true,
  postPermissionExecution: true,
  postAgentToolMandate: true,
  getAgentAvatar: true,
  postAgentAvatar: true,
  postAgentUsage: true,
  publishAgentUsageAccount:true,
  attachAgentUsageAccount:true,
  getAgentUsage: true,
  answerUsageRefresh: true,
  postAgentCommands: true,
  postAgentModelCatalog: true,
  postAgentMachineReport: true,
  getConnectorAssignments: true,
  completeProviderWebhookAssignment: true,
  reportAgentSignIn: true,
  getGoogleOAuthGrant: true,
  createLinkSpendRequest: true,
  retrieveLinkSpendRequest: true,
  getRoomGoogleGrant: true,
  beginRegistryMcpOAuth: true,
  claimRegistryMcpOAuthCode: true,
  installConnector: true,
  postConnectorStatus: true,
  postConnectorVault: true,
  forgetSquireSignIn: true,
  getConnectorStatus: true,
  getConnectorVaultList: true,
  getConnectionDetail: true,
  revokeConnectionGrants: true,
  postConnectionUsage: true,
  postCornerRemoteState: true,
  postCornerPlan: true,
  renameCorner: true,
  postTargetBranchProposal: true,
  requestAgentGrant: true,
  postRepositoryOnboarding: true,
  postRoomInvite: true,
  postStarterWelcome: true,
  postStarterGame: true,
  askRoomChoice: true,
  askOwnerQuestion: true,
  addWorkNote: true,
  attachToWorkItem: true,
  updateWorkItem: true,
  openRoomPoll: true,
  listAgentGrants: true,
  listAgentGrantRequests: true,
  consumeAgentGrant: true,
  authorizeSquireCall: true,
  authorizeResourceCall: true,
  authorizeRepositoryCall: true,
  authorizeHostCall: true,
  listTurnAgentGrants: true,
  readAgentWorkbench: true,
  searchMcpRegistry: true,
  connectMcpServer: true,
  connectApp: true,
  connect: true,
  findConnectors: true,
  listAppTools: true,
  executeAppTool: true,
  offerConnector: true,
  postVaultSaveCard: true,
  createCorner: true,
  setCornerHold: true,
  archiveCorner: true,
  ensureAgentMembership: true,
  getWalletToolState: true,
  getWalletToolBalance: true,
  getWalletToolChains: true,
  getWalletToolHistory: true,
  getWalletToolQuote: true,
  walletPay: true,
  walletSwap: true,
  walletContractCall: true,
  walletSignTypedData: true,
  reportFeedback: true,
  notifyFeedbackFixed: true,
  sendOperatorSystemDm: true,
  readOperatorSystemDm: true,
};
