import { Redirect, router, useLocalSearchParams, type Href } from 'expo-router';
import type { AgentDetailView, AgentModelConfigInput, AgentModelConfigOption, WorkspaceView } from '@beeline/buzz-client';
import { defaultAgentPersona } from '@/buzz/agent-persona';
import { effortConfigAxis } from '@/buzz/agent-model-picker';
import { MembersScreen } from '@/ui/screens/members/MembersScreen';
import { AgentProfileScreen } from '@/ui/screens/profiles/AgentProfileScreen';

// Shared by the agent profile's `useMembers*` hooks (ui/screens/profiles/useAgentProfile.ts).

export type MembersAction =
  | 'invite-person'
  | 'pair-agent'
  | 'person-role'
  | 'remove-person'
  | 'message-person'
  | 'save-agent-soul'
  | 'remove-agent'
  | 'model-config'
  | 'model-catalog'
  | 'agent-yolo'
  | 'agent-access';

export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function newerConfigVersion(candidate: string, current: string | undefined): boolean {
  return (
    !current ||
    candidate.length > current.length ||
    (candidate.length === current.length && candidate > current)
  );
}

export function ownerByline(
  owner: NonNullable<WorkspaceView['agents'][number]['owner']>,
): string | undefined {
  return owner.handle ? `by @${owner.handle}` : undefined;
}

export type ModelAxisKind = 'model' | 'effort';

export const MODEL_APPLIES_NOTE_MS = 4_000;

function axisValue(
  detail: AgentDetailView,
  kind: ModelAxisKind,
  axis: AgentModelConfigOption | undefined,
): string | undefined {
  if (kind === 'model') {
    return detail.selected?.model ?? detail.runtimeSelection?.model ?? axis?.currentValue;
  }
  return detail.selected?.effort ?? detail.runtimeSelection?.effort ?? axis?.currentValue;
}

/**
 * The soul text this agent is running under: its own if a manager has written
 * one, otherwise the soul seeded from its animal. `defaultAgentPersona` remains
 * the last resort for a stack that does not index a seeded soul.
 */
export function agentSoulCopy(detail: AgentDetailView): string {
  return (
    detail.soul?.instructions ??
    detail.seededSoul ??
    defaultAgentPersona(detail.agent.identity.pubkey).soul
  );
}

/**
 * A model's effort choices can be model-specific. The catalog only proves an
 * effort compatible with its own current model, so a change to any other
 * model must explicitly clear the old human pick. That lets the next cold
 * activation use the target model's native default instead of inheriting an
 * invalid launch argument. This remains provider-neutral: Codex and Claude
 * receive the same safe reset, while re-selecting the catalog's live model
 * keeps its advertised default atomically.
 */
export function modelSelectionInput(
  detail: AgentDetailView,
  axis: AgentModelConfigOption | undefined,
  model: string,
): AgentModelConfigInput {
  if (!axis) {
    return axisValue(detail, 'model', undefined) === model ? { model } : { model, effort: null };
  }
  if (axis.currentValue !== model) return { model, effort: null };
  const effortAxis = effortConfigAxis(detail.catalog);
  const effort = effortAxis?.currentValue;
  return effort && effortAxis.options.some((choice) => choice.id === effort)
    ? { model, effort }
    : { model, effort: null };
}

type MembersRouteProps = {
  profileAgentId?: string;
  workspaceIdOverride?: string;
  profileRoomId?: string;
  onClose?: () => void;
};

/**
 * `/beeline/members?roomId=` is a chat's Members page. A link without a Room
 * (the old workspace roster, `action=invite|add-agent`) opens the People tab.
 * Embedded with `profileAgentId` (the desktop work pane) it shows that
 * agent's profile, the same screen as everywhere else.
 */
export default function MembersRoute({ profileAgentId, workspaceIdOverride, profileRoomId, onClose }: MembersRouteProps = {}) {
  if (profileAgentId) {
    return (
      <AgentProfileScreen agentId={profileAgentId} workspaceId={workspaceIdOverride} roomId={profileRoomId}
        close={onClose ?? (() => router.back())} />
    );
  }
  return <ChatMembersRoute />;
}

function ChatMembersRoute() {
  const params = useLocalSearchParams<{
    roomId?: string | string[];
    communityId?: string | string[];
    action?: string | string[];
  }>();
  const roomId = first(params.roomId);
  if (!roomId) {
    const communityId = first(params.communityId);
    const action = first(params.action);
    return (
      <Redirect
        href={{
          pathname: '/beeline/people',
          params: { ...(communityId ? { communityId } : {}), ...(action ? { action } : {}) },
        } as unknown as Href}
      />
    );
  }
  return (
    <MembersScreen
      roomId={roomId}
      close={() => (router.canGoBack() ? router.back() : router.replace('/beeline/channels' as Href))}
    />
  );
}
