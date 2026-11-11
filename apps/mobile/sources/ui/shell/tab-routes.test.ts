import { describe, expect, it } from 'vitest';

import { tabForPath } from './tab-routes';

describe('tabForPath', () => {
    it('lights the place a route belongs to', () => {
        expect(tabForPath('/')).toBe('chats');
        expect(tabForPath('/beeline/channels')).toBe('chats');
        expect(tabForPath('/beeline/members')).toBe('chats');
        expect(tabForPath('/beeline/chat-info')).toBe('chats');
        expect(tabForPath('/beeline/tray')).toBe('tags');
        expect(tabForPath('/beeline/people')).toBe('people');
        expect(tabForPath('/beeline/settings/workbench')).toBe('settings');
    });

    it('draws no tab bar under a conversation, a viewer or setup', () => {
        for (const path of ['/beeline/chat/abc', '/artifact-viewer', '/beeline/browser-share', '/beeline/onboarding', '/join/x', '/review/y', '/beeline/community'])
            expect(tabForPath(path)).toBeNull();
    });
});
