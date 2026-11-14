import { router } from 'expo-router';

/** Destinations opened in the main navigation stack on every screen size. */
export type PanelPlace =
    | { kind: 'members'; roomId: string }
    | { kind: 'chat-info'; roomId: string }
    | { kind: 'agent'; agentId: string; workspaceId?: string }
    | { kind: 'person'; memberId: string; workspaceId?: string }
    | { kind: 'brief'; roomId: string };

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

/** Desktop and phone both open these destinations in the main panel. */
export function openPlace(place: PanelPlace, _desktop: boolean) {
    router.push(routeFor(place) as never);
}
