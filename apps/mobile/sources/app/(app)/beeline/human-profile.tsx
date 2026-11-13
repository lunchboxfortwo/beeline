import { router, useLocalSearchParams } from 'expo-router';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { PersonProfileScreen } from '@/ui/screens/profiles/PersonProfileScreen';

const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

/** The phone route for a person's profile; desktop opens the same screen in the right panel. */
export default function HumanProfileRoute() {
  useLatencyRouteFrame('/beeline/human-profile');
  const params = useLocalSearchParams<{ memberId: string; workspaceId?: string; communityId?: string }>();
  return (
    <PersonProfileScreen memberId={first(params.memberId) ?? ''} workspaceId={first(params.workspaceId) ?? first(params.communityId)} close={() => router.back()} />
  );
}

/** Compatibility for older embedders (desktop work pane); new callers use `openPlace({ kind: 'person' })`. */
export function HumanProfile({ workspaceId, memberId, onClose }: { workspaceId: string; memberId: string; onClose: () => void }) {
  return <PersonProfileScreen memberId={memberId} workspaceId={workspaceId} close={onClose} />;
}
