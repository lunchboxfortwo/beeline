import type { ServerEventKind } from './system-events.js';
import type { RoomScheduleCadence } from './phone-operations.js';
import { AgentRoomInput, RoomInput, DaemonOperationMap, Operation, AgentInput, AgentConfigurationInput, CornerInput, AgentMemberMetadata, RoomMemberListResult, CornerPullRequestResult, IdentityInput, RequestInput, RoomCursorInput } from './daemon-operations-daemon-operation-map.js';
import { RoomInboxResult, RoomConversationWindow, RoomConversationInput, RoomPrincipalInput, CornerCursorInput, PermissionAuthorityInput, MissionAuthorityInput, WorkScheduleAuthorityInput, TargetAgentAuthorityInput, DaemonBootstrapInput, WorkspaceRosterInput, DaemonBootstrapResult, WorkspaceRosterResult, DaemonAttachment, RoomConversationResult, RoomAuthorityResult, AuthorityDecisionResult, AgentToolMandateResult, CornerListResult, CornerRestoreResult, RoomRepositoryStateResult, RoomGitHubTokenResult, RoomTargetBranchResult, IdentitySuccessionResult, AgentConfigurationResult, RegistryMcpRemote, RegistryMcpPackage, RegistryMcpManifest, RegistryMcpRoute, SearchMcpRegistryInput, SearchMcpRegistryResult, ConnectMcpServerInput, ConnectMcpServerResult, ConnectAppInput, ConnectAppResult, ConnectInput, ConnectorSearchMatch, ConnectResult, AgentPresenceResult, RequestCompletionResult, WriteResult, PostRoomMessageResult, ReactToRoomMessageInput, PostRoomMessageInput, PostAgentAttachmentInput, PostLiveOutputInput, RetractLiveOutputInput, PostTurnReceiptInput, PostAgentActivityInput, PostPermissionRequestInput, PostPermissionExecutionInput, PostAgentToolMandateInput, PostAgentCommandsInput, PostAgentModelCatalogInput, CornerWatchKind, CornerWatchResult, PostCornerRemoteStateInput, PostCornerPlanInput, PostTargetBranchProposalInput, CreateCornerInput, CornerBriefAttachment, CORNER_BRIEF_SPEC_MAX_LENGTH, CornerBriefDraft, CornerBriefApproval, CornerBrief } from './daemon-operations-room-conversation-window.js';
import { ReviseCornerBriefInput, CornerResult, ChoiceOptionArg, AskRoomChoiceInput, OpenRoomPollInput, AskRoomChoiceResult, RequestAgentGrantInput, RequestAgentGrantResult, AgentGrantListResult, AgentGrantRequestView, AgentGrantRequestListResult, ConsumeAgentGrantInput, AuthorizeSquireCallInput, PostSquireApprovalInput, PostSquireApprovalDecisionInput, PostSquireLoginWallInput, PostSquireLoginWallResult, AuthorizeSquireCallResult, AgentWorkbenchView, OfferConnectorInput, OfferConnectorResult, ConnectorStep, ConnectorStatus, ConnectorBrowserLocation, ConnectorSignIn, VaultConnectionMeta, ConnectionGrant, ConnectionLedgerEntry, ConnectionDetail, ConnectionUsageEventClass, ConnectionUsageRecord, PostConnectionUsageInput, InstallConnectorInput, GetConnectorStatusInput, PostConnectorStatusInput, PostConnectorVaultInput, ConnectionRefInput, ConnectorVaultListResult, ConnectionGrantRevokeResult, ConnectorKind, ConnectorAssignment, ConnectorAssignmentsResult, DaemonActivityItem, DaemonPermissionScope, DaemonAgentToolMandate, DaemonModelConfigOption, DaemonPullRequestFact } from './daemon-operations-revise-corner-brief-input.js';
import type { OwnedModelCredential } from './helper-model.js';
import { isAgentCommand } from './daemon-operations-is-agent-command.js';






export type CreateAgentScheduleInput = AgentRoomInput & {
  /** Plain schedule label, one to four words. */
  readonly title?: string;
  readonly workflowName?: string;
  /** Delivered as a creator-authored Room mention to this agent on every run. */
  readonly prompt: string;
  readonly cadence: RoomScheduleCadence;
  /** Stop (and delete) the schedule after this many runs. */
  readonly maxRuns?: number;
};

