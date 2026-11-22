// Adapters for the frame: data hooks read the fixture; navigation, media and
// network do nothing. Rendering components are the production ones.
import React from 'react';
const f = () => (globalThis as any).__frame;
export const useRoomView = () => ({ room: f().room, viewerPubkey: 'a'.repeat(64), error: null, refresh() {}, accept() {} });
export const useWorkspaceRoster = () => f().roster;
export const workspaceRecord = () => f().record;
export const useAgentProfile = () => f().profile;
export const useActiveCommunityId = () => 'w';
export const openPlace = () => {};
export const useIsDesktop = () => false;
export const useLatencyRouteFrame = () => undefined;
export const monolithPhoneOperation = async () => ({});
export const InvitePeopleSheet = () => null;
export const VoicePreviewPlayer = () => null;
export const AgentVoice = () => null;
export const router = { push() {}, navigate() {}, back() {} };
export const setStringAsync = async () => undefined;
export const Modal = { alert() {}, confirm: async () => false };
export default {};
export const useFocusEffect = () => {};
export const useLocalSearchParams = () => ({});
export const useRouter = () => router;
export const usePathname = () => '/';
export const Link = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
export class MonolithPhoneOperationError extends Error {}
