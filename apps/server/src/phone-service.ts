import { CommandScopedDatabase } from './command-scoped-database.js';
import { ConnectorDiscoveryCache } from './connector-discovery-cache.js';
import { StarterOnboardingService } from './starter-onboarding-run.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import { type ComposioApps } from './composio-apps.js';
import type { LinkAgentWallet } from './link-agent-wallet.js';
import { type PhoneOperationMap } from '@beeline/api-contract/phone';
import { type SqlDatabase } from './database.js';
import type { CommittedMessageLiveRow, LiveHub } from './live.js';
import { HistoryOutlineCache } from './history-outline-cache.js';
import type { GitHubOperations } from './github-operations.js';
import type { FreeAgentService } from './free-agents.js';
import { McpRegistryClient } from './mcp-registry.js';
import type { ObjectService } from './object-service.js';
import { phoneSetStarterOnboarding, phoneSetFreeAgents, phoneWithCommandTransaction, phoneApplyTrayDecisionCommand, phoneStopScheduledWorkCommand } from './phone/command-context.js';
import { phoneOptionalEnrichment } from './phone/optional-enrichment.js';
import { phoneCanReadRoom, phoneCanReadRooms, phoneRequireGrantAuthority, phoneRequireGitHub, phoneRequireIdentity, phoneRequireWorkspaceAgent, phoneRequireWorkspaceAgentRemover, phoneRequireWorkspaceMember, phoneHasRoomAccess, phoneAssertRoomIsWritable, phoneRequireRoomWorkspaceManager, phoneRequireHumanRoomWorkspaceManager, phoneRequireTopLevelChatMember, phoneRequireTopLevelRoom, phoneRequireWorkspaceManager, phoneRequireWorkspaceOwner } from './phone/access.js';
import { phoneProjectCommittedLiveDelta, phoneReadLiveDelta, phoneReadLiveDeltas, phoneReadLiveBookmark, phoneLiveWorkspaceChange, phoneLivePersonChange, phoneLiveNeedsYou, phoneLiveDraftSnapshot, phoneReadWelcomeCards, phoneCompleteWelcomeCards, phoneLiveChatCornerStatus, phoneLiveReadState, phoneLiveRoomCommands, phoneLiveWorkflowRuns, phoneLiveStarPrompt } from './phone/live-reads.js';
import type { AttachmentFacts } from './phone/types.js';
import type { PhoneArguments } from './phone/context.js';
import { phoneReadWorkspaces, phoneReadWorkspace, phoneReadWorkspaceMembers } from './phone/workspaces.js';
import { phoneReadChats, phoneDirectMessagePresence } from './phone/chat-list.js';
import { phoneReadRoom, phoneResolveMessageLink } from './phone/room-read.js';
import { phoneResolveChatLinks } from './phone/chat-links.js';
import { phoneSearchMessages, phoneReadHistoryAround, phoneReadHistoryAfter, phoneReadHistory, phoneReadHistoryOutline, phoneCountHistoryOutline } from './phone/history-search.js';
import { phoneReadCorners, phoneLoadCorners, phoneRoomRows, phoneCornerRoomEnrichment, phoneProjectRoomEnrichment, phoneCornerRowsSql, phoneProjectCorners } from './phone/corner-reads.js';
import { phoneReadAgent, phoneProjectAgentGrants, phoneProjectMemberGrantRows } from './phone/agent-reads.js';
import { phoneReadInvite, phoneLockPairingIssuer, phoneClaimAgentPairing, phoneWornSeededIdentity, phoneClaimAgentConnectPairing, phoneRenameConnectedAgent, phoneFinishAgentConnectPairing } from './phone/pairing.js';
import { phoneExecute } from './phone/execute.js';
import { phoneExecuteOperation } from './phone/operations.js';
import { phoneMarkRead, phoneMarkUnread, phoneUploadMedia, phoneObserveSentMessage, phoneSendMessage, phoneSendReply, phoneReactToMessage, phoneDeleteRoomMessage, phoneSetMessageBookmark, phoneClearMessageBookmarks } from './phone/messages.js';
import { phoneListRoomSchedules, phoneReadScheduledWork, phoneListRoomWorkflowRuns, phoneReadWorkflowRun, phoneDeleteRoomSchedule } from './phone/schedules.js';
import { phoneReadNeedsYou, phoneReadTray, phoneCountNeedsYou, phoneClearNeedsYou, phoneClearNeedsYouSection, phoneListMessageBookmarks } from './phone/tray.js';
import { phoneReceiptMessage, phonePendingAgentCommandsForMessage, phoneNoteUnansweredMentions, phoneUnansweredMentionTargets } from './phone/mention-notices.js';
import { phoneCancelAgentTurn, phoneRequestCornerClose, phoneDecideApprovalCard, phoneDecidePermission } from './phone/approvals.js';
import { phoneCreateWorkspace, phoneUpdateWorkspace, phoneLeaveWorkspace, phoneDeleteWorkspace } from './phone/workspace-writes.js';
import { phoneCreateRoom, phoneCreateHumanCorner, phoneRenameCorner, phoneUpdateRoom, phoneDeleteRoom, phoneDeleteRoomRows, phoneLeaveRoom, phoneCloseChat, phoneReopenChat, phoneAddRoomMember, phoneRemoveRoomMember } from './phone/room-writes.js';
import { phoneAddWorkspaceMember, phoneRemoveWorkspaceMember, phoneResolveDirectMessage, phoneCreateInvite, phoneRedeemInvite } from './phone/members-invites.js';
import { phoneCreatePairing, phoneUpdateAgentSoul, phoneUpdateAgentModel, phoneBeginAgentSignIn, phoneCompleteAgentSignIn, phoneRefreshAgentModelCatalog, phoneDecideAgentGrant, phoneRevokeAgentGrant } from './phone/agent-configuration.js';
import { phoneCreateRoomPoll, phoneActOnRepositoryCard, phoneAnswerChoice, phoneSkipChoice } from './phone/room-actions.js';
import { phoneAcceptConnectorOffer, phoneAcceptWalletOffer, phoneMarkConnectorOfferConnecting } from './phone/connector-offers.js';
import { phoneUpdateAgentYolo, phoneUpdateAgentAccessPolicy, phoneRollbackUnrealizedAgent, phoneRemoveAgent } from './phone/agent-removal.js';
import { phoneDeleteAccount, phoneUpdateProfile, phoneUpdateFace, phoneUpdateRoomPushState, phoneUpdatePushLevel } from './phone/account-profile.js';
import { phoneSetRepository, phoneRemoveRepositoryBinding, phoneRoomRepository, phoneSetTargetBranch, phoneManagedIdentity, phoneClaimManagedHandle, phoneAdoptGitHubHandle, phoneIdentityRecovery, phoneListRepositories, phoneRepositoryAccess } from './phone/repositories.js';
import { phoneRegisterPush, phoneReportUpdate } from './phone/push-updates.js';
import { phoneAssertWorkbenchViewer, phoneViewerWorkbenchWorkspace, phoneReadAppCatalog, phoneSearchWorkbenchApps } from './phone/workbench-catalog.js';
import { phoneDecorateVoiceCallReasons, phoneDecorateApprovalSources, phoneDecorateCornerOpenCards, phoneDecorateMessageCards, phoneDecorateApprovalIdentities, phoneDecorateAppSignInCards } from './phone/message-decoration.js';
import { phoneReadConnectorInstall, phoneReadWorkbench, phoneResolveViewerHelper } from './phone/workbench-reads.js';
import { phoneConnectWorkbenchApp, phoneCompleteAppSignIn, phoneDisconnectWorkbenchApp, phonePairConnector, phoneArmConnectorPairing, phoneAssertOwnedConnector, phoneUnpairConnector } from './phone/connections.js';
import { phoneReadConnectionDetail, phoneRevokeConnectionGrants } from './phone/connection-reads.js';
import { phoneRosterSearchNeedle, phoneWorkspaceRoster, phoneProjectWorkspaceAgents, phoneMembers, phoneProjectMembers } from './phone/roster.js';
import { phoneAttachmentFacts, phoneEnrichHistoryRows, phoneEnrichMessageTags, phoneProjectAgentTurns, phoneProjectPendingAgentCommands, phoneEnrichMessageBookmarks, phoneProjectRoomMessages } from './phone/message-enrichment.js';

