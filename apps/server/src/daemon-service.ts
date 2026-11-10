import { githubProviderKey } from './providers/index.js';
import type { CommandArguments, DaemonDependencies, DaemonContext } from './daemon/context.js';
import type { HelperTurnOwnershipSource } from '@beeline/api-contract/helper-turn-ownership';
import type { StarterOnboardingService } from './starter-onboarding-run.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import { type CommandRow } from './agent-command.js';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { DEFAULT_MCP_REGISTRY_CLIENT } from './mcp-registry.js';
import { feedbackConfigFromEnv } from './feedback.js';
import type { AfterCommit, EmbedFn } from './institutional-memory-embeddings.js';
import { OwnedModelConfiguration, DEFAULT_MEDIA_MAXIMUM_BYTES } from './daemon/values.js';
import { daemonSetOwnedModel, daemonOwnedModelReady, daemonNegotiateOwnedModel, daemonModelClaimCredentials, daemonSetStarterOnboarding, daemonLockOwnedTurnAccess, daemonFenceOwnedTurnReply, daemonReadCommandActivation } from './daemon/owned-model.js';
import { daemonExecute } from './daemon/execute.js';
import { daemonReconcileZeroCheckWorkerCompletion } from './daemon/corner-completion.js';
import { daemonConnectorAssignments, daemonConnectorInstall, daemonConnectorStatusReport, daemonResumeRegistrySignIn, daemonNotifyTailscaleSignIn, daemonConnectorVaultReport, daemonConnectorStatusView, daemonConnectorVaultList, daemonConnectionDetail, daemonConnectionGrantRevoke, daemonConnectionUsage } from './daemon/connectors.js';
import { daemonBootstrap, daemonWorkspaceRoster, daemonInbox } from './daemon/inbox-roster.js';
import { daemonRoomMessage, daemonRoomAttachment, daemonWithStoredDigests, daemonExpiredMediaIds } from './daemon/message-reads.js';
import { daemonRoomAuthority, daemonPermissionAuthority, daemonMissionAuthority, daemonScheduleAuthority, daemonMandate, daemonTargetAuthority } from './daemon/authority.js';
import { daemonCorners, daemonCornerRestore, daemonListCornerBriefRevisions, daemonMergeCorner, daemonCloseCornerPullRequest, daemonCheckReviewerAuthors, daemonApproveCornerMerge, daemonRepository, daemonTargetBranch } from './daemon/corner-reads.js';
import { daemonIdentitySuccession, daemonConfiguration, daemonPresence, daemonReleaseReadiness } from './daemon/configuration.js';
import { daemonCompletion, daemonPostRoomMessage, daemonPostAgentAttachment, daemonLiveOutput, daemonRetract, daemonPersistTurnTrace } from './daemon/messages.js';
import { daemonTurnReceipt, daemonActivity } from './daemon/turn-receipts.js';
import { daemonApprovalSource, daemonLinkSpendApproval, daemonSquireApproval, daemonSquireApprovalDecision, daemonSquireLoginWall, daemonPermissionRequest, daemonPermissionExecution } from './daemon/approvals.js';
import { daemonCreateAgentSchedule, daemonRecordScheduleAuthorization, daemonSetEventSubscriptions, daemonListEventSubscriptions, daemonPostRoomEvent, daemonListAgentSchedules, daemonRequireScheduleAdmin, daemonDeleteAgentSchedule, daemonUpdateAgentSchedule } from './daemon/schedules-events.js';
import { daemonPostMandate, daemonAgentAvatar, daemonCommands, daemonModelCatalog, daemonMachineReport } from './daemon/models.js';
import { daemonReport, daemonWatchCorner, daemonCornerRemote, daemonCornerPlan, daemonBriefAttachmentRooms, daemonRenameCorner, daemonTargetProposal } from './daemon/corner-reports.js';
import { daemonRequestAgentGrant, daemonAskRoomChoice, daemonOpenRoomPoll, daemonWriteRoomChoice, daemonListAgentGrants, daemonConsumeAgentGrant, daemonListAgentGrantRequests, daemonRepositoryOnboardingRequester, daemonGrantRequester, daemonFindGrantRequester, daemonAuthorizeSquireCall, daemonAuthorizeScopedGrant } from './daemon/grants.js';
import { daemonAppCardMark, daemonOfferContext, daemonAgentWorkbench, daemonSearchMcpRegistry, daemonWarmConnectorIndex } from './daemon/workbench.js';
import { daemonConnectService, daemonConnectAppFrontDoor, daemonConnectedAppForTool, daemonListAppTools, daemonExecuteAppTool } from './daemon/apps.js';
import { daemonAuthorizeResource, daemonConnectMcpServer, daemonOfferConnector } from './daemon/connector-offers.js';
import { daemonCreateCorner, daemonReviseCornerBrief, daemonArchiveCorner, daemonEnsureMembership } from './daemon/corner-writes.js';
import { daemonIdentity, daemonReviewSourceAccess, daemonAccess, daemonRoomMembers } from './daemon/access.js';
import { daemonPostCornerMessage, daemonPostAddressAccess, daemonReach, daemonReactToRoomMessage, daemonWriteResult } from './daemon/corner-messages.js';