export type AgentScheduleResult = {
  readonly scheduleId: string;
  readonly nextRunAt: number;
};

export type AgentScheduleEntry = {
  readonly paused?: boolean;
  readonly title?: string;
  /** Location included by workspace-wide self-only wake reads. */
  readonly roomId?: string;
  readonly roomName?: string;
  readonly workflowName?: string;
  readonly scheduleId: string;
  /** The agent the schedule mentions on every run. */
  readonly agentId: string;
  readonly agentHandle?: string;
  readonly prompt: string;
  readonly cadence: RoomScheduleCadence;
  readonly maxRuns?: number;
  readonly runCount: number;
  readonly nextRunAt: number;
  /** Still-active runs this schedule has started, of any saved workflow (requirement: duplicate-run visibility). */
  readonly activeRunIds?: readonly string[];
};

export type AgentScheduleListResult = { readonly schedules: readonly AgentScheduleEntry[] };

export type DeleteAgentScheduleInput = AgentRoomInput & { readonly scheduleId: string; readonly selfOnly?: boolean };

/** Replaces only the fields given; a new cadence restarts the next run from now. */
export type UpdateAgentScheduleInput = AgentRoomInput & {
  /** Plain schedule label, one to four words. */
  readonly title?: string;
  readonly workflowName?: string;
  readonly scheduleId: string;
  readonly selfOnly?: boolean;
  readonly prompt?: string;
  readonly cadence?: RoomScheduleCadence;
  readonly maxRuns?: number;
};


/**
 * What this agent reacts to in ONE Room, written by the agent itself.
 *
 * The subscription lives on the agent's own Room membership, so the operation
 * carries no identity: the daemon token names the agent and `roomId` names the
 * Room, and the server refuses anything else. `kinds` REPLACES the list, so an
 * agent asked to stop reacting sends the remaining kinds (or none).
 */
export type SetEventSubscriptionsInput = RoomInput & {
  readonly kinds: readonly string[];
};

export type EventSubscriptionsResult = { readonly kinds: readonly ServerEventKind[] };

/**
 * One event this agent emits into the Room it is answering in.
 *
 * `kind` must be an `agent:<slug>` kind; a server kind is the server's own word
 * and is refused here. The cause is NOT carried: the server reads the agent's
 * active turn receipt and derives cause, root and depth from it, because a
 * guard the guarded party sets is not a guard.
 */
export type PostRoomEventInput = TurnOutputAuthority &
  RoomInput & {
    readonly kind: string;
    readonly consequence: string;
    /** Agent members of this Room to wake, at most `MAX_MENTIONS_PER_EVENT`. */
    readonly mentionAgentIds?: readonly string[];
  };


export type AgentReportStatus = 'done' | 'blocked' | 'failed' | 'needs_decision';


export type AgentCommandAction = 'input' | 'restart';

/** Background work no person is waiting on: schedules and event wakes. It may
 * finish without a reply, so a run with nothing to say posts nothing. */
const BACKGROUND_COMMAND_REASONS: ReadonlySet<string> = new Set(['schedule', 'subscribed_event',
  'computer_activity', 'watched_corner', 'corner_check', 'corner_review_dispatch', 'corner_review_needed',
  'corner_merge_conflict', 'corner_land', 'corner_merge_refused', 'attention_report']);
export function isBackgroundCommand(reason: string): boolean {
  return BACKGROUND_COMMAND_REASONS.has(reason);
}

/**
 * One item in an agent's queue. The server keeps it until the answer is
 * posted to `returnRoomId` (or the agent chooses silence, or Stop cancels it).
 * The helper may deliver it more than once; the answer is idempotent.
 */
