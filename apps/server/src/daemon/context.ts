import type { StarterOnboardingService } from '../starter-onboarding-run.js';
import type { CommandRow } from '../agent-command.js';
import type { SqlDatabase } from '../database.js';
import type { GitHubOperations, LandCornerOutcome } from '../github-operations.js';
import type { LiveHub } from '../live.js';
import type { McpRegistryClient } from '../mcp-registry.js';
import type { RegistryMcpOAuth } from '../registry-mcp-oauth.js';
import type { ComposioApps } from '../composio-apps.js';
import type { ObjectService } from '../object-service.js';
import type { InstitutionalMemoryShadowConfig } from '../institutional-memory-shadow.js';
import type { FeedbackLoop } from '../feedback.js';
import type { AfterCommit, EmbedFn } from '../institutional-memory-embeddings.js';
import type { OwnedModelConfiguration, Input, Output } from './values.js';
import type { daemonSetOwnedModel, daemonOwnedModelReady, daemonNegotiateOwnedModel, daemonModelClaimCredentials, daemonSetStarterOnboarding } from './owned-model.js';
import type { daemonReconcileZeroCheckWorkerCompletion } from './corner-completion.js';
import type { daemonConnectorAssignments, daemonConnectorInstall, daemonConnectorStatusReport, daemonResumeRegistrySignIn, daemonNotifyTailscaleSignIn, daemonConnectorVaultReport, daemonConnectorStatusView, daemonConnectorVaultList, daemonConnectionDetail, daemonConnectionGrantRevoke, daemonConnectionUsage } from './connectors.js';
import type { daemonBootstrap, daemonWorkspaceRoster, daemonInbox } from './inbox-roster.js';
import type { daemonRoomMessage, daemonRoomAttachment, daemonWithStoredDigests, daemonExpiredMediaIds } from './message-reads.js';
import type { daemonRoomAuthority, daemonPermissionAuthority, daemonMissionAuthority, daemonScheduleAuthority, daemonMandate, daemonTargetAuthority } from './authority.js';
import type { daemonCorners, daemonCornerRestore, daemonListCornerBriefRevisions, daemonMergeCorner, daemonCloseCornerPullRequest, daemonCheckReviewerAuthors, daemonApproveCornerMerge, daemonRepository, daemonTargetBranch } from './corner-reads.js';
import type { daemonIdentitySuccession, daemonConfiguration, daemonPresence, daemonReleaseReadiness } from './configuration.js';
import type { daemonCompletion, daemonPostRoomMessage, daemonPostAgentAttachment, daemonLiveOutput, daemonRetract, daemonPersistTurnTrace } from './messages.js';
import type { daemonTurnReceipt, daemonActivity } from './turn-receipts.js';
import type { daemonApprovalSource, daemonLinkSpendApproval, daemonSquireApproval, daemonSquireApprovalDecision, daemonSquireLoginWall, daemonPermissionRequest, daemonPermissionExecution } from './approvals.js';
import type { daemonCreateAgentSchedule, daemonRecordScheduleAuthorization, daemonSetEventSubscriptions, daemonListEventSubscriptions, daemonPostRoomEvent, daemonListAgentSchedules, daemonRequireScheduleAdmin, daemonDeleteAgentSchedule, daemonUpdateAgentSchedule } from './schedules-events.js';
import type { daemonPostMandate, daemonAgentAvatar, daemonCommands, daemonModelCatalog, daemonMachineReport } from './models.js';
import type { daemonReport, daemonWatchCorner, daemonCornerRemote, daemonCornerPlan, daemonBriefAttachmentRooms, daemonRenameCorner, daemonTargetProposal } from './corner-reports.js';
import type { daemonRequestAgentGrant, daemonAskRoomChoice, daemonOpenRoomPoll, daemonWriteRoomChoice, daemonListAgentGrants, daemonConsumeAgentGrant, daemonListAgentGrantRequests, daemonRepositoryOnboardingRequester, daemonGrantRequester, daemonFindGrantRequester, daemonAuthorizeSquireCall, daemonAuthorizeScopedGrant } from './grants.js';
import type { daemonAppCardMark, daemonOfferContext, daemonAgentWorkbench, daemonSearchMcpRegistry, daemonWarmConnectorIndex } from './workbench.js';
import type { daemonConnectService, daemonConnectAppFrontDoor, daemonConnectedAppForTool, daemonListAppTools, daemonExecuteAppTool } from './apps.js';
import type { daemonAuthorizeResource, daemonConnectMcpServer, daemonOfferConnector } from './connector-offers.js';
import type { daemonCreateCorner, daemonReviseCornerBrief, daemonArchiveCorner, daemonEnsureMembership } from './corner-writes.js';
import type { daemonIdentity, daemonReviewSourceAccess, daemonAccess, daemonRoomMembers } from './access.js';
import type { daemonPostCornerMessage, daemonPostAddressAccess, daemonReach, daemonReactToRoomMessage, daemonWriteResult } from './corner-messages.js';