export type { OwnedModelClaimCapability } from './daemon/values.js';
export type { OwnedModelNegotiation } from './daemon/values.js';
export { DAEMON_OPERATION_NAMES } from './daemon/operation-names.js';

export class DaemonService {
  get dependencies(): DaemonDependencies {
    const {
      database, live, roomGitHubToken, mediaMaximumBytes,
      commandTransaction, authorizedCommand, livePaintDiagnostics, liveDiagnosticServerInstance,
      prChecksStatus, institutionalMemoryShadow, mcpRegistry, registryMcpOAuth,
      composio, feedback, objects, linkWallet,
      refreshMergeability, landCorner, closePullRequest, readPullRequest,
      subscriptionReceiverUrl, github,
    } = this;
    return {
      database, live, roomGitHubToken, mediaMaximumBytes,
      commandTransaction, authorizedCommand, livePaintDiagnostics, liveDiagnosticServerInstance,
      prChecksStatus, institutionalMemoryShadow, mcpRegistry, registryMcpOAuth,
      composio, feedback, objects, linkWallet,
      refreshMergeability, landCorner, closePullRequest, readPullRequest,
      subscriptionReceiverUrl, github,
    };
  }

  /** Construct from named dependencies without another positional forwarding list. */
  static fromDependencies(dependencies: DaemonDependencies): DaemonService {
    const service = new DaemonService(dependencies.database, dependencies.live);
    Object.assign(service, dependencies, { database: service.database });
    return service;
  }

   ownedModel?: OwnedModelConfiguration;

   readonly modelClaims = new WeakMap<object, { agentId: string; source: HelperTurnOwnershipSource; configuration: OwnedModelConfiguration }>();
  setOwnedModel(...args: CommandArguments<typeof daemonSetOwnedModel>): ReturnType<typeof daemonSetOwnedModel> { return daemonSetOwnedModel(this, ...args); }
  ownedModelReady(...args: CommandArguments<typeof daemonOwnedModelReady>): ReturnType<typeof daemonOwnedModelReady> { return daemonOwnedModelReady(this, ...args); }
  async negotiateOwnedModel(...args: CommandArguments<typeof daemonNegotiateOwnedModel>): ReturnType<typeof daemonNegotiateOwnedModel> { return daemonNegotiateOwnedModel(this, ...args); }
  modelClaimCredentials(...args: CommandArguments<typeof daemonModelClaimCredentials>): ReturnType<typeof daemonModelClaimCredentials> { return daemonModelClaimCredentials(this, ...args); }

   starterOnboarding?: StarterOnboardingService;
  setStarterOnboarding(...args: CommandArguments<typeof daemonSetStarterOnboarding>): ReturnType<typeof daemonSetStarterOnboarding> { return daemonSetStarterOnboarding(this, ...args); }
  async lockOwnedTurnAccess(...args: CommandArguments<typeof daemonLockOwnedTurnAccess>): ReturnType<typeof daemonLockOwnedTurnAccess> { return daemonLockOwnedTurnAccess(this, ...args); }
  async fenceOwnedTurnReply(...args: CommandArguments<typeof daemonFenceOwnedTurnReply>): ReturnType<typeof daemonFenceOwnedTurnReply> { return daemonFenceOwnedTurnReply(this, ...args); }
  async readCommandActivation(...args: CommandArguments<typeof daemonReadCommandActivation>): ReturnType<typeof daemonReadCommandActivation> { return daemonReadCommandActivation(this, ...args); }

