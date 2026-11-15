import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('tamagui', () => ({ YStack: (props: any) => React.createElement('YStack', props, props.children) }));
vi.mock('@/buzz/needs-you-store', () => ({ useNeedsYouCount: () => 2 }));
vi.mock('@/buzz/use-active-community', () => ({ useActiveCommunityId: () => 'w1' }));
vi.mock('./TabBar', () => ({ TabBar: (props: any) => React.createElement('TabBar', props) }));

import { PhoneTabScreen, SharedTabBarHeight } from './PhoneTabScreen';

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

const Body = () => null;

function screen(name: string) {
    let tree: any;
    act(() => { tree = create(<PhoneTabScreen route={{ name }}><Body /></PhoneTabScreen>); });
    return tree.root;
}

// A bar shared under the whole stack disappeared only after a pushed chat's
// first frame, so the chat laid out above it and its composer then dropped by
// one bar height. Each screen now carries the bar its own route draws.
it('draws no bar under a chat or thread screen, whatever else is on the stack', () => {
    const chat = screen('beeline/chat/[channelId]');
    expect(chat.findAllByType('TabBar' as any)).toHaveLength(0);
    expect(chat.findAllByType(Body)).toHaveLength(1);
});

it('draws the lit bar under a place screen', () => {
    expect(screen('beeline/channels').findByType('TabBar' as any).props).toMatchObject({ active: 'chats', tagsCount: 2 });
    expect(screen('beeline/tray').findByType('TabBar' as any).props.active).toBe('tags');
});

it('reserves the shared bar under a tab root and keeps its own bar on a pushed place', () => {
    const shared = (name: string) => {
        let tree: any;
        act(() => { tree = create(<SharedTabBarHeight.Provider value={64}><PhoneTabScreen route={{ name }}><Body /></PhoneTabScreen></SharedTabBarHeight.Provider>); });
        return tree.root;
    };
    for (const name of ['index', 'beeline/channels', 'beeline/tray', 'beeline/people', 'beeline/settings/index']) {
        const root = shared(name);
        expect(root.findAllByType('TabBar' as any)).toHaveLength(0);
        expect(root.findAll((node: any) => node.type === 'YStack' && node.props.height === 64)).toHaveLength(1);
    }
    expect(shared('beeline/members').findByType('TabBar' as any).props.active).toBe('chats');
    expect(shared('beeline/chat/[channelId]').findAllByType('TabBar' as any)).toHaveLength(0);
});