export { directMessageRoomId } from './system-line.js';
export type { ArchivedCornerCursor } from './phone/values.js';
export { parseArchivedCornerCursor } from './phone/values.js';
export { MessageSearchTooBroadError } from './phone/read-projection.js';
export { YOLO_AUTHORITY_MESSAGE } from './phone/values.js';
export { CONNECTOR_OFFER_AUTHORITY_MESSAGE } from './phone/values.js';
export { CONNECTOR_OFFER_WALLET_AUTHORITY_MESSAGE } from './phone/values.js';
export { WORKSPACE_ADMIN_AUTHORITY_MESSAGE } from './phone/values.js';
export { AGENT_OWNER_AUTHORITY_MESSAGE } from './phone/values.js';
export { SPENDING_OWNER_AUTHORITY_MESSAGE } from './phone/values.js';
export { ACCESS_POLICY_AUTHORITY_MESSAGE } from './phone/values.js';
export { REVIEW_IDENTITY_MESSAGE } from './phone/values.js';
export { REVIEW_LOCKED_OPERATIONS } from './phone/operation-names.js';
export { PHONE_OPERATION_NAMES } from './phone/operation-names.js';

type AgentConnectResult = Awaited<ReturnType<typeof phoneClaimAgentConnectPairing>>;
type AgentConnectClaim = Extract<AgentConnectResult, { status: 'claimed' }>;
type AgentConnectFailure = Exclude<AgentConnectResult, AgentConnectClaim>;

export class PhoneService {

   readonly lastEnrichmentLogAt = new Map<string, number>();

  /** Only with a live hub: the cache is unsound without its message invalidations. */
   readonly outlineCache?: HistoryOutlineCache;


   starterOnboarding?: StarterOnboardingService;
  setStarterOnboarding(...args: PhoneArguments<typeof phoneSetStarterOnboarding>): ReturnType<typeof phoneSetStarterOnboarding> { return phoneSetStarterOnboarding(this, ...args); }


   freeAgents?: Pick<FreeAgentService, 'createInWorkspace' | 'kick' | 'remove' | 'cleanupRemoved'>;
  setFreeAgents(...args: PhoneArguments<typeof phoneSetFreeAgents>): ReturnType<typeof phoneSetFreeAgents> { return phoneSetFreeAgents(this, ...args); }


  constructor(
     readonly database: SqlDatabase,
     readonly publicOrigin: string,
     readonly github?: GitHubOperations,
     readonly sendPushTest?: (identityId: string) => Promise<void>,
     readonly live?: LiveHub,
     readonly routingTransaction = false,
     readonly enrichmentDatabase: SqlDatabase = database,
     readonly objects?: ObjectService,
    _legacyProviderSlot?: unknown,
     readonly mcpRegistry: McpRegistryClient = new McpRegistryClient(),
     readonly composio?: ComposioApps,
     readonly linkWallet?: LinkAgentWallet,
  ) {
    this.starterOnboarding = new StarterOnboardingService(database);
    this.connectorDiscovery = new ConnectorDiscoveryCache(database, mcpRegistry);
    this.database = new CommandScopedDatabase(new CornerAccessDatabase(database));
    this.enrichmentDatabase = new CornerAccessDatabase(enrichmentDatabase);
    if (live) this.outlineCache = new HistoryOutlineCache(live);
  }


   readonly connectorDiscovery: ConnectorDiscoveryCache;
  async optionalEnrichment<T>(...args: PhoneArguments<typeof phoneOptionalEnrichment<T>>): ReturnType<typeof phoneOptionalEnrichment<T>> { return phoneOptionalEnrichment<T>(this, ...args); }
  withCommandTransaction<T>(...args: PhoneArguments<typeof phoneWithCommandTransaction<T>>): ReturnType<typeof phoneWithCommandTransaction<T>> { return phoneWithCommandTransaction<T>(this, ...args); }
  async applyTrayDecisionCommand(...args: PhoneArguments<typeof phoneApplyTrayDecisionCommand>): ReturnType<typeof phoneApplyTrayDecisionCommand> { return phoneApplyTrayDecisionCommand(this, ...args); }
  async stopScheduledWorkCommand(...args: PhoneArguments<typeof phoneStopScheduledWorkCommand>): ReturnType<typeof phoneStopScheduledWorkCommand> { return phoneStopScheduledWorkCommand(this, ...args); }
  canReadRoom(...args: PhoneArguments<typeof phoneCanReadRoom>): ReturnType<typeof phoneCanReadRoom> { return phoneCanReadRoom(this, ...args); }
  async canReadRooms(...args: PhoneArguments<typeof phoneCanReadRooms>): ReturnType<typeof phoneCanReadRooms> { return phoneCanReadRooms(this, ...args); }
  async projectCommittedLiveDelta(...args: PhoneArguments<typeof phoneProjectCommittedLiveDelta>): ReturnType<typeof phoneProjectCommittedLiveDelta> { return phoneProjectCommittedLiveDelta(this, ...args); }