  constructor(
     readonly database: DaemonDependencies['database'],
     readonly live: DaemonDependencies['live'],
     readonly roomGitHubToken?: DaemonDependencies['roomGitHubToken'],
     readonly mediaMaximumBytes: DaemonDependencies['mediaMaximumBytes'] = DEFAULT_MEDIA_MAXIMUM_BYTES,
     readonly commandTransaction = false,
     readonly authorizedCommand?: DaemonDependencies['authorizedCommand'],
     readonly livePaintDiagnostics = false,
     readonly liveDiagnosticServerInstance?: DaemonDependencies['liveDiagnosticServerInstance'],
     readonly prChecksStatus?: DaemonDependencies['prChecksStatus'],
    _legacyProviderSlot?: unknown,
     readonly institutionalMemoryShadow: DaemonDependencies['institutionalMemoryShadow'] = {
      enabled: false,
    },
     readonly mcpRegistry: DaemonDependencies['mcpRegistry'] = DEFAULT_MCP_REGISTRY_CLIENT,
     readonly registryMcpOAuth?: DaemonDependencies['registryMcpOAuth'],
     readonly composio?: DaemonDependencies['composio'],
     readonly feedback: DaemonDependencies['feedback'] = { config: feedbackConfigFromEnv() },
     readonly objects?: DaemonDependencies['objects'],
     readonly linkWallet?: DaemonDependencies['linkWallet'],
     readonly refreshMergeability?: DaemonDependencies['refreshMergeability'],
    /** The merge attempt behind `merge_corner` and `order_corner_merge`. */
     readonly landCorner?: DaemonDependencies['landCorner'],
    /** The GitHub close behind `close_pull_request`. */
     readonly closePullRequest?: DaemonDependencies['closePullRequest'],
    /** The GitHub read behind `read_pull_request`. */
     readonly readPullRequest?: DaemonDependencies['readPullRequest'],
     readonly subscriptionReceiverUrl?: DaemonDependencies['subscriptionReceiverUrl'],
     readonly github?: DaemonDependencies[typeof githubProviderKey],
  ) {
    this.database = new CornerAccessDatabase(database);
  }

  /** A turn's memory query, embedded before its command transaction opened. */
   memoryEmbed: EmbedFn | undefined;

