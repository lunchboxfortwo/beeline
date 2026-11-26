import { describe, expect, it } from 'vitest';
import { beelineUrlHref } from './beeline-url';

describe('beelineUrlHref', () => {
  it('routes web.usebeeline.app, app.usebeeline.app, usebeeline.app, and beeline:// chat links in-app', () => {
    expect(
      beelineUrlHref(
        'https://web.usebeeline.app/beeline/chat/room-1?communityId=ws-1&parent=parent-1&title=Fix+bug&notificationMessageId=msg-1&notificationResponseId=resp-1&ignored=1',
      ),
    ).toEqual({
      pathname: '/beeline/chat/[channelId]',
      params: {
        channelId: 'room-1',
        communityId: 'ws-1',
        parent: 'parent-1',
        title: 'Fix bug',
        notificationMessageId: 'msg-1',
        notificationResponseId: 'resp-1',
      },
    });
    expect(beelineUrlHref('https://app.usebeeline.app/beeline/chat/room-2/')).toEqual({
      pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'room-2' },
    });
    expect(beelineUrlHref('https://usebeeline.app/beeline/chat/room-3?communityId=ws-3')).toEqual({
      pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'room-3', communityId: 'ws-3' },
    });
    expect(beelineUrlHref('beeline://beeline/chat/room-4?communityId=ws-4')).toEqual({
      pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'room-4', communityId: 'ws-4' },
    });
  });

  it('routes tray, channels, and join links in-app while preserving allowed params', () => {
    expect(beelineUrlHref('https://web.usebeeline.app/beeline/tray?communityId=ws-1&chatId=chat-1')).toEqual({
      pathname: '/beeline/tray',
      params: { communityId: 'ws-1', chatId: 'chat-1' },
    });
    expect(beelineUrlHref('beeline://beeline/tray')).toEqual({
      pathname: '/beeline/tray',
    });
    expect(beelineUrlHref('https://web.usebeeline.app/beeline/channels?communityId=ws-2')).toEqual({
      pathname: '/beeline/channels',
      params: { communityId: 'ws-2' },
    });
    expect(beelineUrlHref('https://usebeeline.app/join/invite-token-42')).toEqual({
      pathname: '/join/[token]',
      params: { token: 'invite-token-42' },
    });
    expect(beelineUrlHref('beeline://join/invite-token-99')).toEqual({
      pathname: '/join/[token]',
      params: { token: 'invite-token-99' },
    });
  });

  it('leaves OAuth callbacks, static web pages, media links, and external hosts to the browser', () => {
    for (const url of [
      'https://web.usebeeline.app/beeline/github-callback?code=abc',
      'https://web.usebeeline.app/beeline/google-callback?state=xyz',
      'https://usebeeline.app/privacy',
      'https://usebeeline.app/terms',
      'https://usebeeline.app/connect',
      'https://usebeeline.app/dl',
      'https://web.usebeeline.app/v1/media/abc',
      'https://example.com/beeline/chat/room-1',
      'not a url',
    ]) {
      expect(beelineUrlHref(url)).toBeNull();
    }
  });
});
