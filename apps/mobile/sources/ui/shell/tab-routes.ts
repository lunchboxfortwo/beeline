/** The phone's four places and which routes draw the tab bar. */
export type Tab = 'chats' | 'tags' | 'people' | 'settings';
export const TAB_ROUTES: Record<Tab, string> = {
    chats: '/beeline/channels',
    tags: '/beeline/tray',
    people: '/beeline/people',
    settings: '/beeline/settings',
};
// Places that own the whole screen on a phone: no tab bar under them.
const BARE = [
    '/beeline/chat/', '/beeline/onboarding', '/beeline/community', '/beeline/create-workspace',
    '/join/', '/review/', '/artifact-viewer', '/beeline/browser-share', '/text-selection',
    '/beeline/github-callback', '/beeline/github-installation', '/beeline/google-callback',
    '/buzz/', '/changelog', '/settings',
];

/** The lit tab for a route, or null when the route draws no tab bar. */
export function tabForPath(pathname: string): Tab | null {
    if (BARE.some((prefix) => pathname.startsWith(prefix))) return null;
    if (pathname.startsWith('/beeline/tray')) return 'tags';
    if (pathname.startsWith('/beeline/people')) return 'people';
    if (pathname.startsWith('/beeline/settings')) return 'settings';
    return 'chats';
}

