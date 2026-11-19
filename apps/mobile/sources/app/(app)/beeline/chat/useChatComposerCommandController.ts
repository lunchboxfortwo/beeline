import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';
import type { AgentComposerCommand, RoomView } from '@beeline/api-contract/phone';
import * as Haptics from 'expo-haptics';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { BuzzRigTransport } from '@/sync/transport';
import type { RoomViewClient } from '@/sync/transport/room-view-client';
import { mentionedAgentPubkey, type RoomRosterParticipant } from '@/buzz/room-participants';
import {
  availableAgentMentionCommands, availableSlashVerbs, fastModeCommandState, slashVerbQuery,
  agentMentionSlashQuery, FAST_MODE_COMMAND, insertAgentSlashCommand, type FastModeCommandState,
} from '@/buzz/slash-verbs';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { COMPOSER_MIN_HEIGHT } from './chat-surface-values';

type Props = {
  roomParticipants: RoomRosterParticipant[];
  inputText: string;
  decodedId: string;
  viewerPubkey: string | undefined;
  roomClient: RoomViewClient | null;
  activeCommunityId: string | null;
  transport: BuzzRigTransport | null;
  setSessionTransport: (transport: BuzzRigTransport) => void;
  inputTextRef: RefObject<string>;
  setInputText: (text: string) => void;
  setInputSelection: (selection: { start: number; end: number }) => void;
  setComposerHeight: (height: number) => void;
  isCorner: boolean;
  isDirectMessage: boolean;
  viewerIsAgent: boolean;
  roomSurface: RoomView | null;
  canManageWorkspace: boolean;
  pendingCornerRequest: ChatDisplayMessage | undefined;
  pendingTargetBranchProposal: ChatDisplayMessage | undefined;
  targetBranchActionId: string | null;
  composerFocused: boolean;
  dismissedSlashText: string | null;
  setHighlightedSlashVerbIndex: (index: number) => void;
};

