import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ useWindowDimensions: () => ({ height: 844, width: 390 }), Linking: { openURL: vi.fn() } }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: (props: Record<string, unknown>) => React.createElement('IdentityMark', props) }));
vi.mock('@/assets/images/agent-logos/claude.png', () => ({ default: 'claude.png' }));
vi.mock('@/assets/images/agent-logos/codex.png', () => ({ default: 'codex.png' }));
vi.mock('@/assets/images/agent-logos/grok.png', () => ({ default: 'grok.png' }));
vi.mock('@/assets/images/agent-logos/muse.png', () => ({ default: 'muse.png' }));
const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('expo-clipboard', () => clipboard);
const operation = vi.hoisted(() => vi.fn());
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: operation }));
const openExternalUrl = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl }));

import { agentInvitationPickerGuide } from '@beeline/api-contract/agent-invitation-guide';
import { AddAgentSheet } from './AddAgentSheet';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

const text = (tree: any) => tree.root.findAll((node: any) => node.type === 'Text').map((node: any) => node.props.children);
const byTestID = (tree: any, testID: string) => tree.root.find((node: any) => node.props.testID === testID && typeof node.type === 'string');
const byLabel = (tree: any, label: string) => tree.root.find((node: any) => node.props['aria-label'] === label && typeof node.type === 'string');

async function openExternal() {
    let tree: any;
    await act(async () => {
        tree = create(<AddAgentSheet open close={vi.fn()} workspaceId={WORKSPACE} workspaceName="Beeline Work" agents={[]} />);
    });
    await act(async () => { byTestID(tree, 'agent-external').props.onPress(); });
    return tree;
}

beforeEach(() => {
    operation.mockReset().mockResolvedValue({ code: 'PAIRCODE', expiresAt: 0, invitationGuide: agentInvitationPickerGuide() });
    clipboard.setStringAsync.mockClear();
    openExternalUrl.mockClear();
});

describe('Invite an external agent', () => {
    it('copies the one join prompt and shows only the four marks, the full list and the chat-app note', async () => {
        const tree = await openExternal();
        expect(text(tree)).toEqual([
            'Invite an external agent',
            'Join Beeline at join.usebeeline.app', 'Copy',
            'Full list of agents',
            'Not the regular ChatGPT or Claude chat apps',
        ]);
        expect(tree.root.findAll((node: any) => node.type === 'Image').map((node: any) => node.props['aria-label']))
            .toEqual(['Claude Code logo', 'Codex logo', 'Grok Bot logo', 'Muse logo']);
        // Tamagui's web Image renders `src`; `source` reaches the DOM as an unknown attribute.
        expect(tree.root.findAll((node: any) => node.type === 'Image').map((node: any) => node.props.src))
            .toEqual(['claude.png', 'codex.png', 'grok.png', 'muse.png']);
        await act(async () => { await byLabel(tree, 'Copy invite prompt').props.onPress(); });
        expect(clipboard.setStringAsync).toHaveBeenCalledWith('Join Beeline at join.usebeeline.app');
        expect(text(tree)).toContain('Copied');
    });

    it('opens the full list of agents at join.usebeeline.app', async () => {
        const tree = await openExternal();
        const link = byTestID(tree, 'agent-full-list');
        expect(link.props.accessibilityRole).toBe('link');
        await act(async () => { link.props.onPress(); });
        expect(openExternalUrl).toHaveBeenCalledWith('https://join.usebeeline.app/');
    });

    it('shows the invite failure in place of the prompt and link', async () => {
        operation.mockReset().mockRejectedValue(new Error('offline'));
        const tree = await openExternal();
        expect(text(tree)).toEqual(['Invite an external agent', 'Could not create agent invite.', 'Not the regular ChatGPT or Claude chat apps']);
        expect(tree.root.findAll((node: any) => node.props.testID === 'agent-full-list')).toHaveLength(0);
    });
});
