import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ useWindowDimensions: () => ({ height: 844, width: 390 }), Share: { share: vi.fn(async () => ({ action: 'sharedAction' })), sharedAction: 'sharedAction' } }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: (props: Record<string, unknown>) => React.createElement('IdentityMark', props) }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ relayUrl: 'https://usebeeline.app' }) }));
const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('expo-clipboard', () => clipboard);
const operation = vi.hoisted(() => vi.fn());
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: operation }));

import { Share } from 'react-native';
import { InvitePeopleSheet } from './InvitePeopleSheet';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const TOKEN = `inv_${'ab'.repeat(32)}`;

const text = (tree: any) => tree.root.findAll((node: any) => node.type === 'Text').map((node: any) => node.props.children);
const byTestID = (tree: any, testID: string) => tree.root.find((node: any) => node.props.testID === testID && typeof node.type === 'string');

async function open(props: Partial<React.ComponentProps<typeof InvitePeopleSheet>> = {}) {
    let tree: any;
    await act(async () => {
        tree = create(<InvitePeopleSheet open close={vi.fn()} workspaceId={WORKSPACE} workspaceName="Beeline Work" {...props} />);
    });
    return tree;
}

beforeEach(() => {
    operation.mockReset();
    clipboard.setStringAsync.mockClear();
});

describe('Invite people', () => {
    it('mints one invite link and copies it; the line says where it leads', async () => {
        operation.mockResolvedValueOnce({ token: TOKEN, expiresAt: 0 });
        const tree = await open({ roomId: ROOM, roomTag: '#beeline' });
        expect(operation).toHaveBeenCalledWith('createInvite', { workspaceId: WORKSPACE });
        const link = `https://usebeeline.app/join/${encodeURIComponent(TOKEN)}`;
        expect(text(tree)).toContain('joins Beeline Work and #beeline');
        expect(text(tree)).toContain('Copy link');
        expect(text(tree)).not.toContain(link);
        const share = vi.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
        await act(async () => { await byTestID(tree, 'invite-share-link').props.onPress(); });
        expect(share).toHaveBeenCalledWith({ message: link });
        await act(async () => { await byTestID(tree, 'invite-copy-link').props.onPress(); });
        expect(clipboard.setStringAsync).toHaveBeenCalledWith(link);
        expect(text(tree)).toContain('Link copied');
    });

    it('opens Invite by email in place and sends through inviteByEmail', async () => {
        operation.mockResolvedValueOnce({ token: TOKEN, expiresAt: 0 }).mockResolvedValueOnce(undefined);
        const tree = await open({ roomId: ROOM, roomTag: '#beeline' });
        await act(async () => { byTestID(tree, 'invite-email').props.onPress(); });
        const input = () => byTestID(tree, 'invite-email-input');
        const send = () => tree.root.find((node: any) => node.type === 'Button' && node.props['aria-label'] === 'Send invite');
        expect(send().props.disabled).toBe(true);
        await act(async () => { input().props.onChangeText('kai@example.com'); });
        expect(send().props.disabled).toBe(false);
        await act(async () => { await send().props.onPress(); });
        expect(operation).toHaveBeenLastCalledWith('inviteByEmail', { workspaceId: WORKSPACE, email: 'kai@example.com', roomId: ROOM });
        expect(text(tree)).toContain('Invite sent to kai@example.com.');
        expect(input().props.value).toBe('');
    });

    it("shows the server's human refusal when the email cannot be sent", async () => {
        operation.mockResolvedValueOnce({ token: TOKEN, expiresAt: 0 })
            .mockRejectedValueOnce(Object.assign(new Error('Invite by email is not set up on this server.'), { status: 409 }));
        const tree = await open();
        await act(async () => { byTestID(tree, 'invite-email').props.onPress(); });
        await act(async () => { byTestID(tree, 'invite-email-input').props.onChangeText('kai@example.com'); });
        await act(async () => {
            await tree.root.find((node: any) => node.type === 'Button' && node.props['aria-label'] === 'Send invite').props.onPress();
        });
        expect(text(tree)).toContain('Invite by email is not set up on this server.');
        expect(text(tree)).not.toContain('Invite sent to kai@example.com.');
    });
});