export type AgentCommand = {
  /** Hosted model authority issued atomically with this queue item. */
  readonly modelCredential?: OwnedModelCredential;
  readonly id: string;
  /** Where the request came from. */
  readonly roomId: string;
  /** Current display name, when the source Room/thread still exists. */
  readonly roomName?: string;
  /** Where the answer goes. */
  readonly returnRoomId: string;
  /** Current display name of the recorded answer destination. */
  readonly returnRoomName?: string;
  /** Set when `roomId` is a corner: that corner's parent Room. */
  readonly parentRoomId?: string;
  readonly agentId: string;
  readonly sourceMessageId: string;
  /** Immutable message origin, independent of the place where this item runs. */
  readonly from?: import('./agent-messaging.js').MessageAddress;
  readonly operatorAgent?: boolean;
  /** The queue item id, carried as `requestId` by every tool call for it. */
  readonly turnRequestId: string;
  readonly action: AgentCommandAction;
  readonly reason: string;
  /** The schedule whose run woke this turn, when this is a `schedule` command. */
  readonly scheduleId?: string;
  /** Pending at reconnect; duration is measured from the previous connection release. */
  readonly offlineSeconds?: number;
  readonly rootCommandId: string;
  readonly parentCommandId?: string;
  readonly rootSourceMessageId: string;
  readonly agentDepth: number;
  readonly private?: boolean;
  readonly source: RoomInboxResult['items'][number];
  readonly createdAt: number;
};

/** `requestId` names the queue item a tool call serves. */
export type TurnOutputAuthority = { readonly requestId?: string };