/** Named service dependencies shared by ordinary and command-scoped handlers. */
export interface DaemonDependencies {
  readonly database: SqlDatabase;
  readonly live: LiveHub;
  readonly roomGitHubToken?: (
      roomId: string,
    ) => Promise<{ token: string; expiresAt: number }>;
  readonly mediaMaximumBytes: number;
  readonly commandTransaction: boolean;
  readonly authorizedCommand?: CommandRow;
  readonly livePaintDiagnostics: boolean;
  readonly liveDiagnosticServerInstance?: string;
  readonly prChecksStatus?: (
      input: Input<'getPrChecksStatus'>,
      confirmZeroChecks?: boolean,
    ) => Promise<Output<'getPrChecksStatus'> & { zeroChecksConfirmed?: boolean }>;
  readonly institutionalMemoryShadow: InstitutionalMemoryShadowConfig;
  readonly mcpRegistry: McpRegistryClient;
  readonly registryMcpOAuth?: RegistryMcpOAuth;
  readonly composio?: ComposioApps;
  readonly feedback: FeedbackLoop;
  readonly objects?: ObjectService;
  readonly linkWallet?: import('../link-agent-wallet.js').LinkAgentWallet;
  readonly refreshMergeability?: (cornerId: string) => Promise<void>;
  readonly landCorner?: (cornerId: string, onBlocked?: (reason: string) => void) => Promise<LandCornerOutcome>;
  readonly closePullRequest?: (
      cornerId: string,
    ) => Promise<
      | { status: 'closed'; number: number; url: string; title: string }
      | { status: 'blocked'; blocker: string }
    >;
  readonly readPullRequest?: (
      cornerId: string,
    ) => Promise<Output<'readCornerPullRequest'>>;
  readonly subscriptionReceiverUrl?: string;
  readonly github?: GitHubOperations;
}

export type CommandArguments<Handler> = Handler extends (ctx: infer _Context, ...args: infer Args) => unknown ? Args : never;

