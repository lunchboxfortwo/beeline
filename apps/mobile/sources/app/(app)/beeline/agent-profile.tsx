import { router, useLocalSearchParams } from 'expo-router';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { AgentProfileScreen } from '@/ui/screens/profiles/AgentProfileScreen';

const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

/** The phone route for an agent's profile; desktop opens the same screen in the right panel. */
export default function AgentProfileRoute() {
  useLatencyRouteFrame('/beeline/agent-profile');
  const params = useLocalSearchParams<{ agentId: string; workspaceId?: string; communityId?: string; roomId?: string }>();
  const agentId = first(params.agentId) ?? '';
  return (
    <AgentProfileScreen key={agentId} agentId={agentId} workspaceId={first(params.workspaceId) ?? first(params.communityId)}
      roomId={first(params.roomId)} close={() => router.back()} />
  );
}
