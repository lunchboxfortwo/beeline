import { useSyncExternalStore } from 'react';
import { router } from 'expo-router';

/**
 * Desktop right panel (build spec → desktop): chat info, Members, profiles and
 * the brief open beside the middle column instead of being pushed. On a phone
 * the same places are ordinary routes. Switching chats closes the panel.
 */
export type PanelPlace =
    | { kind: 'members'; roomId: string }
    | { kind: 'chat-info'; roomId: string }
    | { kind: 'agent'; agentId: string; workspaceId?: string }
    | { kind: 'person'; memberId: string; workspaceId?: string }
    | { kind: 'brief'; roomId: string };

let current: PanelPlace | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export function openPanel(place: PanelPlace) { current = place; emit(); }
export function closePanel() { if (!current) return; current = null; emit(); }
export function usePanel(): PanelPlace | null {
    return useSyncExternalStore(
        (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        () => current,
        () => null,
    );
}

/** The phone route for a place. */
export function routeFor(place: PanelPlace): string {
    switch (place.kind) {
        case 'members': return `/beeline/members?roomId=${encodeURIComponent(place.roomId)}`;
        case 'chat-info': return `/beeline/chat-info?roomId=${encodeURIComponent(place.roomId)}`;
        case 'agent': return `/beeline/agent-profile?agentId=${encodeURIComponent(place.agentId)}${place.workspaceId ? `&workspaceId=${encodeURIComponent(place.workspaceId)}` : ''}`;
        case 'person': return `/beeline/human-profile?memberId=${encodeURIComponent(place.memberId)}${place.workspaceId ? `&workspaceId=${encodeURIComponent(place.workspaceId)}` : ''}`;
        case 'brief': return `/beeline/brief?roomId=${encodeURIComponent(place.roomId)}`;
    }
}

/** Opens a place: the right panel on desktop, a pushed screen on a phone. */
export function openPlace(place: PanelPlace, desktop: boolean) {
    if (desktop) openPanel(place);
    else router.push(routeFor(place) as never);
}
