import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { USAGE_REFRESH_CLIENT_TIMEOUT_MS } from './usage-cell';
import { useMembersRouteState } from '@/app/(app)/beeline/useMembersRouteState';
import { useMembersReads } from '@/app/(app)/beeline/useMembersReads';
import { useMembersMembership } from '@/app/(app)/beeline/useMembersMembership';
import { useMembersSoul } from '@/app/(app)/beeline/useMembersSoul';
import { useMembersConfiguration } from '@/app/(app)/beeline/useMembersConfiguration';
import { useMembersPresentation } from '@/app/(app)/beeline/useMembersPresentation';
import { agentSoulCopy, first } from '@/app/(app)/beeline/members';
import type { AgentVoiceApi } from './AgentVoice';

/**
 * The agent profile's data and actions: today's Members hooks composed the
 * way the old agent profile composed them (the one detail read, its live
 * refresh, soul edit, model/effort/fast, access, yolo and removal).
 */
export function useAgentProfile(agentId: string, workspaceId: string | undefined, close: () => void, roomId?: string) {
    const [
        identity, relayUrl, recordScope, setRosterQuery, resolvedWorkspaceId, focused, setIdentity, setRelayUrl,
        focusedRef, setWorkspaceError, readWorkspaceRef, agentRequestGenerationRef, retryGeneration,
        setSelectedAgent, setEditingAgentSoul, setOpenModelAxis, setModelAppliesNote, setYoloError,
        setAccessError, setLocalAgentId, setError, profileRetryGeneration, surface, setWorking,
        setPickerOpen, setPairCommand, requestedActionHandledRef, requestedAction, memberQuery,
        setRosterLoading, rosterLoading, selectedAgent, ownsSelectedAgent, editingAgentSoul,
        allowProfileNavigationRef, nameDraft, soulDraft, agentNameDraft, agentSoulDraft, navigation,
        pendingConfigWriteRef, applyAgentReceipt, finishConfigWrite, modelAppliesTimerRef,
        setModelAxisError, waitingForEffortCatalogRef, canRemoveSelectedAgent, error, workspaceError,
        working, , , setAgentNameDraft, setAgentSoulDraft,
        params, openModelAxis, modelSearchQuery, setModelSearchQuery, modelAppliesNote, modelAxisError,
        selectedAgentOwnerByline, , accessError, yoloError,
    ] = useMembersRouteState([workspaceId, agentId]);
    const [writeClient, readMemberPage, applyMemberPage, closeAgentSettings] = useMembersReads([
        identity, relayUrl, recordScope, setRosterQuery, resolvedWorkspaceId, focused, agentId,
        setIdentity, setRelayUrl, focusedRef, setWorkspaceError, readWorkspaceRef,
        agentRequestGenerationRef, retryGeneration, setSelectedAgent, setEditingAgentSoul,
        setOpenModelAxis, setModelAppliesNote, setYoloError, setAccessError, setLocalAgentId, setError,
        profileRetryGeneration,
    ]);
    const [messagePerson] = useMembersMembership([
        surface, resolvedWorkspaceId, relayUrl, setWorking, setError, writeClient, setPickerOpen,
        setSelectedAgent, setPairCommand, focused, requestedActionHandledRef, requestedAction, identity,
        memberQuery, setRosterQuery, setRosterLoading, readMemberPage, applyMemberPage, rosterLoading,
        recordScope,
    ]);
    const [closeAgentProfile, messageSelectedAgent, , beginAgentSoulEdit, saveAgentSoul] = useMembersSoul([
        identity, resolvedWorkspaceId, selectedAgent, ownsSelectedAgent, editingAgentSoul,
        allowProfileNavigationRef, nameDraft, soulDraft, setEditingAgentSoul, agentNameDraft,
        agentSoulDraft, close, messagePerson, agentId, navigation, setError, setWorking,
        pendingConfigWriteRef, writeClient, applyAgentReceipt, finishConfigWrite,
    ]);
    const [toggleModelAxis, setModelOption, setFastMode, toggleAnswersEveryone, toggleYolo, removeSelectedAgent] = useMembersConfiguration([
        modelAppliesTimerRef, setModelAppliesNote, selectedAgent, ownsSelectedAgent, () => modelAxes,
        setWorking, pendingConfigWriteRef, setError, writeClient, applyAgentReceipt, setOpenModelAxis,
        finishConfigWrite, setModelAxisError, waitingForEffortCatalogRef, setSelectedAgent,
        setYoloError, setAccessError, canRemoveSelectedAgent, resolvedWorkspaceId, recordScope,
        closeAgentSettings, agentId, close,
    ]);
    const [modelAxes, displayedError, busy] = useMembersPresentation([
        selectedAgent, error, workspaceError, working, surface, resolvedWorkspaceId,
    ]);
    const voiceRoomId = roomId ?? first(params.roomId);
    const voiceApi: AgentVoiceApi | undefined = identity && relayUrl && resolvedWorkspaceId ? {
        contextKey: `${resolvedWorkspaceId}:${voiceRoomId ?? ''}:${identity.publicKey}`,
        read: () => new RoomViewClient({ baseUrl: relayUrl, identity }).agentVoices(resolvedWorkspaceId, agentId, voiceRoomId),
        save: (voiceId) => new RoomViewClient({ baseUrl: relayUrl, identity }).setAgentVoice(resolvedWorkspaceId, agentId, voiceId),
        preview: (voiceId) => new RoomViewClient({ baseUrl: relayUrl, identity }).previewAgentVoice(resolvedWorkspaceId, agentId, voiceId),
    } : undefined;

    return {
        detail: selectedAgent, workspaceId: resolvedWorkspaceId, viewerId: identity?.publicKey,
        loading: !selectedAgent && !displayedError, error: displayedError, busy, working,
        canEdit: ownsSelectedAgent, canRemove: Boolean(selectedAgent && canRemoveSelectedAgent),
        ownerByline: selectedAgentOwnerByline, soul: selectedAgent ? agentSoulCopy(selectedAgent) : '',
        editing: editingAgentSoul, nameDraft: agentNameDraft, soulDraft: agentSoulDraft,
        setNameDraft: setAgentNameDraft, setSoulDraft: setAgentSoulDraft,
        beginEdit: beginAgentSoulEdit, cancelEdit: () => setEditingAgentSoul(false), saveEdit: () => void saveAgentSoul(),
        close: () => void closeAgentProfile(), message: () => void messageSelectedAgent(),
        modelAxes, openModelAxis, closeModelAxis: () => setOpenModelAxis(null), modelSearchQuery, setModelSearchQuery,
        modelAppliesNote, modelAxisError, toggleModelAxis, setModelOption, setFastMode,
        toggleAnswersEveryone, toggleYolo, removeAgent: removeSelectedAgent, accessError, yoloError,
        refreshUsage: () => monolithPhoneOperation('refreshAgentUsage', { workspaceId: selectedAgent!.workspaceId, agentId }, { timeoutMs: USAGE_REFRESH_CLIENT_TIMEOUT_MS }),
        saveWake: async (url: string, key?: string) => {
            if (!selectedAgent) return;
            applyAgentReceipt(await monolithPhoneOperation('updateAgentWake', {
                workspaceId: selectedAgent.workspaceId, agentId: selectedAgent.agent.identity.pubkey, url, ...(key ? { key } : {}),
            }));
        },
        voiceApi,
    };
}
export type AgentProfile = ReturnType<typeof useAgentProfile>;