export function useChatComposerCommandController({
  roomParticipants, inputText, decodedId, viewerPubkey, roomClient, activeCommunityId,
  transport, setSessionTransport, inputTextRef, setInputText, setInputSelection, setComposerHeight,
  isCorner, isDirectMessage, viewerIsAgent, roomSurface, canManageWorkspace, pendingCornerRequest,
  pendingTargetBranchProposal, targetBranchActionId, composerFocused, dismissedSlashText,
  setHighlightedSlashVerbIndex,
}: Props) {
  /** Per-Room+agent command lists (undefined = unresolved, empty = advertises none). */
  const [agentCommandsByScope, setAgentCommandsByScope] = useState<
    Record<string, readonly AgentComposerCommand[]>
  >({});

  /** Per-Room+agent Fast mode toggle (undefined = unread, null = not offered to this viewer). */
  const [agentFastModeByScope, setAgentFastModeByScope] = useState<
    Record<string, FastModeCommandState | null>
  >({});

  const currentSlashQuery = useMemo(() => slashVerbQuery(inputText), [inputText]);

  // Mention-scoped palette: `@agent /query` addresses THAT agent's advertised
  // commands. Mutually exclusive with `currentSlashQuery` by shape — the plain
  // path requires the WHOLE composer to be one slash token.
  const mentionSlash = useMemo(() => agentMentionSlashQuery(inputText), [inputText]);

  const mentionSlashAgentPubkey = useMemo(() => {
    if (!mentionSlash) return null;
    return mentionedAgentPubkey(`@${mentionSlash.mention}`, roomParticipants.filter((member) => member.kind === 'agent')) ?? null;
  }, [mentionSlash, roomParticipants]);

  const mentionAgentCommandScope = mentionSlashAgentPubkey
    ? `${decodedId}:${viewerPubkey}:${mentionSlashAgentPubkey}`
    : null;

  const mentionAgentCommands = useMemo(() => {
    if (!mentionSlash || !mentionAgentCommandScope) return [];
    const published = agentCommandsByScope[mentionAgentCommandScope];
    return availableAgentMentionCommands(
      published ?? [],
      mentionSlash.query,
      agentFastModeByScope[mentionAgentCommandScope],
    );
  }, [agentCommandsByScope, agentFastModeByScope, mentionAgentCommandScope, mentionSlash]);

  // True only once the read RESOLVED (absent or empty list): an in-flight or
  // failed read is unknown, never "does not advertise".
  const mentionAgentLacksCommands = Boolean(
    mentionSlash &&
    mentionSlashAgentPubkey &&
    mentionAgentCommandScope &&
    agentCommandsByScope[mentionAgentCommandScope] !== undefined &&
    (agentCommandsByScope[mentionAgentCommandScope]?.length ?? 0) === 0,
  );

  // Load the addressed agent's published command list on demand — the palette
  // combines this record with server-authorized Beeline actions. A
  // failed read stays unknown and never blocks typing.
  useEffect(() => {
    const pubkey = mentionSlashAgentPubkey;
    const scope = mentionAgentCommandScope;
    if (!pubkey || !scope || !roomClient || !activeCommunityId) return;
    if (agentCommandsByScope[scope] !== undefined && agentFastModeByScope[scope] !== undefined) {
      return;
    }
    let cancelled = false;
    roomClient
      .agent(activeCommunityId, pubkey)
      .then((detail) => {
        if (!cancelled) {
          setAgentCommandsByScope((current) => ({
            ...current,
            [scope]: detail.commands ?? [],
          }));
          setAgentFastModeByScope((current) => ({
            ...current,
            [scope]: fastModeCommandState(detail, viewerPubkey),
          }));
        }
      })
      .catch(() => {
        // A transport failure is not evidence that no record exists. Keep the
        // scope unresolved so the palette never makes a false absence claim.
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeCommunityId,
    agentCommandsByScope,
    agentFastModeByScope,
    decodedId,
    mentionAgentCommandScope,
    mentionSlashAgentPubkey,
    roomClient,
    viewerPubkey,
  ]);

  // Re-read owner actions each time the palette opens so profile changes
  // cannot leave an earlier permission or toggle state on screen.
  useEffect(() => {
    if (mentionSlashAgentPubkey) return;
    setAgentFastModeByScope((current) => (Object.keys(current).length ? {} : current));
  }, [mentionSlashAgentPubkey]);

  /**
   * Insert a selected agent command in place of the typed `/query` token,
   * KEEPING the @mention that scoped the palette. The trailing space closes
   * the palette and leaves the composer ready for the command's arguments.
   */
  const insertAgentCommand = useCallback(
    (name: string) => {
      const next = insertAgentSlashCommand(inputText, name);
      inputTextRef.current = next;
      setInputText(next);
      setInputSelection({ start: next.length, end: next.length });
      setComposerHeight(COMPOSER_MIN_HEIGHT);
      void Haptics.selectionAsync();
    },
    [inputText, inputTextRef, setInputText, setInputSelection, setComposerHeight],
  );

  /**
   * Fast mode is the owner's toggle, not text: it writes through the same
   * `updateAgentModelSelection` operation as the profile switch and leaves
   * the palette open on the new state.
   */
  const toggleAgentFastMode = useCallback(async () => {
    const pubkey = mentionSlashAgentPubkey;
    const scope = mentionAgentCommandScope;
    const current = scope ? agentFastModeByScope[scope] : null;
    if (!pubkey || !scope || !current || current.status === 'saving' || !activeCommunityId) {
      return;
    }
    const enabled = !current.enabled;
    setAgentFastModeByScope((state) => ({
      ...state,
      [scope]: { enabled: current.enabled, status: 'saving' },
    }));
    void Haptics.selectionAsync();
    try {
      let writeTransport = transport;
      if (!writeTransport) {
        const identity = await loadBuzzIdentity();
        if (!identity) throw new Error('Beeline identity is unavailable');
        writeTransport = new BuzzRigTransport(identity);
        setSessionTransport(writeTransport);
      }
      const client = await writeTransport.ensureClient();
      await client.setAgentModelConfig(activeCommunityId, pubkey, { fastMode: enabled });
      setAgentFastModeByScope((state) => ({ ...state, [scope]: { enabled } }));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      setAgentFastModeByScope((state) => ({
        ...state,
        [scope]: { enabled: current.enabled, status: 'failed' },
      }));
    }
  }, [
    activeCommunityId,
    agentFastModeByScope,
    mentionAgentCommandScope,
    mentionSlashAgentPubkey,
    setSessionTransport,
    transport,
  ]);

  const selectAgentCommand = useCallback(
    (name: string) => {
      if (name === FAST_MODE_COMMAND) {
        void toggleAgentFastMode();
        return;
      }
      insertAgentCommand(name);
    },
    [insertAgentCommand, toggleAgentFastMode],
  );

  const slashVerbs = useMemo(
    () =>
      availableSlashVerbs(
        {
          canBuild: Boolean(
            !isCorner && !isDirectMessage && !viewerIsAgent && roomSurface?.viewer.permissions.send,
          ),
          canCreatePoll: Boolean(
            !isCorner && !isDirectMessage && !viewerIsAgent && roomSurface?.viewer.permissions.send,
          ),
          canManageSchedules: Boolean(
            !isCorner &&
            !viewerIsAgent &&
            (isDirectMessage ? Boolean(roomSurface?.viewer.permissions.send) : canManageWorkspace),
          ),
          canRunWorkflows: Boolean(
            !isCorner &&
            !isDirectMessage &&
            !viewerIsAgent &&
            canManageWorkspace &&
            roomSurface?.repositoryResolution === 'repository',
          ),
          canOpenCorner: Boolean(!isCorner && !viewerIsAgent && pendingCornerRequest),
          canRename: Boolean(!isCorner && !isDirectMessage && !viewerIsAgent && canManageWorkspace),
          canCloseCorner: isCorner && !viewerIsAgent,
          canChangeTargetBranch: Boolean(
            !isCorner &&
            !viewerIsAgent &&
            canManageWorkspace &&
            pendingTargetBranchProposal &&
            !targetBranchActionId,
          ),
          canAddAgent: Boolean(!isCorner && !isDirectMessage && !viewerIsAgent),
          canInvitePerson: Boolean(
            !isCorner && !isDirectMessage && !viewerIsAgent && canManageWorkspace,
          ),
        },
        currentSlashQuery ?? mentionSlash?.query ?? '',
      ),
    [
      currentSlashQuery,
      mentionSlash?.query,
      canManageWorkspace,
      isCorner,
      isDirectMessage,
      pendingCornerRequest,
      pendingTargetBranchProposal,
      targetBranchActionId,
      viewerIsAgent,
      roomSurface?.repositoryResolution,
      roomSurface?.viewer.permissions.send,
    ],
  );

  const slashMenuVisible = Boolean(
    composerFocused &&
    (currentSlashQuery !== null || (mentionSlash !== null && mentionSlashAgentPubkey !== null)) &&
    dismissedSlashText !== inputText,
  );

  const paletteItemCount = mentionAgentCommands.length + slashVerbs.length;

  useEffect(() => {
    setHighlightedSlashVerbIndex(0);
  }, [currentSlashQuery, mentionSlash?.query, paletteItemCount]);

  return useMemo(() => ({
    currentSlashQuery, mentionSlash, mentionSlashAgentPubkey, mentionAgentCommands,
    mentionAgentLacksCommands, slashVerbs, slashMenuVisible, paletteItemCount, selectAgentCommand,
  }), [
    currentSlashQuery, mentionSlash, mentionSlashAgentPubkey, mentionAgentCommands,
    mentionAgentLacksCommands, slashVerbs, slashMenuVisible, paletteItemCount, selectAgentCommand,
  ]);
}

export type ChatComposerCommandController = ReturnType<typeof useChatComposerCommandController>;