/** A commander's stop: whether a running turn was cancelled, and how many of its queued orders were dropped. */
export interface StopAgentTurnResult {
  readonly stopped: boolean;
  readonly address: string;
  readonly agent: string;
  readonly droppedOrders?: number;
  readonly receipt: string;
}
export type { DaemonOperationMap } from './daemon-operations-daemon-operation-map.js';
export type { Operation } from './daemon-operations-daemon-operation-map.js';
export type { RoomInput } from './daemon-operations-daemon-operation-map.js';
export type { AgentInput } from './daemon-operations-daemon-operation-map.js';
export type { AgentRoomInput } from './daemon-operations-daemon-operation-map.js';
export type { AgentConfigurationInput } from './daemon-operations-daemon-operation-map.js';
export type { CornerInput } from './daemon-operations-daemon-operation-map.js';
export type { AgentMemberMetadata } from './daemon-operations-daemon-operation-map.js';
export type { RoomMemberListResult } from './daemon-operations-daemon-operation-map.js';
export type { CornerPullRequestResult } from './daemon-operations-daemon-operation-map.js';
export type { IdentityInput } from './daemon-operations-daemon-operation-map.js';
export type { RequestInput } from './daemon-operations-daemon-operation-map.js';
export type { RoomCursorInput } from './daemon-operations-daemon-operation-map.js';
export type { RoomConversationWindow } from './daemon-operations-room-conversation-window.js';
export type { RoomConversationInput } from './daemon-operations-room-conversation-window.js';
export type { RoomPrincipalInput } from './daemon-operations-room-conversation-window.js';
export type { CornerCursorInput } from './daemon-operations-room-conversation-window.js';
export type { PermissionAuthorityInput } from './daemon-operations-room-conversation-window.js';
export type { MissionAuthorityInput } from './daemon-operations-room-conversation-window.js';
export type { WorkScheduleAuthorityInput } from './daemon-operations-room-conversation-window.js';
export type { TargetAgentAuthorityInput } from './daemon-operations-room-conversation-window.js';
export type { DaemonBootstrapInput } from './daemon-operations-room-conversation-window.js';
export type { WorkspaceRosterInput } from './daemon-operations-room-conversation-window.js';
export type { DaemonBootstrapResult } from './daemon-operations-room-conversation-window.js';
export type { WorkspaceRosterResult } from './daemon-operations-room-conversation-window.js';
export type { RoomInboxResult } from './daemon-operations-room-conversation-window.js';
export type { DaemonAttachment } from './daemon-operations-room-conversation-window.js';
export type { RoomConversationResult } from './daemon-operations-room-conversation-window.js';
export type { RoomAuthorityResult } from './daemon-operations-room-conversation-window.js';
export type { AuthorityDecisionResult } from './daemon-operations-room-conversation-window.js';
export type { AgentToolMandateResult } from './daemon-operations-room-conversation-window.js';
export type { CornerListResult } from './daemon-operations-room-conversation-window.js';
export type { CornerRestoreResult } from './daemon-operations-room-conversation-window.js';
export type { RoomRepositoryStateResult } from './daemon-operations-room-conversation-window.js';
export type { RoomGitHubTokenResult } from './daemon-operations-room-conversation-window.js';
export type { RoomTargetBranchResult } from './daemon-operations-room-conversation-window.js';
export type { IdentitySuccessionResult } from './daemon-operations-room-conversation-window.js';
export type { AgentConfigurationResult } from './daemon-operations-room-conversation-window.js';
export type { RegistryMcpRemote } from './daemon-operations-room-conversation-window.js';
export type { RegistryMcpPackage } from './daemon-operations-room-conversation-window.js';
export type { RegistryMcpManifest } from './daemon-operations-room-conversation-window.js';
export type { RegistryMcpRoute } from './daemon-operations-room-conversation-window.js';
export type { SearchMcpRegistryInput } from './daemon-operations-room-conversation-window.js';
export type { SearchMcpRegistryResult } from './daemon-operations-room-conversation-window.js';
export type { ConnectMcpServerInput } from './daemon-operations-room-conversation-window.js';
export type { ConnectMcpServerResult } from './daemon-operations-room-conversation-window.js';
export type { ConnectAppInput } from './daemon-operations-room-conversation-window.js';
export type { ConnectAppResult } from './daemon-operations-room-conversation-window.js';
export type { ConnectInput } from './daemon-operations-room-conversation-window.js';
export type { ConnectorSearchMatch } from './daemon-operations-room-conversation-window.js';
export type { ConnectResult } from './daemon-operations-room-conversation-window.js';
export type { AgentPresenceResult } from './daemon-operations-room-conversation-window.js';
export type { RequestCompletionResult } from './daemon-operations-room-conversation-window.js';
export type { WriteResult } from './daemon-operations-room-conversation-window.js';
export type { PostRoomMessageResult } from './daemon-operations-room-conversation-window.js';
export type { ReactToRoomMessageInput } from './daemon-operations-room-conversation-window.js';
export type { PostRoomMessageInput } from './daemon-operations-room-conversation-window.js';
export type { PostAgentAttachmentInput } from './daemon-operations-room-conversation-window.js';
export type { PostLiveOutputInput } from './daemon-operations-room-conversation-window.js';
export type { RetractLiveOutputInput } from './daemon-operations-room-conversation-window.js';
export type { PostTurnReceiptInput } from './daemon-operations-room-conversation-window.js';
export type { PostAgentActivityInput } from './daemon-operations-room-conversation-window.js';
export type { PostPermissionRequestInput } from './daemon-operations-room-conversation-window.js';
export type { PostPermissionExecutionInput } from './daemon-operations-room-conversation-window.js';
export type { PostAgentToolMandateInput } from './daemon-operations-room-conversation-window.js';
export type { PostAgentCommandsInput } from './daemon-operations-room-conversation-window.js';
export type { PostAgentModelCatalogInput } from './daemon-operations-room-conversation-window.js';
export type { CornerWatchKind } from './daemon-operations-room-conversation-window.js';
export type { CornerWatchResult } from './daemon-operations-room-conversation-window.js';
export type { PostCornerRemoteStateInput } from './daemon-operations-room-conversation-window.js';
export type { PostCornerPlanInput } from './daemon-operations-room-conversation-window.js';
export type { PostTargetBranchProposalInput } from './daemon-operations-room-conversation-window.js';
export type { CreateCornerInput } from './daemon-operations-room-conversation-window.js';
export type { CornerBriefAttachment } from './daemon-operations-room-conversation-window.js';
export { CORNER_BRIEF_SPEC_MAX_LENGTH } from './daemon-operations-room-conversation-window.js';
export type { CornerBriefDraft } from './daemon-operations-room-conversation-window.js';
export type { CornerBriefApproval } from './daemon-operations-room-conversation-window.js';
export type { CornerBrief } from './daemon-operations-room-conversation-window.js';
export type { ReviseCornerBriefInput } from './daemon-operations-revise-corner-brief-input.js';
export type { CornerResult } from './daemon-operations-revise-corner-brief-input.js';
export type { ChoiceOptionArg } from './daemon-operations-revise-corner-brief-input.js';
export type { AskRoomChoiceInput } from './daemon-operations-revise-corner-brief-input.js';
export type { OpenRoomPollInput } from './daemon-operations-revise-corner-brief-input.js';
export type { AskRoomChoiceResult } from './daemon-operations-revise-corner-brief-input.js';
export type { RequestAgentGrantInput } from './daemon-operations-revise-corner-brief-input.js';
export type { RequestAgentGrantResult } from './daemon-operations-revise-corner-brief-input.js';
export type { AgentGrantListResult } from './daemon-operations-revise-corner-brief-input.js';
export type { AgentGrantRequestView } from './daemon-operations-revise-corner-brief-input.js';
export type { AgentGrantRequestListResult } from './daemon-operations-revise-corner-brief-input.js';
export type { ConsumeAgentGrantInput } from './daemon-operations-revise-corner-brief-input.js';
export type { AuthorizeSquireCallInput } from './daemon-operations-revise-corner-brief-input.js';
export type { PostSquireApprovalInput } from './daemon-operations-revise-corner-brief-input.js';
export type { PostSquireApprovalDecisionInput } from './daemon-operations-revise-corner-brief-input.js';
export type { PostSquireLoginWallInput } from './daemon-operations-revise-corner-brief-input.js';
export type { PostSquireLoginWallResult } from './daemon-operations-revise-corner-brief-input.js';
export type { AuthorizeSquireCallResult } from './daemon-operations-revise-corner-brief-input.js';
export type { AgentWorkbenchView } from './daemon-operations-revise-corner-brief-input.js';
export type { OfferConnectorInput } from './daemon-operations-revise-corner-brief-input.js';
export type { OfferConnectorResult } from './daemon-operations-revise-corner-brief-input.js';
export type { ConnectorStep } from './daemon-operations-revise-corner-brief-input.js';
export type { ConnectorStatus } from './daemon-operations-revise-corner-brief-input.js';
export type { ConnectorBrowserLocation } from './daemon-operations-revise-corner-brief-input.js';
export type { ConnectorSignIn } from './daemon-operations-revise-corner-brief-input.js';
export type { VaultConnectionMeta } from './daemon-operations-revise-corner-brief-input.js';
export type { ConnectionGrant } from './daemon-operations-revise-corner-brief-input.js';
export type { ConnectionLedgerEntry } from './daemon-operations-revise-corner-brief-input.js';
export type { ConnectionDetail } from './daemon-operations-revise-corner-brief-input.js';
export type { ConnectionUsageEventClass } from './daemon-operations-revise-corner-brief-input.js';
export type { ConnectionUsageRecord } from './daemon-operations-revise-corner-brief-input.js';
export type { PostConnectionUsageInput } from './daemon-operations-revise-corner-brief-input.js';
export type { InstallConnectorInput } from './daemon-operations-revise-corner-brief-input.js';
export type { GetConnectorStatusInput } from './daemon-operations-revise-corner-brief-input.js';
export type { PostConnectorStatusInput } from './daemon-operations-revise-corner-brief-input.js';
export type { PostConnectorVaultInput } from './daemon-operations-revise-corner-brief-input.js';
export type { ConnectionRefInput } from './daemon-operations-revise-corner-brief-input.js';
export type { ConnectorVaultListResult } from './daemon-operations-revise-corner-brief-input.js';
export type { ConnectionGrantRevokeResult } from './daemon-operations-revise-corner-brief-input.js';
export type { ConnectorKind } from './daemon-operations-revise-corner-brief-input.js';
export type { ConnectorAssignment } from './daemon-operations-revise-corner-brief-input.js';
export type { ConnectorAssignmentsResult } from './daemon-operations-revise-corner-brief-input.js';
export type { DaemonActivityItem } from './daemon-operations-revise-corner-brief-input.js';
export type { DaemonPermissionScope } from './daemon-operations-revise-corner-brief-input.js';
export type { DaemonAgentToolMandate } from './daemon-operations-revise-corner-brief-input.js';
export type { DaemonModelConfigOption } from './daemon-operations-revise-corner-brief-input.js';
export type { DaemonPullRequestFact } from './daemon-operations-revise-corner-brief-input.js';
export { isAgentCommand } from './daemon-operations-is-agent-command.js';
