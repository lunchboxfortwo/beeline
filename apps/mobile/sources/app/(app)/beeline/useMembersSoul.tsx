import { appErrorCopy } from '@/buzz/app-error-copy';
import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { type AgentDetailView, type Identity } from '@beeline/buzz-client';
import { agentHandleRefusal, normalizeAgentHandleInput } from '@beeline/api-contract/phone';
import { BuzzRigTransport } from '@/sync/transport';
import { Modal } from '@/modal/ModalManager';
import { MembersAction, agentSoulCopy } from './members';

type Props = [
  identity: Identity | null,
  workspaceId: string | undefined,
  selectedAgent: AgentDetailView | null,
  ownsSelectedAgent: boolean,
  editingAgentSoul: boolean,
  allowProfileNavigationRef: React.RefObject<boolean>,
  handleDraft: import("@/buzz/text-draft-store").TextDraft<string>,
  soulDraft: import("@/buzz/text-draft-store").TextDraft<string>,
  setEditingAgentSoul: React.Dispatch<React.SetStateAction<boolean>>,
  agentHandleDraft: string,
  agentSoulDraft: string,
  onClose: (() => void) | undefined,
  messagePerson: (pubkey: string) => Promise<void>,
  profileAgentId: string | undefined,
  navigation: Omit<import("@react-navigation/core").NavigationProp<ReactNavigation.RootParamList>, "getState"> & { getState(): import("@react-navigation/routers").NavigationState | undefined; },
  setError: React.Dispatch<React.SetStateAction<string | null>>,
  setWorking: React.Dispatch<React.SetStateAction<MembersAction | null>>,
  pendingConfigWriteRef: React.RefObject<boolean>,
  writeClient: () => Promise<import("@beeline/buzz-client").BuzzClient & { refreshAgentModelCatalog(workspaceId: string, agentId: string): Promise<unknown>; }>,
  applyAgentReceipt: (value: AgentDetailView) => void,
  finishConfigWrite: (agentId: string) => void,
  setHandleError: React.Dispatch<React.SetStateAction<string | null>>,
];
export function useMembersSoul([
  identity, workspaceId, selectedAgent, ownsSelectedAgent, editingAgentSoul,
  allowProfileNavigationRef, handleDraft, soulDraft, setEditingAgentSoul, agentHandleDraft,
  agentSoulDraft, onClose, messagePerson, profileAgentId, navigation, setError, setWorking,
  pendingConfigWriteRef, writeClient, applyAgentReceipt, finishConfigWrite, setHandleError,
]: Props): [
  closeAgentProfile: () => Promise<void>,
  messageSelectedAgent: () => Promise<void>,
  requestSoulAvatar: (soul: string) => Promise<void>,
  beginAgentSoulEdit: () => void,
  saveAgentSoul: () => Promise<boolean>,
] {


  // The soul reaches the agent through the server: unsaved edits are saved
  // first and the agent draws from its saved soul. The visible request stays
  // a short "/draw-avatar" and never carries the soul text.
  const requestSoulAvatar = async (soul: string) => {
    if (!identity || !workspaceId || !selectedAgent || !ownsSelectedAgent)
      throw new Error('Agent settings are unavailable.');
    if (!soul.trim()) throw new Error('The soul is empty; set a soul before generating an avatar.');
    if (editingAgentSoul && agentEditDirty && !(await saveAgentSoul()))
      throw new Error('Could not save the soul for avatar generation.');
    const client = new BuzzRigTransport(identity);
    const agent = selectedAgent.agent.identity;
    const room = await client.resolveDirectMessage(workspaceId, agent.pubkey);
    const message = await client.composeMessage(
      {
        sessionId: room.channelId,
        text: '/draw-avatar',
      },
      { mentionAgent: agent.pubkey },
    );
    await client.publishPreparedMessage(message);
  };

  const beginAgentSoulEdit = () => {
    if (!selectedAgent || !ownsSelectedAgent) return;
    allowProfileNavigationRef.current = false;
    handleDraft.initialize(currentHandle(selectedAgent));
    soulDraft.initialize(agentSoulCopy(selectedAgent));
    setHandleError(null);
    setEditingAgentSoul(true);
  };

  const agentEditDirty = Boolean(
    editingAgentSoul &&
    selectedAgent &&
    (agentHandleDraft !== currentHandle(selectedAgent) ||
      agentSoulDraft !== agentSoulCopy(selectedAgent)),
  );
  const confirmDiscardAgentEdit = async (): Promise<boolean> => {
    if (!agentEditDirty) return true;
    const clearHandle = handleDraft.capture();
    const clearSoul = soulDraft.capture();
    const confirmed = await Modal.confirm(
      'Discard agent changes?',
      'Your handle and soul edits have not been saved.',
      {
        cancelText: 'Keep editing',
        confirmText: 'Discard',
        destructive: true,
      },
    );
    if (confirmed) {
      clearHandle();
      clearSoul();
    }
    return confirmed;
  };
  const closeAgentProfile = async () => {
    if (!(await confirmDiscardAgentEdit())) return;
    allowProfileNavigationRef.current = true;
    setEditingAgentSoul(false);
    (onClose ?? (() => router.back()))();
  };
  const messageSelectedAgent = async () => {
    if (!(await confirmDiscardAgentEdit())) return;
    allowProfileNavigationRef.current = true;
    setEditingAgentSoul(false);
    await messagePerson(profileAgentId!);
    allowProfileNavigationRef.current = false;
  };

  useEffect(() => {
    if (!profileAgentId || !agentEditDirty) return;
    return navigation.addListener('beforeRemove', (event) => {
      if (allowProfileNavigationRef.current) return;
      event.preventDefault();
      void confirmDiscardAgentEdit().then((confirmed) => {
        if (!confirmed) return;
        allowProfileNavigationRef.current = true;
        setEditingAgentSoul(false);
        navigation.dispatch(event.data.action);
      });
    });
  }, [navigation, profileAgentId, agentEditDirty]);

  useEffect(() => {
    if (!profileAgentId || Platform.OS !== 'web' || typeof window === 'undefined') return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void closeAgentProfile();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [profileAgentId, agentEditDirty, onClose]);

  const saveAgentSoul = async (): Promise<boolean> => {
    if (!selectedAgent || !ownsSelectedAgent || !workspaceId) return false;
    const handle = normalizeAgentHandleInput(agentHandleDraft);
    const soul = agentSoulDraft.trim();
    const handleChanged = handle !== currentHandle(selectedAgent);
    const refusal = handleChanged ? agentHandleRefusal(handle) : null;
    setHandleError(refusal);
    if (refusal) return false;
    if (!soul) {
      setError('Agent soul instructions cannot be empty.');
      return false;
    }
    const clearHandle = handleDraft.capture(false);
    const clearSoul = soulDraft.capture(false);
    setWorking('save-agent-soul');
    pendingConfigWriteRef.current = true;
    setError(null);
    try {
      const pubkey = selectedAgent.agent.identity.pubkey;
      const client = await writeClient();
      const receipt = await client.setAgentSoul(workspaceId, pubkey, {
        ...(handleChanged ? { handle } : {}),
        soul,
        avatarSeed: selectedAgent.soul?.avatarSeed ?? pubkey,
        ...(selectedAgent.soul?.avatar ? { avatar: selectedAgent.soul.avatar } : {}),
      });
      applyAgentReceipt(receipt as unknown as AgentDetailView);
      clearHandle();
      clearSoul();
      setEditingAgentSoul(false);
      return true;
    } catch (reason) {
      // A refused handle is shown under the handle field; nothing was saved.
      const copy = appErrorCopy(reason, `Could not save agent settings.`);
      if (handleChanged && isHandleRefusal(reason)) setHandleError(copy);
      else setError(copy);
      return false;
    } finally {
      finishConfigWrite(selectedAgent.agent.identity.pubkey);
      setWorking(null);
    }
  };
return [
    closeAgentProfile, messageSelectedAgent, requestSoulAvatar, beginAgentSoulEdit, saveAgentSoul,
  ];
}

/** The handle the profile shows, which an owner edits. */
function currentHandle(agent: AgentDetailView): string {
  return agent.agent.identity.handle ?? '';
}

/** The server refuses a handle with 400 (shape) or 409 (taken in this workspace). */
function isHandleRefusal(reason: unknown): boolean {
  const status = reason && typeof reason === 'object' ? (reason as { status?: unknown }).status : undefined;
  return status === 400 || status === 409;
}