  /** Collects network work that must wait for the command transaction to commit. */
   afterCommit: AfterCommit | undefined;
  async execute<Name extends keyof DaemonOperationMap>(...args: CommandArguments<typeof daemonExecute<Name>>): ReturnType<typeof daemonExecute<Name>> { return daemonExecute<Name>(this, ...args); }
  async reconcileZeroCheckWorkerCompletion(...args: CommandArguments<typeof daemonReconcileZeroCheckWorkerCompletion>): ReturnType<typeof daemonReconcileZeroCheckWorkerCompletion> { return daemonReconcileZeroCheckWorkerCompletion(this, ...args); }
  async connectorAssignments(...args: CommandArguments<typeof daemonConnectorAssignments>): ReturnType<typeof daemonConnectorAssignments> { return daemonConnectorAssignments(this, ...args); }
  async connectorInstall(...args: CommandArguments<typeof daemonConnectorInstall>): ReturnType<typeof daemonConnectorInstall> { return daemonConnectorInstall(this, ...args); }
  async connectorStatusReport(...args: CommandArguments<typeof daemonConnectorStatusReport>): ReturnType<typeof daemonConnectorStatusReport> { return daemonConnectorStatusReport(this, ...args); }
  async resumeRegistrySignIn(...args: CommandArguments<typeof daemonResumeRegistrySignIn>): ReturnType<typeof daemonResumeRegistrySignIn> { return daemonResumeRegistrySignIn(this, ...args); }
  async notifyTailscaleSignIn(...args: CommandArguments<typeof daemonNotifyTailscaleSignIn>): ReturnType<typeof daemonNotifyTailscaleSignIn> { return daemonNotifyTailscaleSignIn(this, ...args); }
  async connectorVaultReport(...args: CommandArguments<typeof daemonConnectorVaultReport>): ReturnType<typeof daemonConnectorVaultReport> { return daemonConnectorVaultReport(this, ...args); }
  async connectorStatusView(...args: CommandArguments<typeof daemonConnectorStatusView>): ReturnType<typeof daemonConnectorStatusView> { return daemonConnectorStatusView(this, ...args); }
  async connectorVaultList(...args: CommandArguments<typeof daemonConnectorVaultList>): ReturnType<typeof daemonConnectorVaultList> { return daemonConnectorVaultList(this, ...args); }
  async connectionDetail(...args: CommandArguments<typeof daemonConnectionDetail>): ReturnType<typeof daemonConnectionDetail> { return daemonConnectionDetail(this, ...args); }
  async connectionGrantRevoke(...args: CommandArguments<typeof daemonConnectionGrantRevoke>): ReturnType<typeof daemonConnectionGrantRevoke> { return daemonConnectionGrantRevoke(this, ...args); }
  async connectionUsage(...args: CommandArguments<typeof daemonConnectionUsage>): ReturnType<typeof daemonConnectionUsage> { return daemonConnectionUsage(this, ...args); }
  async bootstrap(...args: CommandArguments<typeof daemonBootstrap>): ReturnType<typeof daemonBootstrap> { return daemonBootstrap(this, ...args); }
  async workspaceRoster(...args: CommandArguments<typeof daemonWorkspaceRoster>): ReturnType<typeof daemonWorkspaceRoster> { return daemonWorkspaceRoster(this, ...args); }
  async inbox(...args: CommandArguments<typeof daemonInbox>): ReturnType<typeof daemonInbox> { return daemonInbox(this, ...args); }
  async roomMessage(...args: CommandArguments<typeof daemonRoomMessage>): ReturnType<typeof daemonRoomMessage> { return daemonRoomMessage(this, ...args); }
  async roomAttachment(...args: CommandArguments<typeof daemonRoomAttachment>): ReturnType<typeof daemonRoomAttachment> { return daemonRoomAttachment(this, ...args); }
  async withStoredDigests(...args: CommandArguments<typeof daemonWithStoredDigests>): ReturnType<typeof daemonWithStoredDigests> { return daemonWithStoredDigests(this, ...args); }
  async expiredMediaIds(...args: CommandArguments<typeof daemonExpiredMediaIds>): ReturnType<typeof daemonExpiredMediaIds> { return daemonExpiredMediaIds(this, ...args); }
  async roomAuthority(...args: CommandArguments<typeof daemonRoomAuthority>): ReturnType<typeof daemonRoomAuthority> { return daemonRoomAuthority(this, ...args); }
  async permissionAuthority(...args: CommandArguments<typeof daemonPermissionAuthority>): ReturnType<typeof daemonPermissionAuthority> { return daemonPermissionAuthority(this, ...args); }
  async missionAuthority(...args: CommandArguments<typeof daemonMissionAuthority>): ReturnType<typeof daemonMissionAuthority> { return daemonMissionAuthority(this, ...args); }
  async scheduleAuthority(...args: CommandArguments<typeof daemonScheduleAuthority>): ReturnType<typeof daemonScheduleAuthority> { return daemonScheduleAuthority(this, ...args); }
  async mandate(...args: CommandArguments<typeof daemonMandate>): ReturnType<typeof daemonMandate> { return daemonMandate(this, ...args); }
  async targetAuthority(...args: CommandArguments<typeof daemonTargetAuthority>): ReturnType<typeof daemonTargetAuthority> { return daemonTargetAuthority(this, ...args); }
  async corners(...args: CommandArguments<typeof daemonCorners>): ReturnType<typeof daemonCorners> { return daemonCorners(this, ...args); }
  async cornerRestore(...args: CommandArguments<typeof daemonCornerRestore>): ReturnType<typeof daemonCornerRestore> { return daemonCornerRestore(this, ...args); }
  async listCornerBriefRevisions(...args: CommandArguments<typeof daemonListCornerBriefRevisions>): ReturnType<typeof daemonListCornerBriefRevisions> { return daemonListCornerBriefRevisions(this, ...args); }
  async mergeCorner(...args: CommandArguments<typeof daemonMergeCorner>): ReturnType<typeof daemonMergeCorner> { return daemonMergeCorner(this, ...args); }
  async closeCornerPullRequest(...args: CommandArguments<typeof daemonCloseCornerPullRequest>): ReturnType<typeof daemonCloseCornerPullRequest> { return daemonCloseCornerPullRequest(this, ...args); }
  async checkReviewerAuthors(...args: CommandArguments<typeof daemonCheckReviewerAuthors>): ReturnType<typeof daemonCheckReviewerAuthors> { return daemonCheckReviewerAuthors(this, ...args); }
  async approveCornerMerge(...args: CommandArguments<typeof daemonApproveCornerMerge>): ReturnType<typeof daemonApproveCornerMerge> { return daemonApproveCornerMerge(this, ...args); }
  async repository(...args: CommandArguments<typeof daemonRepository>): ReturnType<typeof daemonRepository> { return daemonRepository(this, ...args); }
  async targetBranch(...args: CommandArguments<typeof daemonTargetBranch>): ReturnType<typeof daemonTargetBranch> { return daemonTargetBranch(this, ...args); }
  async identitySuccession(...args: CommandArguments<typeof daemonIdentitySuccession>): ReturnType<typeof daemonIdentitySuccession> { return daemonIdentitySuccession(this, ...args); }
  async configuration(...args: CommandArguments<typeof daemonConfiguration>): ReturnType<typeof daemonConfiguration> { return daemonConfiguration(this, ...args); }
  async presence(...args: CommandArguments<typeof daemonPresence>): ReturnType<typeof daemonPresence> { return daemonPresence(this, ...args); }
  async releaseReadiness(...args: CommandArguments<typeof daemonReleaseReadiness>): ReturnType<typeof daemonReleaseReadiness> { return daemonReleaseReadiness(this, ...args); }
  async completion(...args: CommandArguments<typeof daemonCompletion>): ReturnType<typeof daemonCompletion> { return daemonCompletion(this, ...args); }
  async postRoomMessage(...args: CommandArguments<typeof daemonPostRoomMessage>): ReturnType<typeof daemonPostRoomMessage> { return daemonPostRoomMessage(this, ...args); }
  async postAgentAttachment(...args: CommandArguments<typeof daemonPostAgentAttachment>): ReturnType<typeof daemonPostAgentAttachment> { return daemonPostAgentAttachment(this, ...args); }
  async liveOutput(...args: CommandArguments<typeof daemonLiveOutput>): ReturnType<typeof daemonLiveOutput> { return daemonLiveOutput(this, ...args); }
  async retract(...args: CommandArguments<typeof daemonRetract>): ReturnType<typeof daemonRetract> { return daemonRetract(this, ...args); }
  async persistTurnTrace(...args: CommandArguments<typeof daemonPersistTurnTrace>): ReturnType<typeof daemonPersistTurnTrace> { return daemonPersistTurnTrace(this, ...args); }
  async turnReceipt(...args: CommandArguments<typeof daemonTurnReceipt>): ReturnType<typeof daemonTurnReceipt> { return daemonTurnReceipt(this, ...args); }
  async activity(...args: CommandArguments<typeof daemonActivity>): ReturnType<typeof daemonActivity> { return daemonActivity(this, ...args); }
  async approvalSource(...args: CommandArguments<typeof daemonApprovalSource>): ReturnType<typeof daemonApprovalSource> { return daemonApprovalSource(this, ...args); }
  async linkSpendApproval(...args: CommandArguments<typeof daemonLinkSpendApproval>): ReturnType<typeof daemonLinkSpendApproval> { return daemonLinkSpendApproval(this, ...args); }
  async squireApproval(...args: CommandArguments<typeof daemonSquireApproval>): ReturnType<typeof daemonSquireApproval> { return daemonSquireApproval(this, ...args); }
  async squireApprovalDecision(...args: CommandArguments<typeof daemonSquireApprovalDecision>): ReturnType<typeof daemonSquireApprovalDecision> { return daemonSquireApprovalDecision(this, ...args); }
  async squireLoginWall(...args: CommandArguments<typeof daemonSquireLoginWall>): ReturnType<typeof daemonSquireLoginWall> { return daemonSquireLoginWall(this, ...args); }
  async permissionRequest(...args: CommandArguments<typeof daemonPermissionRequest>): ReturnType<typeof daemonPermissionRequest> { return daemonPermissionRequest(this, ...args); }
  async permissionExecution(...args: CommandArguments<typeof daemonPermissionExecution>): ReturnType<typeof daemonPermissionExecution> { return daemonPermissionExecution(this, ...args); }
  async createAgentSchedule(...args: CommandArguments<typeof daemonCreateAgentSchedule>): ReturnType<typeof daemonCreateAgentSchedule> { return daemonCreateAgentSchedule(this, ...args); }
  async recordScheduleAuthorization(...args: CommandArguments<typeof daemonRecordScheduleAuthorization>): ReturnType<typeof daemonRecordScheduleAuthorization> { return daemonRecordScheduleAuthorization(this, ...args); }
  async setEventSubscriptions(...args: CommandArguments<typeof daemonSetEventSubscriptions>): ReturnType<typeof daemonSetEventSubscriptions> { return daemonSetEventSubscriptions(this, ...args); }
  async listEventSubscriptions(...args: CommandArguments<typeof daemonListEventSubscriptions>): ReturnType<typeof daemonListEventSubscriptions> { return daemonListEventSubscriptions(this, ...args); }
  async postRoomEvent(...args: CommandArguments<typeof daemonPostRoomEvent>): ReturnType<typeof daemonPostRoomEvent> { return daemonPostRoomEvent(this, ...args); }
  async listAgentSchedules(...args: CommandArguments<typeof daemonListAgentSchedules>): ReturnType<typeof daemonListAgentSchedules> { return daemonListAgentSchedules(this, ...args); }
  async requireScheduleAdmin(...args: CommandArguments<typeof daemonRequireScheduleAdmin>): ReturnType<typeof daemonRequireScheduleAdmin> { return daemonRequireScheduleAdmin(this, ...args); }
  async deleteAgentSchedule(...args: CommandArguments<typeof daemonDeleteAgentSchedule>): ReturnType<typeof daemonDeleteAgentSchedule> { return daemonDeleteAgentSchedule(this, ...args); }
  async updateAgentSchedule(...args: CommandArguments<typeof daemonUpdateAgentSchedule>): ReturnType<typeof daemonUpdateAgentSchedule> { return daemonUpdateAgentSchedule(this, ...args); }
  async postMandate(...args: CommandArguments<typeof daemonPostMandate>): ReturnType<typeof daemonPostMandate> { return daemonPostMandate(this, ...args); }
  async agentAvatar(...args: CommandArguments<typeof daemonAgentAvatar>): ReturnType<typeof daemonAgentAvatar> { return daemonAgentAvatar(this, ...args); }
  async commands(...args: CommandArguments<typeof daemonCommands>): ReturnType<typeof daemonCommands> { return daemonCommands(this, ...args); }
  async modelCatalog(...args: CommandArguments<typeof daemonModelCatalog>): ReturnType<typeof daemonModelCatalog> { return daemonModelCatalog(this, ...args); }
  async machineReport(...args: CommandArguments<typeof daemonMachineReport>): ReturnType<typeof daemonMachineReport> { return daemonMachineReport(this, ...args); }
  async report(...args: CommandArguments<typeof daemonReport>): ReturnType<typeof daemonReport> { return daemonReport(this, ...args); }
  async watchCorner(...args: CommandArguments<typeof daemonWatchCorner>): ReturnType<typeof daemonWatchCorner> { return daemonWatchCorner(this, ...args); }
  async cornerRemote(...args: CommandArguments<typeof daemonCornerRemote>): ReturnType<typeof daemonCornerRemote> { return daemonCornerRemote(this, ...args); }
  async cornerPlan(...args: CommandArguments<typeof daemonCornerPlan>): ReturnType<typeof daemonCornerPlan> { return daemonCornerPlan(this, ...args); }
  async briefAttachmentRooms(...args: CommandArguments<typeof daemonBriefAttachmentRooms>): ReturnType<typeof daemonBriefAttachmentRooms> { return daemonBriefAttachmentRooms(this, ...args); }
  async renameCorner(...args: CommandArguments<typeof daemonRenameCorner>): ReturnType<typeof daemonRenameCorner> { return daemonRenameCorner(this, ...args); }
  async targetProposal(...args: CommandArguments<typeof daemonTargetProposal>): ReturnType<typeof daemonTargetProposal> { return daemonTargetProposal(this, ...args); }
  async requestAgentGrant(...args: CommandArguments<typeof daemonRequestAgentGrant>): ReturnType<typeof daemonRequestAgentGrant> { return daemonRequestAgentGrant(this, ...args); }
  async askRoomChoice(...args: CommandArguments<typeof daemonAskRoomChoice>): ReturnType<typeof daemonAskRoomChoice> { return daemonAskRoomChoice(this, ...args); }
  async openRoomPoll(...args: CommandArguments<typeof daemonOpenRoomPoll>): ReturnType<typeof daemonOpenRoomPoll> { return daemonOpenRoomPoll(this, ...args); }
  async writeRoomChoice(...args: CommandArguments<typeof daemonWriteRoomChoice>): ReturnType<typeof daemonWriteRoomChoice> { return daemonWriteRoomChoice(this, ...args); }
  async listAgentGrants(...args: CommandArguments<typeof daemonListAgentGrants>): ReturnType<typeof daemonListAgentGrants> { return daemonListAgentGrants(this, ...args); }
  async consumeAgentGrant(...args: CommandArguments<typeof daemonConsumeAgentGrant>): ReturnType<typeof daemonConsumeAgentGrant> { return daemonConsumeAgentGrant(this, ...args); }
  async listAgentGrantRequests(...args: CommandArguments<typeof daemonListAgentGrantRequests>): ReturnType<typeof daemonListAgentGrantRequests> { return daemonListAgentGrantRequests(this, ...args); }
  async repositoryOnboardingRequester(...args: CommandArguments<typeof daemonRepositoryOnboardingRequester>): ReturnType<typeof daemonRepositoryOnboardingRequester> { return daemonRepositoryOnboardingRequester(this, ...args); }
  async grantRequester(...args: CommandArguments<typeof daemonGrantRequester>): ReturnType<typeof daemonGrantRequester> { return daemonGrantRequester(this, ...args); }
  async findGrantRequester(...args: CommandArguments<typeof daemonFindGrantRequester>): ReturnType<typeof daemonFindGrantRequester> { return daemonFindGrantRequester(this, ...args); }
  async authorizeSquireCall(...args: CommandArguments<typeof daemonAuthorizeSquireCall>): ReturnType<typeof daemonAuthorizeSquireCall> { return daemonAuthorizeSquireCall(this, ...args); }
  async authorizeScopedGrant(...args: CommandArguments<typeof daemonAuthorizeScopedGrant>): ReturnType<typeof daemonAuthorizeScopedGrant> { return daemonAuthorizeScopedGrant(this, ...args); }
  async appCardMark(...args: CommandArguments<typeof daemonAppCardMark>): ReturnType<typeof daemonAppCardMark> { return daemonAppCardMark(this, ...args); }
  async offerContext(...args: CommandArguments<typeof daemonOfferContext>): ReturnType<typeof daemonOfferContext> { return daemonOfferContext(this, ...args); }
  async agentWorkbench(...args: CommandArguments<typeof daemonAgentWorkbench>): ReturnType<typeof daemonAgentWorkbench> { return daemonAgentWorkbench(this, ...args); }
  async searchMcpRegistry(...args: CommandArguments<typeof daemonSearchMcpRegistry>): ReturnType<typeof daemonSearchMcpRegistry> { return daemonSearchMcpRegistry(this, ...args); }
  warmConnectorIndex(...args: CommandArguments<typeof daemonWarmConnectorIndex>): ReturnType<typeof daemonWarmConnectorIndex> { return daemonWarmConnectorIndex(this, ...args); }
  async connectService(...args: CommandArguments<typeof daemonConnectService>): ReturnType<typeof daemonConnectService> { return daemonConnectService(this, ...args); }
  async connectAppFrontDoor(...args: CommandArguments<typeof daemonConnectAppFrontDoor>): ReturnType<typeof daemonConnectAppFrontDoor> { return daemonConnectAppFrontDoor(this, ...args); }
  async connectedAppForTool(...args: CommandArguments<typeof daemonConnectedAppForTool>): ReturnType<typeof daemonConnectedAppForTool> { return daemonConnectedAppForTool(this, ...args); }
  async listAppTools(...args: CommandArguments<typeof daemonListAppTools>): ReturnType<typeof daemonListAppTools> { return daemonListAppTools(this, ...args); }

