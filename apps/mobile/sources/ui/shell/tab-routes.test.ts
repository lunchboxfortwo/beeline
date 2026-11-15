import { describe, expect, it } from 'vitest';

import { isTabRootPath, tabForPath } from './tab-routes';

describe('isTabRootPath', () => {
    it.each(['/', '/index', '/beeline', '/beeline/', '/beeline/index', '/beeline/index/'])
    ('shows the Chats header on the landing alias %s', path => {
        expect(isTabRootPath(path)).toBe(true);
    });

    it.each(['channels', 'tray', 'people', 'settings'].flatMap(tab => [
        `/beeline/${tab}`, `/beeline/${tab}/`, `/beeline/${tab}/index`, `/beeline/${tab}/index/`,
    ]))('shows the header on the tab root %s', path => {
        expect(isTabRootPath(path)).toBe(true);
    });

    it.each([
        '/beeline/chat/room', '/beeline/chat/room/', '/beeline/settings/workbench',
        '/beeline/settings/workbench/index', '/beeline/members', '/beeline/chat-info',
        '/beeline/channels-extra', '/beeline/tray/details', '/beeline/people/person',
        '/beeline/onboarding', '/beeline/community', '/join/x', '/review/y',
        '/artifact-viewer', '/settings', '/unknown',
    ])('leaves the screen header in charge on %s', path => {
        expect(isTabRootPath(path)).toBe(false);
    });
});

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