   readonly committedAttachmentFacts =
    new WeakMap<CommittedMessageLiveRow, Promise<AttachmentFacts>>();
  async readLiveDelta(...args: PhoneArguments<typeof phoneReadLiveDelta>): ReturnType<typeof phoneReadLiveDelta> { return phoneReadLiveDelta(this, ...args); }
  async readLiveDeltas(...args: PhoneArguments<typeof phoneReadLiveDeltas>): ReturnType<typeof phoneReadLiveDeltas> { return phoneReadLiveDeltas(this, ...args); }
  async readLiveBookmark(...args: PhoneArguments<typeof phoneReadLiveBookmark>): ReturnType<typeof phoneReadLiveBookmark> { return phoneReadLiveBookmark(this, ...args); }
  async liveWorkspaceChange(...args: PhoneArguments<typeof phoneLiveWorkspaceChange>): ReturnType<typeof phoneLiveWorkspaceChange> { return phoneLiveWorkspaceChange(this, ...args); }
  async livePersonChange(...args: PhoneArguments<typeof phoneLivePersonChange>): ReturnType<typeof phoneLivePersonChange> { return phoneLivePersonChange(this, ...args); }
  async liveNeedsYou(...args: PhoneArguments<typeof phoneLiveNeedsYou>): ReturnType<typeof phoneLiveNeedsYou> { return phoneLiveNeedsYou(this, ...args); }
  async liveDraftSnapshot(...args: PhoneArguments<typeof phoneLiveDraftSnapshot>): ReturnType<typeof phoneLiveDraftSnapshot> { return phoneLiveDraftSnapshot(this, ...args); }
  async readWelcomeCards(...args: PhoneArguments<typeof phoneReadWelcomeCards>): ReturnType<typeof phoneReadWelcomeCards> { return phoneReadWelcomeCards(this, ...args); }
  async completeWelcomeCards(...args: PhoneArguments<typeof phoneCompleteWelcomeCards>): ReturnType<typeof phoneCompleteWelcomeCards> { return phoneCompleteWelcomeCards(this, ...args); }
  async readWorkspaces(...args: PhoneArguments<typeof phoneReadWorkspaces>): ReturnType<typeof phoneReadWorkspaces> { return phoneReadWorkspaces(this, ...args); }
  async readWorkspace(...args: PhoneArguments<typeof phoneReadWorkspace>): ReturnType<typeof phoneReadWorkspace> { return phoneReadWorkspace(this, ...args); }
  async readWorkspaceMembers(...args: PhoneArguments<typeof phoneReadWorkspaceMembers>): ReturnType<typeof phoneReadWorkspaceMembers> { return phoneReadWorkspaceMembers(this, ...args); }
  async liveChatCornerStatus(...args: PhoneArguments<typeof phoneLiveChatCornerStatus>): ReturnType<typeof phoneLiveChatCornerStatus> { return phoneLiveChatCornerStatus(this, ...args); }
  async readChats(...args: PhoneArguments<typeof phoneReadChats>): ReturnType<typeof phoneReadChats> { return phoneReadChats(this, ...args); }
  directMessagePresence(...args: PhoneArguments<typeof phoneDirectMessagePresence>): ReturnType<typeof phoneDirectMessagePresence> { return phoneDirectMessagePresence(this, ...args); }
  async readRoom(...args: PhoneArguments<typeof phoneReadRoom>): ReturnType<typeof phoneReadRoom> { return phoneReadRoom(this, ...args); }
  async resolveMessageLink(...args: PhoneArguments<typeof phoneResolveMessageLink>): ReturnType<typeof phoneResolveMessageLink> { return phoneResolveMessageLink(this, ...args); }
  async resolveChatLinks(...args: PhoneArguments<typeof phoneResolveChatLinks>): ReturnType<typeof phoneResolveChatLinks> { return phoneResolveChatLinks(this, ...args); }
  async searchMessages(...args: PhoneArguments<typeof phoneSearchMessages>): ReturnType<typeof phoneSearchMessages> { return phoneSearchMessages(this, ...args); }
  async readHistoryAround(...args: PhoneArguments<typeof phoneReadHistoryAround>): ReturnType<typeof phoneReadHistoryAround> { return phoneReadHistoryAround(this, ...args); }
  async readHistoryAfter(...args: PhoneArguments<typeof phoneReadHistoryAfter>): ReturnType<typeof phoneReadHistoryAfter> { return phoneReadHistoryAfter(this, ...args); }
  async readHistory(...args: PhoneArguments<typeof phoneReadHistory>): ReturnType<typeof phoneReadHistory> { return phoneReadHistory(this, ...args); }
  async readHistoryOutline(...args: PhoneArguments<typeof phoneReadHistoryOutline>): ReturnType<typeof phoneReadHistoryOutline> { return phoneReadHistoryOutline(this, ...args); }
  async countHistoryOutline(...args: PhoneArguments<typeof phoneCountHistoryOutline>): ReturnType<typeof phoneCountHistoryOutline> { return phoneCountHistoryOutline(this, ...args); }
  async readCorners(...args: PhoneArguments<typeof phoneReadCorners>): ReturnType<typeof phoneReadCorners> { return phoneReadCorners(this, ...args); }
  async loadCorners(...args: PhoneArguments<typeof phoneLoadCorners>): ReturnType<typeof phoneLoadCorners> { return phoneLoadCorners(this, ...args); }
  async roomRows(...args: PhoneArguments<typeof phoneRoomRows>): ReturnType<typeof phoneRoomRows> { return phoneRoomRows(this, ...args); }
  async cornerRoomEnrichment(...args: PhoneArguments<typeof phoneCornerRoomEnrichment>): ReturnType<typeof phoneCornerRoomEnrichment> { return phoneCornerRoomEnrichment(this, ...args); }
  projectRoomEnrichment(...args: PhoneArguments<typeof phoneProjectRoomEnrichment>): ReturnType<typeof phoneProjectRoomEnrichment> { return phoneProjectRoomEnrichment(this, ...args); }
  cornerRowsSql(...args: PhoneArguments<typeof phoneCornerRowsSql>): ReturnType<typeof phoneCornerRowsSql> { return phoneCornerRowsSql(this, ...args); }
  projectCorners(...args: PhoneArguments<typeof phoneProjectCorners>): ReturnType<typeof phoneProjectCorners> { return phoneProjectCorners(this, ...args); }
  async readAgent(...args: PhoneArguments<typeof phoneReadAgent>): ReturnType<typeof phoneReadAgent> { return phoneReadAgent(this, ...args); }
  projectAgentGrants(...args: PhoneArguments<typeof phoneProjectAgentGrants>): ReturnType<typeof phoneProjectAgentGrants> { return phoneProjectAgentGrants(this, ...args); }
  projectMemberGrantRows(...args: PhoneArguments<typeof phoneProjectMemberGrantRows>): ReturnType<typeof phoneProjectMemberGrantRows> { return phoneProjectMemberGrantRows(this, ...args); }
  async readInvite(...args: PhoneArguments<typeof phoneReadInvite>): ReturnType<typeof phoneReadInvite> { return phoneReadInvite(this, ...args); }
  async lockPairingIssuer(...args: PhoneArguments<typeof phoneLockPairingIssuer>): ReturnType<typeof phoneLockPairingIssuer> { return phoneLockPairingIssuer(this, ...args); }
  async claimAgentPairing(...args: PhoneArguments<typeof phoneClaimAgentPairing>): ReturnType<typeof phoneClaimAgentPairing> { return phoneClaimAgentPairing(this, ...args); }
  async wornSeededIdentity(...args: PhoneArguments<typeof phoneWornSeededIdentity>): ReturnType<typeof phoneWornSeededIdentity> { return phoneWornSeededIdentity(this, ...args); }
  async claimAgentConnectPairing(input: Omit<PhoneArguments<typeof phoneClaimAgentConnectPairing>[0], 'machineId' | 'machineName'>): Promise<Omit<AgentConnectClaim, 'daemonExchangeToken'> | AgentConnectFailure>;
  async claimAgentConnectPairing(input: PhoneArguments<typeof phoneClaimAgentConnectPairing>[0], createDaemonExchange: NonNullable<PhoneArguments<typeof phoneClaimAgentConnectPairing>[1]>): Promise<(AgentConnectClaim & Required<Pick<AgentConnectClaim, 'daemonExchangeToken'>>) | AgentConnectFailure>;
  async claimAgentConnectPairing(...args: PhoneArguments<typeof phoneClaimAgentConnectPairing>): ReturnType<typeof phoneClaimAgentConnectPairing> { return phoneClaimAgentConnectPairing(this, ...args); }
  async renameConnectedAgent(...args: PhoneArguments<typeof phoneRenameConnectedAgent>): ReturnType<typeof phoneRenameConnectedAgent> { return phoneRenameConnectedAgent(this, ...args); }
  async finishAgentConnectPairing(...args: PhoneArguments<typeof phoneFinishAgentConnectPairing>): ReturnType<typeof phoneFinishAgentConnectPairing> { return phoneFinishAgentConnectPairing(this, ...args); }
  async execute<Name extends keyof PhoneOperationMap>(...args: PhoneArguments<typeof phoneExecute<Name>>): ReturnType<typeof phoneExecute<Name>> { return phoneExecute<Name>(this, ...args); }
  async executeOperation<Name extends keyof PhoneOperationMap>(...args: PhoneArguments<typeof phoneExecuteOperation<Name>>): ReturnType<typeof phoneExecuteOperation<Name>> { return phoneExecuteOperation<Name>(this, ...args); }
  async liveReadState(...args: PhoneArguments<typeof phoneLiveReadState>): ReturnType<typeof phoneLiveReadState> { return phoneLiveReadState(this, ...args); }
  async liveRoomCommands(...args: PhoneArguments<typeof phoneLiveRoomCommands>): ReturnType<typeof phoneLiveRoomCommands> { return phoneLiveRoomCommands(this, ...args); }
  async markRead(...args: PhoneArguments<typeof phoneMarkRead>): ReturnType<typeof phoneMarkRead> { return phoneMarkRead(this, ...args); }
  async markUnread(...args: PhoneArguments<typeof phoneMarkUnread>): ReturnType<typeof phoneMarkUnread> { return phoneMarkUnread(this, ...args); }
  async uploadMedia(...args: PhoneArguments<typeof phoneUploadMedia>): ReturnType<typeof phoneUploadMedia> { return phoneUploadMedia(this, ...args); }
  async observeSentMessage(...args: PhoneArguments<typeof phoneObserveSentMessage>): ReturnType<typeof phoneObserveSentMessage> { return phoneObserveSentMessage(this, ...args); }
  async sendMessage(...args: PhoneArguments<typeof phoneSendMessage>): ReturnType<typeof phoneSendMessage> { return phoneSendMessage(this, ...args); }
  async listRoomSchedules(...args: PhoneArguments<typeof phoneListRoomSchedules>): ReturnType<typeof phoneListRoomSchedules> { return phoneListRoomSchedules(this, ...args); }
  async readScheduledWork(...args: PhoneArguments<typeof phoneReadScheduledWork>): ReturnType<typeof phoneReadScheduledWork> { return phoneReadScheduledWork(this, ...args); }
  async listRoomWorkflowRuns(...args: PhoneArguments<typeof phoneListRoomWorkflowRuns>): ReturnType<typeof phoneListRoomWorkflowRuns> { return phoneListRoomWorkflowRuns(this, ...args); }
  async liveWorkflowRuns(...args: PhoneArguments<typeof phoneLiveWorkflowRuns>): ReturnType<typeof phoneLiveWorkflowRuns> { return phoneLiveWorkflowRuns(this, ...args); }
  async readWorkflowRun(...args: PhoneArguments<typeof phoneReadWorkflowRun>): ReturnType<typeof phoneReadWorkflowRun> { return phoneReadWorkflowRun(this, ...args); }
  async deleteRoomSchedule(...args: PhoneArguments<typeof phoneDeleteRoomSchedule>): ReturnType<typeof phoneDeleteRoomSchedule> { return phoneDeleteRoomSchedule(this, ...args); }
  async sendReply(...args: PhoneArguments<typeof phoneSendReply>): ReturnType<typeof phoneSendReply> { return phoneSendReply(this, ...args); }
  async liveStarPrompt(...args: PhoneArguments<typeof phoneLiveStarPrompt>): ReturnType<typeof phoneLiveStarPrompt> { return phoneLiveStarPrompt(this, ...args); }
  async reactToMessage(...args: PhoneArguments<typeof phoneReactToMessage>): ReturnType<typeof phoneReactToMessage> { return phoneReactToMessage(this, ...args); }
  async deleteRoomMessage(...args: PhoneArguments<typeof phoneDeleteRoomMessage>): ReturnType<typeof phoneDeleteRoomMessage> { return phoneDeleteRoomMessage(this, ...args); }
  async setMessageBookmark(...args: PhoneArguments<typeof phoneSetMessageBookmark>): ReturnType<typeof phoneSetMessageBookmark> { return phoneSetMessageBookmark(this, ...args); }
  async clearMessageBookmarks(...args: PhoneArguments<typeof phoneClearMessageBookmarks>): ReturnType<typeof phoneClearMessageBookmarks> { return phoneClearMessageBookmarks(this, ...args); }
  async readNeedsYou(...args: PhoneArguments<typeof phoneReadNeedsYou>): ReturnType<typeof phoneReadNeedsYou> { return phoneReadNeedsYou(this, ...args); }
  async readTray(...args: PhoneArguments<typeof phoneReadTray>): ReturnType<typeof phoneReadTray> { return phoneReadTray(this, ...args); }
  async countNeedsYou(...args: PhoneArguments<typeof phoneCountNeedsYou>): ReturnType<typeof phoneCountNeedsYou> { return phoneCountNeedsYou(this, ...args); }
  async clearNeedsYou(...args: PhoneArguments<typeof phoneClearNeedsYou>): ReturnType<typeof phoneClearNeedsYou> { return phoneClearNeedsYou(this, ...args); }
  async clearNeedsYouSection(...args: PhoneArguments<typeof phoneClearNeedsYouSection>): ReturnType<typeof phoneClearNeedsYouSection> { return phoneClearNeedsYouSection(this, ...args); }
  async listMessageBookmarks(...args: PhoneArguments<typeof phoneListMessageBookmarks>): ReturnType<typeof phoneListMessageBookmarks> { return phoneListMessageBookmarks(this, ...args); }
  async receiptMessage(...args: PhoneArguments<typeof phoneReceiptMessage>): ReturnType<typeof phoneReceiptMessage> { return phoneReceiptMessage(this, ...args); }
  async pendingAgentCommandsForMessage(...args: PhoneArguments<typeof phonePendingAgentCommandsForMessage>): ReturnType<typeof phonePendingAgentCommandsForMessage> { return phonePendingAgentCommandsForMessage(this, ...args); }
  async noteUnansweredMentions(...args: PhoneArguments<typeof phoneNoteUnansweredMentions>): ReturnType<typeof phoneNoteUnansweredMentions> { return phoneNoteUnansweredMentions(this, ...args); }
  async unansweredMentionTargets(...args: PhoneArguments<typeof phoneUnansweredMentionTargets>): ReturnType<typeof phoneUnansweredMentionTargets> { return phoneUnansweredMentionTargets(this, ...args); }
  async cancelAgentTurn(...args: PhoneArguments<typeof phoneCancelAgentTurn>): ReturnType<typeof phoneCancelAgentTurn> { return phoneCancelAgentTurn(this, ...args); }
  async requestCornerClose(...args: PhoneArguments<typeof phoneRequestCornerClose>): ReturnType<typeof phoneRequestCornerClose> { return phoneRequestCornerClose(this, ...args); }
  async decideApprovalCard(...args: PhoneArguments<typeof phoneDecideApprovalCard>): ReturnType<typeof phoneDecideApprovalCard> { return phoneDecideApprovalCard(this, ...args); }
  async decidePermission(...args: PhoneArguments<typeof phoneDecidePermission>): ReturnType<typeof phoneDecidePermission> { return phoneDecidePermission(this, ...args); }
  async createWorkspace(...args: PhoneArguments<typeof phoneCreateWorkspace>): ReturnType<typeof phoneCreateWorkspace> { return phoneCreateWorkspace(this, ...args); }
  async updateWorkspace(...args: PhoneArguments<typeof phoneUpdateWorkspace>): ReturnType<typeof phoneUpdateWorkspace> { return phoneUpdateWorkspace(this, ...args); }
  async leaveWorkspace(...args: PhoneArguments<typeof phoneLeaveWorkspace>): ReturnType<typeof phoneLeaveWorkspace> { return phoneLeaveWorkspace(this, ...args); }
  async deleteWorkspace(...args: PhoneArguments<typeof phoneDeleteWorkspace>): ReturnType<typeof phoneDeleteWorkspace> { return phoneDeleteWorkspace(this, ...args); }
  async createRoom(...args: PhoneArguments<typeof phoneCreateRoom>): ReturnType<typeof phoneCreateRoom> { return phoneCreateRoom(this, ...args); }
  async createHumanCorner(...args: PhoneArguments<typeof phoneCreateHumanCorner>): ReturnType<typeof phoneCreateHumanCorner> { return phoneCreateHumanCorner(this, ...args); }
  async renameCorner(...args: PhoneArguments<typeof phoneRenameCorner>): ReturnType<typeof phoneRenameCorner> { return phoneRenameCorner(this, ...args); }
  async updateRoom(...args: PhoneArguments<typeof phoneUpdateRoom>): ReturnType<typeof phoneUpdateRoom> { return phoneUpdateRoom(this, ...args); }
  async deleteRoom(...args: PhoneArguments<typeof phoneDeleteRoom>): ReturnType<typeof phoneDeleteRoom> { return phoneDeleteRoom(this, ...args); }
  async deleteRoomRows(...args: PhoneArguments<typeof phoneDeleteRoomRows>): ReturnType<typeof phoneDeleteRoomRows> { return phoneDeleteRoomRows(this, ...args); }
  async leaveRoom(...args: PhoneArguments<typeof phoneLeaveRoom>): ReturnType<typeof phoneLeaveRoom> { return phoneLeaveRoom(this, ...args); }
  async closeChat(...args: PhoneArguments<typeof phoneCloseChat>): ReturnType<typeof phoneCloseChat> { return phoneCloseChat(this, ...args); }
  async reopenChat(...args: PhoneArguments<typeof phoneReopenChat>): ReturnType<typeof phoneReopenChat> { return phoneReopenChat(this, ...args); }
  async addRoomMember(...args: PhoneArguments<typeof phoneAddRoomMember>): ReturnType<typeof phoneAddRoomMember> { return phoneAddRoomMember(this, ...args); }
  async removeRoomMember(...args: PhoneArguments<typeof phoneRemoveRoomMember>): ReturnType<typeof phoneRemoveRoomMember> { return phoneRemoveRoomMember(this, ...args); }
  async addWorkspaceMember(...args: PhoneArguments<typeof phoneAddWorkspaceMember>): ReturnType<typeof phoneAddWorkspaceMember> { return phoneAddWorkspaceMember(this, ...args); }
  async removeWorkspaceMember(...args: PhoneArguments<typeof phoneRemoveWorkspaceMember>): ReturnType<typeof phoneRemoveWorkspaceMember> { return phoneRemoveWorkspaceMember(this, ...args); }
  async resolveDirectMessage(...args: PhoneArguments<typeof phoneResolveDirectMessage>): ReturnType<typeof phoneResolveDirectMessage> { return phoneResolveDirectMessage(this, ...args); }
  async createInvite(...args: PhoneArguments<typeof phoneCreateInvite>): ReturnType<typeof phoneCreateInvite> { return phoneCreateInvite(this, ...args); }
  async redeemInvite(...args: PhoneArguments<typeof phoneRedeemInvite>): ReturnType<typeof phoneRedeemInvite> { return phoneRedeemInvite(this, ...args); }
  async createPairing(...args: PhoneArguments<typeof phoneCreatePairing>): ReturnType<typeof phoneCreatePairing> { return phoneCreatePairing(this, ...args); }
  async updateAgentSoul(...args: PhoneArguments<typeof phoneUpdateAgentSoul>): ReturnType<typeof phoneUpdateAgentSoul> { return phoneUpdateAgentSoul(this, ...args); }
  async updateAgentModel(...args: PhoneArguments<typeof phoneUpdateAgentModel>): ReturnType<typeof phoneUpdateAgentModel> { return phoneUpdateAgentModel(this, ...args); }
  beginAgentSignIn(...args: PhoneArguments<typeof phoneBeginAgentSignIn>): ReturnType<typeof phoneBeginAgentSignIn> { return phoneBeginAgentSignIn(this, ...args); }
  async completeAgentSignIn(...args: PhoneArguments<typeof phoneCompleteAgentSignIn>): ReturnType<typeof phoneCompleteAgentSignIn> { return phoneCompleteAgentSignIn(this, ...args); }
  async refreshAgentModelCatalog(...args: PhoneArguments<typeof phoneRefreshAgentModelCatalog>): ReturnType<typeof phoneRefreshAgentModelCatalog> { return phoneRefreshAgentModelCatalog(this, ...args); }
  async decideAgentGrant(...args: PhoneArguments<typeof phoneDecideAgentGrant>): ReturnType<typeof phoneDecideAgentGrant> { return phoneDecideAgentGrant(this, ...args); }
  async revokeAgentGrant(...args: PhoneArguments<typeof phoneRevokeAgentGrant>): ReturnType<typeof phoneRevokeAgentGrant> { return phoneRevokeAgentGrant(this, ...args); }
  async createRoomPoll(...args: PhoneArguments<typeof phoneCreateRoomPoll>): ReturnType<typeof phoneCreateRoomPoll> { return phoneCreateRoomPoll(this, ...args); }
  async actOnRepositoryCard(...args: PhoneArguments<typeof phoneActOnRepositoryCard>): ReturnType<typeof phoneActOnRepositoryCard> { return phoneActOnRepositoryCard(this, ...args); }
  async answerChoice(...args: PhoneArguments<typeof phoneAnswerChoice>): ReturnType<typeof phoneAnswerChoice> { return phoneAnswerChoice(this, ...args); }
  async skipChoice(...args: PhoneArguments<typeof phoneSkipChoice>): ReturnType<typeof phoneSkipChoice> { return phoneSkipChoice(this, ...args); }
  async requireGrantAuthority(...args: PhoneArguments<typeof phoneRequireGrantAuthority>): ReturnType<typeof phoneRequireGrantAuthority> { return phoneRequireGrantAuthority(this, ...args); }
  async acceptConnectorOffer(...args: PhoneArguments<typeof phoneAcceptConnectorOffer>): ReturnType<typeof phoneAcceptConnectorOffer> { return phoneAcceptConnectorOffer(this, ...args); }
  async acceptWalletOffer(...args: PhoneArguments<typeof phoneAcceptWalletOffer>): ReturnType<typeof phoneAcceptWalletOffer> { return phoneAcceptWalletOffer(this, ...args); }
  async markConnectorOfferConnecting(...args: PhoneArguments<typeof phoneMarkConnectorOfferConnecting>): ReturnType<typeof phoneMarkConnectorOfferConnecting> { return phoneMarkConnectorOfferConnecting(this, ...args); }
  async updateAgentYolo(...args: PhoneArguments<typeof phoneUpdateAgentYolo>): ReturnType<typeof phoneUpdateAgentYolo> { return phoneUpdateAgentYolo(this, ...args); }
  async updateAgentAccessPolicy(...args: PhoneArguments<typeof phoneUpdateAgentAccessPolicy>): ReturnType<typeof phoneUpdateAgentAccessPolicy> { return phoneUpdateAgentAccessPolicy(this, ...args); }
  async rollbackUnrealizedAgent(...args: PhoneArguments<typeof phoneRollbackUnrealizedAgent>): ReturnType<typeof phoneRollbackUnrealizedAgent> { return phoneRollbackUnrealizedAgent(this, ...args); }
  async removeAgent(...args: PhoneArguments<typeof phoneRemoveAgent>): ReturnType<typeof phoneRemoveAgent> { return phoneRemoveAgent(this, ...args); }
  async deleteAccount(...args: PhoneArguments<typeof phoneDeleteAccount>): ReturnType<typeof phoneDeleteAccount> { return phoneDeleteAccount(this, ...args); }
  async updateProfile(...args: PhoneArguments<typeof phoneUpdateProfile>): ReturnType<typeof phoneUpdateProfile> { return phoneUpdateProfile(this, ...args); }
  async updateFace(...args: PhoneArguments<typeof phoneUpdateFace>): ReturnType<typeof phoneUpdateFace> { return phoneUpdateFace(this, ...args); }
  async updateRoomPushState(...args: PhoneArguments<typeof phoneUpdateRoomPushState>): ReturnType<typeof phoneUpdateRoomPushState> { return phoneUpdateRoomPushState(this, ...args); }
  async updatePushLevel(...args: PhoneArguments<typeof phoneUpdatePushLevel>): ReturnType<typeof phoneUpdatePushLevel> { return phoneUpdatePushLevel(this, ...args); }
  async setRepository(...args: PhoneArguments<typeof phoneSetRepository>): ReturnType<typeof phoneSetRepository> { return phoneSetRepository(this, ...args); }
  async removeRepositoryBinding(...args: PhoneArguments<typeof phoneRemoveRepositoryBinding>): ReturnType<typeof phoneRemoveRepositoryBinding> { return phoneRemoveRepositoryBinding(this, ...args); }
  async roomRepository(...args: PhoneArguments<typeof phoneRoomRepository>): ReturnType<typeof phoneRoomRepository> { return phoneRoomRepository(this, ...args); }
  async setTargetBranch(...args: PhoneArguments<typeof phoneSetTargetBranch>): ReturnType<typeof phoneSetTargetBranch> { return phoneSetTargetBranch(this, ...args); }
  async managedIdentity(...args: PhoneArguments<typeof phoneManagedIdentity>): ReturnType<typeof phoneManagedIdentity> { return phoneManagedIdentity(this, ...args); }
  async claimManagedHandle(...args: PhoneArguments<typeof phoneClaimManagedHandle>): ReturnType<typeof phoneClaimManagedHandle> { return phoneClaimManagedHandle(this, ...args); }
  async adoptGitHubHandle(...args: PhoneArguments<typeof phoneAdoptGitHubHandle>): ReturnType<typeof phoneAdoptGitHubHandle> { return phoneAdoptGitHubHandle(this, ...args); }
  async identityRecovery(...args: PhoneArguments<typeof phoneIdentityRecovery>): ReturnType<typeof phoneIdentityRecovery> { return phoneIdentityRecovery(this, ...args); }
  async listRepositories(...args: PhoneArguments<typeof phoneListRepositories>): ReturnType<typeof phoneListRepositories> { return phoneListRepositories(this, ...args); }
  async repositoryAccess(...args: PhoneArguments<typeof phoneRepositoryAccess>): ReturnType<typeof phoneRepositoryAccess> { return phoneRepositoryAccess(this, ...args); }
  async registerPush(...args: PhoneArguments<typeof phoneRegisterPush>): ReturnType<typeof phoneRegisterPush> { return phoneRegisterPush(this, ...args); }
  async reportUpdate(...args: PhoneArguments<typeof phoneReportUpdate>): ReturnType<typeof phoneReportUpdate> { return phoneReportUpdate(this, ...args); }
  requireGitHub(...args: PhoneArguments<typeof phoneRequireGitHub>): ReturnType<typeof phoneRequireGitHub> { return phoneRequireGitHub(this, ...args); }
  async requireIdentity(...args: PhoneArguments<typeof phoneRequireIdentity>): ReturnType<typeof phoneRequireIdentity> { return phoneRequireIdentity(this, ...args); }
  async requireWorkspaceAgent(...args: PhoneArguments<typeof phoneRequireWorkspaceAgent>): ReturnType<typeof phoneRequireWorkspaceAgent> { return phoneRequireWorkspaceAgent(this, ...args); }
  async requireWorkspaceAgentRemover(...args: PhoneArguments<typeof phoneRequireWorkspaceAgentRemover>): ReturnType<typeof phoneRequireWorkspaceAgentRemover> { return phoneRequireWorkspaceAgentRemover(this, ...args); }
  async requireWorkspaceMember(...args: PhoneArguments<typeof phoneRequireWorkspaceMember>): ReturnType<typeof phoneRequireWorkspaceMember> { return phoneRequireWorkspaceMember(this, ...args); }
  async hasRoomAccess(...args: PhoneArguments<typeof phoneHasRoomAccess>): ReturnType<typeof phoneHasRoomAccess> { return phoneHasRoomAccess(this, ...args); }
  async assertWorkbenchViewer(...args: PhoneArguments<typeof phoneAssertWorkbenchViewer>): ReturnType<typeof phoneAssertWorkbenchViewer> { return phoneAssertWorkbenchViewer(this, ...args); }
  async viewerWorkbenchWorkspace(...args: PhoneArguments<typeof phoneViewerWorkbenchWorkspace>): ReturnType<typeof phoneViewerWorkbenchWorkspace> { return phoneViewerWorkbenchWorkspace(this, ...args); }
  async readAppCatalog(...args: PhoneArguments<typeof phoneReadAppCatalog>): ReturnType<typeof phoneReadAppCatalog> { return phoneReadAppCatalog(this, ...args); }
  async searchWorkbenchApps(...args: PhoneArguments<typeof phoneSearchWorkbenchApps>): ReturnType<typeof phoneSearchWorkbenchApps> { return phoneSearchWorkbenchApps(this, ...args); }
  async decorateVoiceCallReasons(...args: PhoneArguments<typeof phoneDecorateVoiceCallReasons>): ReturnType<typeof phoneDecorateVoiceCallReasons> { return phoneDecorateVoiceCallReasons(this, ...args); }
  async decorateApprovalSources(...args: PhoneArguments<typeof phoneDecorateApprovalSources>): ReturnType<typeof phoneDecorateApprovalSources> { return phoneDecorateApprovalSources(this, ...args); }
  async decorateCornerOpenCards(...args: PhoneArguments<typeof phoneDecorateCornerOpenCards>): ReturnType<typeof phoneDecorateCornerOpenCards> { return phoneDecorateCornerOpenCards(this, ...args); }
  async decorateMessageCards(...args: PhoneArguments<typeof phoneDecorateMessageCards>): ReturnType<typeof phoneDecorateMessageCards> { return phoneDecorateMessageCards(this, ...args); }
  async decorateApprovalIdentities(...args: PhoneArguments<typeof phoneDecorateApprovalIdentities>): ReturnType<typeof phoneDecorateApprovalIdentities> { return phoneDecorateApprovalIdentities(this, ...args); }
  async decorateAppSignInCards(...args: PhoneArguments<typeof phoneDecorateAppSignInCards>): ReturnType<typeof phoneDecorateAppSignInCards> { return phoneDecorateAppSignInCards(this, ...args); }
  async readConnectorInstall(...args: PhoneArguments<typeof phoneReadConnectorInstall>): ReturnType<typeof phoneReadConnectorInstall> { return phoneReadConnectorInstall(this, ...args); }
  async readWorkbench(...args: PhoneArguments<typeof phoneReadWorkbench>): ReturnType<typeof phoneReadWorkbench> { return phoneReadWorkbench(this, ...args); }
  async resolveViewerHelper(...args: PhoneArguments<typeof phoneResolveViewerHelper>): ReturnType<typeof phoneResolveViewerHelper> { return phoneResolveViewerHelper(this, ...args); }
  async connectWorkbenchApp(...args: PhoneArguments<typeof phoneConnectWorkbenchApp>): ReturnType<typeof phoneConnectWorkbenchApp> { return phoneConnectWorkbenchApp(this, ...args); }
  async completeAppSignIn(...args: PhoneArguments<typeof phoneCompleteAppSignIn>): ReturnType<typeof phoneCompleteAppSignIn> { return phoneCompleteAppSignIn(this, ...args); }
  async disconnectWorkbenchApp(...args: PhoneArguments<typeof phoneDisconnectWorkbenchApp>): ReturnType<typeof phoneDisconnectWorkbenchApp> { return phoneDisconnectWorkbenchApp(this, ...args); }
  async pairConnector(...args: PhoneArguments<typeof phonePairConnector>): ReturnType<typeof phonePairConnector> { return phonePairConnector(this, ...args); }
  async armConnectorPairing(...args: PhoneArguments<typeof phoneArmConnectorPairing>): ReturnType<typeof phoneArmConnectorPairing> { return phoneArmConnectorPairing(this, ...args); }
  async assertOwnedConnector(...args: PhoneArguments<typeof phoneAssertOwnedConnector>): ReturnType<typeof phoneAssertOwnedConnector> { return phoneAssertOwnedConnector(this, ...args); }
  async unpairConnector(...args: PhoneArguments<typeof phoneUnpairConnector>): ReturnType<typeof phoneUnpairConnector> { return phoneUnpairConnector(this, ...args); }
  async readConnectionDetail(...args: PhoneArguments<typeof phoneReadConnectionDetail>): ReturnType<typeof phoneReadConnectionDetail> { return phoneReadConnectionDetail(this, ...args); }
  async revokeConnectionGrants(...args: PhoneArguments<typeof phoneRevokeConnectionGrants>): ReturnType<typeof phoneRevokeConnectionGrants> { return phoneRevokeConnectionGrants(this, ...args); }
  async assertRoomIsWritable(...args: PhoneArguments<typeof phoneAssertRoomIsWritable>): ReturnType<typeof phoneAssertRoomIsWritable> { return phoneAssertRoomIsWritable(this, ...args); }
  async requireRoomWorkspaceManager(...args: PhoneArguments<typeof phoneRequireRoomWorkspaceManager>): ReturnType<typeof phoneRequireRoomWorkspaceManager> { return phoneRequireRoomWorkspaceManager(this, ...args); }
  async requireHumanRoomWorkspaceManager(...args: PhoneArguments<typeof phoneRequireHumanRoomWorkspaceManager>): ReturnType<typeof phoneRequireHumanRoomWorkspaceManager> { return phoneRequireHumanRoomWorkspaceManager(this, ...args); }
  async requireTopLevelChatMember(...args: PhoneArguments<typeof phoneRequireTopLevelChatMember>): ReturnType<typeof phoneRequireTopLevelChatMember> { return phoneRequireTopLevelChatMember(this, ...args); }
  async requireTopLevelRoom(...args: PhoneArguments<typeof phoneRequireTopLevelRoom>): ReturnType<typeof phoneRequireTopLevelRoom> { return phoneRequireTopLevelRoom(this, ...args); }
  async requireWorkspaceManager(...args: PhoneArguments<typeof phoneRequireWorkspaceManager>): ReturnType<typeof phoneRequireWorkspaceManager> { return phoneRequireWorkspaceManager(this, ...args); }
  async requireWorkspaceOwner(...args: PhoneArguments<typeof phoneRequireWorkspaceOwner>): ReturnType<typeof phoneRequireWorkspaceOwner> { return phoneRequireWorkspaceOwner(this, ...args); }
  rosterSearchNeedle(...args: PhoneArguments<typeof phoneRosterSearchNeedle>): ReturnType<typeof phoneRosterSearchNeedle> { return phoneRosterSearchNeedle(this, ...args); }
  async workspaceRoster(...args: PhoneArguments<typeof phoneWorkspaceRoster>): ReturnType<typeof phoneWorkspaceRoster> { return phoneWorkspaceRoster(this, ...args); }
  projectWorkspaceAgents(...args: PhoneArguments<typeof phoneProjectWorkspaceAgents>): ReturnType<typeof phoneProjectWorkspaceAgents> { return phoneProjectWorkspaceAgents(this, ...args); }
  async members(...args: PhoneArguments<typeof phoneMembers>): ReturnType<typeof phoneMembers> { return phoneMembers(this, ...args); }
  projectMembers(...args: PhoneArguments<typeof phoneProjectMembers>): ReturnType<typeof phoneProjectMembers> { return phoneProjectMembers(this, ...args); }
  async attachmentFacts(...args: PhoneArguments<typeof phoneAttachmentFacts>): ReturnType<typeof phoneAttachmentFacts> { return phoneAttachmentFacts(this, ...args); }
  async enrichHistoryRows(...args: PhoneArguments<typeof phoneEnrichHistoryRows>): ReturnType<typeof phoneEnrichHistoryRows> { return phoneEnrichHistoryRows(this, ...args); }
  async enrichMessageTags(...args: PhoneArguments<typeof phoneEnrichMessageTags>): ReturnType<typeof phoneEnrichMessageTags> { return phoneEnrichMessageTags(this, ...args); }
  projectAgentTurns(...args: PhoneArguments<typeof phoneProjectAgentTurns>): ReturnType<typeof phoneProjectAgentTurns> { return phoneProjectAgentTurns(this, ...args); }
  projectPendingAgentCommands(...args: PhoneArguments<typeof phoneProjectPendingAgentCommands>): ReturnType<typeof phoneProjectPendingAgentCommands> { return phoneProjectPendingAgentCommands(this, ...args); }
  async enrichMessageBookmarks(...args: PhoneArguments<typeof phoneEnrichMessageBookmarks>): ReturnType<typeof phoneEnrichMessageBookmarks> { return phoneEnrichMessageBookmarks(this, ...args); }
  projectRoomMessages(...args: PhoneArguments<typeof phoneProjectRoomMessages>): ReturnType<typeof phoneProjectRoomMessages> { return phoneProjectRoomMessages(this, ...args); }
}