  async executeAppTool(...args: CommandArguments<typeof daemonExecuteAppTool>): ReturnType<typeof daemonExecuteAppTool> { return daemonExecuteAppTool(this, ...args); }
  async authorizeResource(...args: CommandArguments<typeof daemonAuthorizeResource>): ReturnType<typeof daemonAuthorizeResource> { return daemonAuthorizeResource(this, ...args); }
  async connectMcpServer(...args: CommandArguments<typeof daemonConnectMcpServer>): ReturnType<typeof daemonConnectMcpServer> { return daemonConnectMcpServer(this, ...args); }
  async offerConnector(...args: CommandArguments<typeof daemonOfferConnector>): ReturnType<typeof daemonOfferConnector> { return daemonOfferConnector(this, ...args); }
  async createCorner(...args: CommandArguments<typeof daemonCreateCorner>): ReturnType<typeof daemonCreateCorner> { return daemonCreateCorner(this, ...args); }
  async reviseCornerBrief(...args: CommandArguments<typeof daemonReviseCornerBrief>): ReturnType<typeof daemonReviseCornerBrief> { return daemonReviseCornerBrief(this, ...args); }
  async archiveCorner(...args: CommandArguments<typeof daemonArchiveCorner>): ReturnType<typeof daemonArchiveCorner> { return daemonArchiveCorner(this, ...args); }
  async ensureMembership(...args: CommandArguments<typeof daemonEnsureMembership>): ReturnType<typeof daemonEnsureMembership> { return daemonEnsureMembership(this, ...args); }
  async identity(...args: CommandArguments<typeof daemonIdentity>): ReturnType<typeof daemonIdentity> { return daemonIdentity(this, ...args); }
  async reviewSourceAccess(...args: CommandArguments<typeof daemonReviewSourceAccess>): ReturnType<typeof daemonReviewSourceAccess> { return daemonReviewSourceAccess(this, ...args); }
  async access(...args: CommandArguments<typeof daemonAccess>): ReturnType<typeof daemonAccess> { return daemonAccess(this, ...args); }
  async roomMembers(...args: CommandArguments<typeof daemonRoomMembers>): ReturnType<typeof daemonRoomMembers> { return daemonRoomMembers(this, ...args); }
  async postCornerMessage(...args: CommandArguments<typeof daemonPostCornerMessage>): ReturnType<typeof daemonPostCornerMessage> { return daemonPostCornerMessage(this, ...args); }
  async postAddressAccess(...args: CommandArguments<typeof daemonPostAddressAccess>): ReturnType<typeof daemonPostAddressAccess> { return daemonPostAddressAccess(this, ...args); }
  async reach(...args: CommandArguments<typeof daemonReach>): ReturnType<typeof daemonReach> { return daemonReach(this, ...args); }
  async reactToRoomMessage(...args: CommandArguments<typeof daemonReactToRoomMessage>): ReturnType<typeof daemonReactToRoomMessage> { return daemonReactToRoomMessage(this, ...args); }
  writeResult(...args: CommandArguments<typeof daemonWriteResult>): ReturnType<typeof daemonWriteResult> { return daemonWriteResult(this, ...args); }
}

/** Command-local state is installed together before any handler runs. */
export function createDaemonCommandService(
  dependencies: DaemonDependencies,
  scope: Pick<DaemonContext, 'database' | 'live' | 'starterOnboarding' | 'memoryEmbed' | 'afterCommit'> & { authorizedCommand: CommandRow },
): DaemonService {
  const service = DaemonService.fromDependencies({
    ...dependencies, database: scope.database, live: scope.live,
    commandTransaction: true, authorizedCommand: scope.authorizedCommand,
  });
  service.starterOnboarding = scope.starterOnboarding;
  service.memoryEmbed = scope.memoryEmbed;
  service.afterCommit = scope.afterCommit;
  return service;
}
