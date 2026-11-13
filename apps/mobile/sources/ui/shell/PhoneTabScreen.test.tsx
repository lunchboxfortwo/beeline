import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('tamagui', () => ({ YStack: (props: any) => React.createElement('YStack', props, props.children) }));
vi.mock('@/buzz/needs-you-store', () => ({ useNeedsYouCount: () => 2 }));
vi.mock('@/buzz/use-active-community', () => ({ useActiveCommunityId: () => 'w1' }));
vi.mock('./TabBar', () => ({ TabBar: (props: any) => React.createElement('TabBar', props) }));

import { PhoneTabScreen } from './PhoneTabScreen';

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