/** Handler capabilities are derived from their owners, never from the service facade. */
export interface DaemonContext extends DaemonDependencies {
  readonly dependencies: DaemonDependencies;
  ownedModel?: OwnedModelConfiguration;
  readonly modelClaims: WeakMap<object, { agentId: string; configuration: OwnedModelConfiguration }>;
  starterOnboarding?: StarterOnboardingService;
  memoryEmbed: EmbedFn | undefined;
  afterCommit: AfterCommit | undefined;
  setOwnedModel: (...args: CommandArguments<typeof daemonSetOwnedModel>) => ReturnType<typeof daemonSetOwnedModel>;
  ownedModelReady: (...args: CommandArguments<typeof daemonOwnedModelReady>) => ReturnType<typeof daemonOwnedModelReady>;
  negotiateOwnedModel: (...args: CommandArguments<typeof daemonNegotiateOwnedModel>) => ReturnType<typeof daemonNegotiateOwnedModel>;
  modelClaimCredentials: (...args: CommandArguments<typeof daemonModelClaimCredentials>) => ReturnType<typeof daemonModelClaimCredentials>;
  setStarterOnboarding: (...args: CommandArguments<typeof daemonSetStarterOnboarding>) => ReturnType<typeof daemonSetStarterOnboarding>;
  reconcileZeroCheckWorkerCompletion: (...args: CommandArguments<typeof daemonReconcileZeroCheckWorkerCompletion>) => ReturnType<typeof daemonReconcileZeroCheckWorkerCompletion>;
  connectorAssignments: (...args: CommandArguments<typeof daemonConnectorAssignments>) => ReturnType<typeof daemonConnectorAssignments>;
  connectorInstall: (...args: CommandArguments<typeof daemonConnectorInstall>) => ReturnType<typeof daemonConnectorInstall>;
  connectorStatusReport: (...args: CommandArguments<typeof daemonConnectorStatusReport>) => ReturnType<typeof daemonConnectorStatusReport>;
  resumeRegistrySignIn: (...args: CommandArguments<typeof daemonResumeRegistrySignIn>) => ReturnType<typeof daemonResumeRegistrySignIn>;
  notifyTailscaleSignIn: (...args: CommandArguments<typeof daemonNotifyTailscaleSignIn>) => ReturnType<typeof daemonNotifyTailscaleSignIn>;
  connectorVaultReport: (...args: CommandArguments<typeof daemonConnectorVaultReport>) => ReturnType<typeof daemonConnectorVaultReport>;
  connectorStatusView: (...args: CommandArguments<typeof daemonConnectorStatusView>) => ReturnType<typeof daemonConnectorStatusView>;
  connectorVaultList: (...args: CommandArguments<typeof daemonConnectorVaultList>) => ReturnType<typeof daemonConnectorVaultList>;
  connectionDetail: (...args: CommandArguments<typeof daemonConnectionDetail>) => ReturnType<typeof daemonConnectionDetail>;
  connectionGrantRevoke: (...args: CommandArguments<typeof daemonConnectionGrantRevoke>) => ReturnType<typeof daemonConnectionGrantRevoke>;
  connectionUsage: (...args: CommandArguments<typeof daemonConnectionUsage>) => ReturnType<typeof daemonConnectionUsage>;
  bootstrap: (...args: CommandArguments<typeof daemonBootstrap>) => ReturnType<typeof daemonBootstrap>;
  workspaceRoster: (...args: CommandArguments<typeof daemonWorkspaceRoster>) => ReturnType<typeof daemonWorkspaceRoster>;
  inbox: (...args: CommandArguments<typeof daemonInbox>) => ReturnType<typeof daemonInbox>;
  roomMessage: (...args: CommandArguments<typeof daemonRoomMessage>) => ReturnType<typeof daemonRoomMessage>;
  roomAttachment: (...args: CommandArguments<typeof daemonRoomAttachment>) => ReturnType<typeof daemonRoomAttachment>;
  withStoredDigests: (...args: CommandArguments<typeof daemonWithStoredDigests>) => ReturnType<typeof daemonWithStoredDigests>;
  expiredMediaIds: (...args: CommandArguments<typeof daemonExpiredMediaIds>) => ReturnType<typeof daemonExpiredMediaIds>;
  roomAuthority: (...args: CommandArguments<typeof daemonRoomAuthority>) => ReturnType<typeof daemonRoomAuthority>;
  permissionAuthority: (...args: CommandArguments<typeof daemonPermissionAuthority>) => ReturnType<typeof daemonPermissionAuthority>;
  missionAuthority: (...args: CommandArguments<typeof daemonMissionAuthority>) => ReturnType<typeof daemonMissionAuthority>;
  scheduleAuthority: (...args: CommandArguments<typeof daemonScheduleAuthority>) => ReturnType<typeof daemonScheduleAuthority>;
  mandate: (...args: CommandArguments<typeof daemonMandate>) => ReturnType<typeof daemonMandate>;
  targetAuthority: (...args: CommandArguments<typeof daemonTargetAuthority>) => ReturnType<typeof daemonTargetAuthority>;
  corners: (...args: CommandArguments<typeof daemonCorners>) => ReturnType<typeof daemonCorners>;
  cornerRestore: (...args: CommandArguments<typeof daemonCornerRestore>) => ReturnType<typeof daemonCornerRestore>;
  listCornerBriefRevisions: (...args: CommandArguments<typeof daemonListCornerBriefRevisions>) => ReturnType<typeof daemonListCornerBriefRevisions>;
  mergeCorner: (...args: CommandArguments<typeof daemonMergeCorner>) => ReturnType<typeof daemonMergeCorner>;
  closeCornerPullRequest: (...args: CommandArguments<typeof daemonCloseCornerPullRequest>) => ReturnType<typeof daemonCloseCornerPullRequest>;
  checkReviewerAuthors: (...args: CommandArguments<typeof daemonCheckReviewerAuthors>) => ReturnType<typeof daemonCheckReviewerAuthors>;
  approveCornerMerge: (...args: CommandArguments<typeof daemonApproveCornerMerge>) => ReturnType<typeof daemonApproveCornerMerge>;
  repository: (...args: CommandArguments<typeof daemonRepository>) => ReturnType<typeof daemonRepository>;
  targetBranch: (...args: CommandArguments<typeof daemonTargetBranch>) => ReturnType<typeof daemonTargetBranch>;
  identitySuccession: (...args: CommandArguments<typeof daemonIdentitySuccession>) => ReturnType<typeof daemonIdentitySuccession>;
  configuration: (...args: CommandArguments<typeof daemonConfiguration>) => ReturnType<typeof daemonConfiguration>;
  presence: (...args: CommandArguments<typeof daemonPresence>) => ReturnType<typeof daemonPresence>;
  releaseReadiness: (...args: CommandArguments<typeof daemonReleaseReadiness>) => ReturnType<typeof daemonReleaseReadiness>;
  completion: (...args: CommandArguments<typeof daemonCompletion>) => ReturnType<typeof daemonCompletion>;
  postRoomMessage: (...args: CommandArguments<typeof daemonPostRoomMessage>) => ReturnType<typeof daemonPostRoomMessage>;
  postAgentAttachment: (...args: CommandArguments<typeof daemonPostAgentAttachment>) => ReturnType<typeof daemonPostAgentAttachment>;
  liveOutput: (...args: CommandArguments<typeof daemonLiveOutput>) => ReturnType<typeof daemonLiveOutput>;
  retract: (...args: CommandArguments<typeof daemonRetract>) => ReturnType<typeof daemonRetract>;
  persistTurnTrace: (...args: CommandArguments<typeof daemonPersistTurnTrace>) => ReturnType<typeof daemonPersistTurnTrace>;
  turnReceipt: (...args: CommandArguments<typeof daemonTurnReceipt>) => ReturnType<typeof daemonTurnReceipt>;
  activity: (...args: CommandArguments<typeof daemonActivity>) => ReturnType<typeof daemonActivity>;
  approvalSource: (...args: CommandArguments<typeof daemonApprovalSource>) => ReturnType<typeof daemonApprovalSource>;
  linkSpendApproval: (...args: CommandArguments<typeof daemonLinkSpendApproval>) => ReturnType<typeof daemonLinkSpendApproval>;
  squireApproval: (...args: CommandArguments<typeof daemonSquireApproval>) => ReturnType<typeof daemonSquireApproval>;
  squireApprovalDecision: (...args: CommandArguments<typeof daemonSquireApprovalDecision>) => ReturnType<typeof daemonSquireApprovalDecision>;
  squireLoginWall: (...args: CommandArguments<typeof daemonSquireLoginWall>) => ReturnType<typeof daemonSquireLoginWall>;
  permissionRequest: (...args: CommandArguments<typeof daemonPermissionRequest>) => ReturnType<typeof daemonPermissionRequest>;
  permissionExecution: (...args: CommandArguments<typeof daemonPermissionExecution>) => ReturnType<typeof daemonPermissionExecution>;
  createAgentSchedule: (...args: CommandArguments<typeof daemonCreateAgentSchedule>) => ReturnType<typeof daemonCreateAgentSchedule>;
  recordScheduleAuthorization: (...args: CommandArguments<typeof daemonRecordScheduleAuthorization>) => ReturnType<typeof daemonRecordScheduleAuthorization>;
  setEventSubscriptions: (...args: CommandArguments<typeof daemonSetEventSubscriptions>) => ReturnType<typeof daemonSetEventSubscriptions>;
  listEventSubscriptions: (...args: CommandArguments<typeof daemonListEventSubscriptions>) => ReturnType<typeof daemonListEventSubscriptions>;
  postRoomEvent: (...args: CommandArguments<typeof daemonPostRoomEvent>) => ReturnType<typeof daemonPostRoomEvent>;
  listAgentSchedules: (...args: CommandArguments<typeof daemonListAgentSchedules>) => ReturnType<typeof daemonListAgentSchedules>;
  requireScheduleAdmin: (...args: CommandArguments<typeof daemonRequireScheduleAdmin>) => ReturnType<typeof daemonRequireScheduleAdmin>;
  deleteAgentSchedule: (...args: CommandArguments<typeof daemonDeleteAgentSchedule>) => ReturnType<typeof daemonDeleteAgentSchedule>;
  updateAgentSchedule: (...args: CommandArguments<typeof daemonUpdateAgentSchedule>) => ReturnType<typeof daemonUpdateAgentSchedule>;
  postMandate: (...args: CommandArguments<typeof daemonPostMandate>) => ReturnType<typeof daemonPostMandate>;
  agentAvatar: (...args: CommandArguments<typeof daemonAgentAvatar>) => ReturnType<typeof daemonAgentAvatar>;
  commands: (...args: CommandArguments<typeof daemonCommands>) => ReturnType<typeof daemonCommands>;
  modelCatalog: (...args: CommandArguments<typeof daemonModelCatalog>) => ReturnType<typeof daemonModelCatalog>;
  machineReport: (...args: CommandArguments<typeof daemonMachineReport>) => ReturnType<typeof daemonMachineReport>;
  report: (...args: CommandArguments<typeof daemonReport>) => ReturnType<typeof daemonReport>;
  watchCorner: (...args: CommandArguments<typeof daemonWatchCorner>) => ReturnType<typeof daemonWatchCorner>;
  cornerRemote: (...args: CommandArguments<typeof daemonCornerRemote>) => ReturnType<typeof daemonCornerRemote>;
  cornerPlan: (...args: CommandArguments<typeof daemonCornerPlan>) => ReturnType<typeof daemonCornerPlan>;
  briefAttachmentRooms: (...args: CommandArguments<typeof daemonBriefAttachmentRooms>) => ReturnType<typeof daemonBriefAttachmentRooms>;
  renameCorner: (...args: CommandArguments<typeof daemonRenameCorner>) => ReturnType<typeof daemonRenameCorner>;
  targetProposal: (...args: CommandArguments<typeof daemonTargetProposal>) => ReturnType<typeof daemonTargetProposal>;
  requestAgentGrant: (...args: CommandArguments<typeof daemonRequestAgentGrant>) => ReturnType<typeof daemonRequestAgentGrant>;
  askRoomChoice: (...args: CommandArguments<typeof daemonAskRoomChoice>) => ReturnType<typeof daemonAskRoomChoice>;
  openRoomPoll: (...args: CommandArguments<typeof daemonOpenRoomPoll>) => ReturnType<typeof daemonOpenRoomPoll>;
  writeRoomChoice: (...args: CommandArguments<typeof daemonWriteRoomChoice>) => ReturnType<typeof daemonWriteRoomChoice>;
  listAgentGrants: (...args: CommandArguments<typeof daemonListAgentGrants>) => ReturnType<typeof daemonListAgentGrants>;
  consumeAgentGrant: (...args: CommandArguments<typeof daemonConsumeAgentGrant>) => ReturnType<typeof daemonConsumeAgentGrant>;
  listAgentGrantRequests: (...args: CommandArguments<typeof daemonListAgentGrantRequests>) => ReturnType<typeof daemonListAgentGrantRequests>;
  repositoryOnboardingRequester: (...args: CommandArguments<typeof daemonRepositoryOnboardingRequester>) => ReturnType<typeof daemonRepositoryOnboardingRequester>;
  grantRequester: (...args: CommandArguments<typeof daemonGrantRequester>) => ReturnType<typeof daemonGrantRequester>;
  findGrantRequester: (...args: CommandArguments<typeof daemonFindGrantRequester>) => ReturnType<typeof daemonFindGrantRequester>;
  authorizeSquireCall: (...args: CommandArguments<typeof daemonAuthorizeSquireCall>) => ReturnType<typeof daemonAuthorizeSquireCall>;
  authorizeScopedGrant: (...args: CommandArguments<typeof daemonAuthorizeScopedGrant>) => ReturnType<typeof daemonAuthorizeScopedGrant>;
  appCardMark: (...args: CommandArguments<typeof daemonAppCardMark>) => ReturnType<typeof daemonAppCardMark>;
  offerContext: (...args: CommandArguments<typeof daemonOfferContext>) => ReturnType<typeof daemonOfferContext>;
  agentWorkbench: (...args: CommandArguments<typeof daemonAgentWorkbench>) => ReturnType<typeof daemonAgentWorkbench>;
  searchMcpRegistry: (...args: CommandArguments<typeof daemonSearchMcpRegistry>) => ReturnType<typeof daemonSearchMcpRegistry>;
  warmConnectorIndex: (...args: CommandArguments<typeof daemonWarmConnectorIndex>) => ReturnType<typeof daemonWarmConnectorIndex>;
  connectService: (...args: CommandArguments<typeof daemonConnectService>) => ReturnType<typeof daemonConnectService>;
  connectAppFrontDoor: (...args: CommandArguments<typeof daemonConnectAppFrontDoor>) => ReturnType<typeof daemonConnectAppFrontDoor>;
  connectedAppForTool: (...args: CommandArguments<typeof daemonConnectedAppForTool>) => ReturnType<typeof daemonConnectedAppForTool>;
  listAppTools: (...args: CommandArguments<typeof daemonListAppTools>) => ReturnType<typeof daemonListAppTools>;
  executeAppTool: (...args: CommandArguments<typeof daemonExecuteAppTool>) => ReturnType<typeof daemonExecuteAppTool>;
  authorizeResource: (...args: CommandArguments<typeof daemonAuthorizeResource>) => ReturnType<typeof daemonAuthorizeResource>;
  connectMcpServer: (...args: CommandArguments<typeof daemonConnectMcpServer>) => ReturnType<typeof daemonConnectMcpServer>;
  offerConnector: (...args: CommandArguments<typeof daemonOfferConnector>) => ReturnType<typeof daemonOfferConnector>;
  createCorner: (...args: CommandArguments<typeof daemonCreateCorner>) => ReturnType<typeof daemonCreateCorner>;
  reviseCornerBrief: (...args: CommandArguments<typeof daemonReviseCornerBrief>) => ReturnType<typeof daemonReviseCornerBrief>;
  archiveCorner: (...args: CommandArguments<typeof daemonArchiveCorner>) => ReturnType<typeof daemonArchiveCorner>;
  ensureMembership: (...args: CommandArguments<typeof daemonEnsureMembership>) => ReturnType<typeof daemonEnsureMembership>;
  identity: (...args: CommandArguments<typeof daemonIdentity>) => ReturnType<typeof daemonIdentity>;
  reviewSourceAccess: (...args: CommandArguments<typeof daemonReviewSourceAccess>) => ReturnType<typeof daemonReviewSourceAccess>;
  access: (...args: CommandArguments<typeof daemonAccess>) => ReturnType<typeof daemonAccess>;
  roomMembers: (...args: CommandArguments<typeof daemonRoomMembers>) => ReturnType<typeof daemonRoomMembers>;
  postCornerMessage: (...args: CommandArguments<typeof daemonPostCornerMessage>) => ReturnType<typeof daemonPostCornerMessage>;
  postAddressAccess: (...args: CommandArguments<typeof daemonPostAddressAccess>) => ReturnType<typeof daemonPostAddressAccess>;
  reach: (...args: CommandArguments<typeof daemonReach>) => ReturnType<typeof daemonReach>;
  reactToRoomMessage: (...args: CommandArguments<typeof daemonReactToRoomMessage>) => ReturnType<typeof daemonReactToRoomMessage>;
  writeResult: (...args: CommandArguments<typeof daemonWriteResult>) => ReturnType<typeof daemonWriteResult>;
}
