import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('@/components/buzz/RepositoryMark', () => ({ RepositoryMark: (props: any) => React.createElement('RepositoryMark', props) }));
vi.mock('tamagui', async () => {
    const hosts = (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts();
    const R = await import('react');
    // The shared hosts have no Switch.Thumb; add it here.
    const Switch = Object.assign((props: any) => R.createElement('Switch', props, props.children),
        { Thumb: (props: any) => R.createElement('Switch.Thumb', props) });
    return { ...hosts, Switch };
});
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/buzz/latency-route-hook', () => ({ useLatencyRouteFrame: () => undefined }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('expo-router', () => ({ router }));
const panel = vi.hoisted(() => ({ openPlace: vi.fn(), closePanel: vi.fn() }));
vi.mock('@/ui/shell/panel', () => panel);
const operation = vi.hoisted(() => vi.fn());
const infoReads = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: operation }));
const leave = vi.hoisted(() => vi.fn(async (_title: string, _deletes: boolean, run: (confirm: boolean) => Promise<unknown>) => { await run(false); return true; }));
vi.mock('@/buzz/room-leave', () => ({ leaveRoomWithConfirmation: leave }));
const modal = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock('@/modal', () => ({ Modal: modal }));
vi.mock('@/buzz/corner-navigation', () => ({ cornerHref: (id: string, parent: string, title: string) => ({ pathname: 'corner', params: { id, parent, title } }) }));
vi.mock('@/components/buzz/RepoList', () => ({ RepoList: (props: any) => React.createElement('RepoList', props) }));
const data = vi.hoisted(() => ({ room: null as any, archived: [] as any[], openCorners: 0, total: 27 }));
vi.mock('@/ui/screens/members/use-room-view', () => ({ useRoomView: () => { infoReads(); return { room: data.room, error: null, refresh }; } }));
vi.mock('@/ui/screens/people/use-workspace-roster', () => ({ useWorkspaceRoster: () => ({ surface: { workspace: { name: 'Beeline Work' } } }) }));
vi.mock('@/buzz/scheduled-work', () => ({
    useScheduledWork: () => ({ work: null }),
    scheduleTitle: () => '', scheduleTrigger: () => '', subscriptionTitle: () => '', subscriptionWhen: () => '',
}));
const loadArchived = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/buzz/use-room-corners', () => ({ useRoomCorners: () => ({ record: { archived: { corners: data.archived, total: data.total }, summary: { cornerCount: data.openCorners } }, loadArchived }) }));

import { ChatInfoScreen } from './ChatInfoScreen';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOM = '22222222-2222-4222-8222-222222222222';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CORNER = '33333333-3333-4333-8333-333333333333';
const flat = (tree: any) => tree.root.findAll((node: any) => node.type === 'Text').map((node: any) => node.props.children)
    .flat(3).filter((value: unknown) => typeof value === 'string').join('|');
const control = (tree: any, id: string) => tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === id);
const pressable = (tree: any, testID: string) => tree.root.find((node: any) => node.type === 'ListItem' && node.props.testID === testID);

function render() {
    let tree: any;
    act(() => { tree = create(<ChatInfoScreen roomId={ROOM} close={vi.fn()} />); });
    return tree;
}

beforeEach(() => {
    vi.clearAllMocks();
    operation.mockReset().mockResolvedValue(undefined);
    modal.confirm.mockResolvedValue(true);
    data.openCorners = 0;
    refresh.mockImplementation(async () => {
        const [name, input] = operation.mock.calls.at(-1) ?? [];
        if (name === 'updateRoom') data.room = { ...data.room, room: { ...data.room.room, name: input.name } };
        if (name === 'setRoomRepository') data.room = { ...data.room, repository: input };
        if (name === 'removeRoomRepository') data.room = { ...data.room, repository: undefined };
    });
    data.room = {
        room: { id: ROOM, workspaceId: WORKSPACE, name: 'beeline', visibility: 'public' },
        members: [{ identity: { pubkey: 'a', kind: 'human', name: 'a' }, role: 'owner' }, { identity: { pubkey: 'b', kind: 'agent', name: 'b' }, role: 'member' }],
        viewer: { identity: { kind: 'human', pubkey: 'a' }, permissions: { manage: true, send: true } },
    };
    data.archived = [{ corner: { id: CORNER, name: 'agent-identity-tiles' }, closedAt: undefined }];
});

describe('Chat info', () => {
    it('says public or private, counts members and opens Members', () => {
        const tree = render();
        expect(flat(tree)).toContain('Public · anyone in Beeline Work can join · 2 members');
        act(() => { pressable(tree, 'chat-members').props.onPress(); });
        expect(panel.openPlace).toHaveBeenCalledWith({ kind: 'members', roomId: ROOM }, false);
    });

    it('renames a chat from Chat info with the existing update operation', async () => {
        const tree = render();
        act(() => pressable(tree, 'chat-name').props.onPress());
        act(() => control(tree, 'chat-name-input').props.onChangeText('new room'));
        await act(async () => control(tree, 'chat-name-save').props.onPress());
        expect(operation).toHaveBeenCalledWith('updateRoom', { roomId: ROOM, name: 'new-room' });
        expect(refresh).toHaveBeenCalled();
        expect(flat(tree)).toContain('#new-room');
        expect(tree.root.findAll((node: any) => node.props.testID === 'chat-name-input')).toHaveLength(0);
    });

    it('links a repository from Chat info with the existing repository operation', async () => {
        operation.mockResolvedValueOnce({ installations: [], repositories: [{ id: 9, fullName: 'owner/repo', installationId: 77, defaultBranch: 'develop', private: true }] });
        const tree = render();
        await act(async () => pressable(tree, 'chat-repository').props.onPress());
        expect(operation).toHaveBeenCalledWith('listGitHubRepositories', { refresh: true });
        expect(operation).toHaveBeenCalledWith('listGitHubRepositories', { refresh: false });
        const list = tree.root.findByType('RepoList');
        expect(tree.root.findAllByProps({ testID: 'chat-repository-pill' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'chat-repository-none' })).toHaveLength(0);
        act(() => list.props.onSelect(list.props.getCandidate(list.props.candidates[0])));
        expect(control(tree, 'chat-repository-pill')).toBeDefined();
        await act(async () => control(tree, 'chat-repository-save').props.onPress());
        expect(operation).toHaveBeenCalledWith('setRoomRepository', {
            roomId: ROOM, key: 'github:9', name: 'owner/repo', remote: 'git://github.com/owner/repo', targetBranch: 'develop', githubInstallationId: 77,
        });
        expect(refresh).toHaveBeenCalled();
        expect(flat(tree)).toContain('owner/repo');
    });

    it.each([1, 1000])('CHAT-REPO-1: opens and selects without rerendering Chat info or mapping %i repositories', async (count) => {
        let resolve!: (result: unknown) => void;
        operation.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
        const tree = render();
        infoReads.mockClear();
        act(() => pressable(tree, 'chat-repository').props.onPress());
        expect(tree.root.findAllByType('Sheet')[0].props.open).toBe(true);
        expect(infoReads).not.toHaveBeenCalled();
        expect(tree.root.findByType('RepoList').props.loading).toBe(true);
        const nameRead = vi.fn(() => 'owner/repo');
        const repositories = Array.from({ length: count }, (_, index) => ({
            id: index + 9, get fullName() { return nameRead(); }, installationId: 77, defaultBranch: 'main',
        }));
        await act(async () => resolve({ repositories }));
        // The list owns individual row conversion; loading a response must not
        // visit every repository before the picker can draw its first window.
        expect(nameRead).not.toHaveBeenCalled();
        const list = tree.root.findByType('RepoList');
        act(() => list.props.onSelect(list.props.getCandidate(list.props.candidates[0])));
        expect(infoReads).not.toHaveBeenCalled();
        act(() => tree.root.findAllByType('Button').find((node: any) => node.props['aria-label'] === 'Cancel').props.onPress());
        expect(tree.root.findAllByType('Sheet')[0].props.open).toBe(false);
        expect(infoReads).not.toHaveBeenCalled();
    });

    it.each(['success', 'failure'] as const)('shows the stored catalog while refreshing on each opening, then handles GitHub %s', async outcome => {
        const cached = { repositories: [{ id: 1373962491, fullName: 'bananaman614305/milo', installationId: 77, defaultBranch: 'main' }] };
        const fresh = { repositories: [{ ...cached.repositories[0], fullName: 'bananaman614305/grunt' }] };
        let resolve!: (value: typeof fresh) => void;
        let reject!: (error: Error) => void;
        operation.mockImplementation((_name, input) => input.refresh
            ? new Promise((yes, no) => { resolve = yes; reject = no; }) : Promise.resolve(cached));
        const tree = render();
        infoReads.mockClear();
        await act(async () => pressable(tree, 'chat-repository').props.onPress());
        expect(tree.root.findByType('RepoList').props.candidates).toEqual(cached.repositories);
        expect(tree.root.findByType('RepoList').props.loading).toBe(true);
        await act(async () => { if (outcome === 'success') resolve(fresh); else reject(new Error('GitHub unavailable')); });
        expect(tree.root.findByType('RepoList').props.candidates).toEqual(outcome === 'success' ? fresh.repositories : cached.repositories);
        expect(flat(tree)).not.toContain('Could not load repos');
        expect(infoReads).not.toHaveBeenCalled();
        act(() => tree.root.findAllByType('Button').find((node: any) => node.props['aria-label'] === 'Cancel').props.onPress());
        await act(async () => pressable(tree, 'chat-repository').props.onPress());
        expect(operation.mock.calls.filter(([, input]) => input.refresh === true)).toHaveLength(2);
        await act(async () => resolve(fresh));
        act(() => tree.unmount());
    });

    it('keeps a fast fresh picker result when the stored catalog arrives later', async () => {
        let cached!: (value: unknown) => void;
        const repositories = [{ id: 1373962491, fullName: 'bananaman614305/grunt', installationId: 77, defaultBranch: 'main' }];
        operation.mockImplementation((_name, input) => input.refresh
            ? Promise.resolve({ repositories }) : new Promise(resolve => { cached = resolve; }));
        const tree = render();
        await act(async () => pressable(tree, 'chat-repository').props.onPress());
        expect(tree.root.findByType('RepoList').props.candidates).toEqual(repositories);
        await act(async () => cached({ repositories: [{ ...repositories[0], fullName: 'bananaman614305/milo' }] }));
        expect(tree.root.findByType('RepoList').props.candidates).toEqual(repositories);
        act(() => tree.unmount());
    });

    it.each([
        ['human', true, true, true],
        ['human', false, false, false],
        ['agent', true, false, true],
    ] as const)('keeps existing edit permissions for %s with manage=%s', (kind, manage, rename, repository) => {
        data.room.viewer = { ...data.room.viewer, identity: { kind }, permissions: { manage, send: true } };
        const tree = render();
        expect(typeof control(tree, 'chat-name').props.onPress === 'function').toBe(rename);
        expect(typeof control(tree, 'chat-repository').props.onPress === 'function').toBe(repository);
    });

    it('validates a name and preserves the editor on a refused rename', async () => {
        const tree = render();
        act(() => pressable(tree, 'chat-name').props.onPress());
        act(() => control(tree, 'chat-name-input').props.onChangeText('Invalid!'));
        expect(control(tree, 'chat-name-save').props.disabled).toBe(true);
        await act(async () => control(tree, 'chat-name-save').props.onPress());
        expect(operation).not.toHaveBeenCalled();
        act(() => control(tree, 'chat-name-input').props.onChangeText('new-name'));
        operation.mockRejectedValueOnce(Object.assign(new Error('You no longer manage this Workspace.'), { status: 403 }));
        await act(async () => control(tree, 'chat-name-save').props.onPress());
        expect(flat(tree)).toContain('You no longer manage this Workspace.');
        expect(control(tree, 'chat-name-input').props.value).toBe('new-name');
        expect(refresh).not.toHaveBeenCalled();
    });

    it('does not replace a repository with open threads when the existing confirmation is declined', async () => {
        data.room.repository = { key: 'github:8', name: 'owner/old', remote: 'git://github.com/owner/old', targetBranch: 'main' };
        data.openCorners = 2;
        modal.confirm.mockResolvedValueOnce(false);
        operation.mockResolvedValueOnce({ installations: [], repositories: [{ id: 9, fullName: 'owner/new', installationId: 77, defaultBranch: 'main' }] });
        const tree = render();
        await act(async () => pressable(tree, 'chat-repository').props.onPress());
        const list = tree.root.findByType('RepoList');
        act(() => list.props.onSelect(list.props.getCandidate(list.props.candidates[0])));
        await act(async () => control(tree, 'chat-repository-save').props.onPress());
        expect(modal.confirm).toHaveBeenCalledWith('Change chat repo?', expect.stringContaining('owner/old'), expect.objectContaining({ confirmText: 'Change anyway' }));
        expect(operation.mock.calls.map(call => call[0])).toEqual(['listGitHubRepositories', 'listGitHubRepositories']);
        expect(refresh).not.toHaveBeenCalled();
    });

    it('unlinks the current repository after confirmation using the existing remove operation', async () => {
        data.room.repository = { key: 'github:8', name: 'owner/old', remote: 'git://github.com/owner/old', targetBranch: 'main' };
        operation.mockResolvedValueOnce({ installations: [], repositories: [] });
        const tree = render();
        await act(async () => pressable(tree, 'chat-repository').props.onPress());
        expect(control(tree, 'chat-repository-save').props.disabled).toBe(true);
        expect(flat(tree)).toContain('owner/old');
        act(() => control(tree, 'chat-repository-clear').props.onPress());
        expect(tree.root.findAllByProps({ testID: 'chat-repository-pill' })).toHaveLength(0);
        expect(control(tree, 'chat-repository-save').props.disabled).toBe(false);
        expect(operation.mock.calls.map(call => call[0])).toEqual(['listGitHubRepositories', 'listGitHubRepositories']);
        await act(async () => control(tree, 'chat-repository-save').props.onPress());
        expect(modal.confirm).toHaveBeenCalledWith('Unlink owner/old?', expect.stringContaining('chat-only'), expect.objectContaining({ destructive: true }));
        expect(operation).toHaveBeenCalledWith('removeRoomRepository', { roomId: ROOM });
        expect(refresh).toHaveBeenCalled();
    });

    it('does not write if edit permission disappears while the repository picker is open', async () => {
        operation.mockResolvedValueOnce({ installations: [], repositories: [{ id: 9, fullName: 'owner/new', installationId: 77, defaultBranch: 'main' }] });
        const tree = render();
        await act(async () => pressable(tree, 'chat-repository').props.onPress());
        const list = tree.root.findByType('RepoList');
        act(() => list.props.onSelect(list.props.getCandidate(list.props.candidates[0])));
        data.room.viewer.permissions.manage = false;
        act(() => tree.update(<ChatInfoScreen roomId={ROOM} close={vi.fn()} />));
        await act(async () => control(tree, 'chat-repository-save').props.onPress());
        expect(operation.mock.calls.map(call => call[0])).toEqual(['listGitHubRepositories', 'listGitHubRepositories']);
    });

    it('lists finished threads (read on open) and opens one', () => {
        const tree = render();
        expect(loadArchived).toHaveBeenCalledWith(false);
        expect(flat(tree)).toContain('Finished threads · 27');
        act(() => { pressable(tree, `finished-${CORNER}`).props.onPress(); });
        expect(router.push).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ id: CORNER, parent: ROOM }) }));
    });

    it("leaves with today's confirmation and returns to Chats", async () => {
        const tree = render();
        await act(async () => { await pressable(tree, 'leave-chat').props.onPress(); });
        expect(leave).toHaveBeenCalledTimes(1);
        expect(operation).toHaveBeenCalledWith('leaveRoom', { roomId: ROOM });
        expect(router.replace).toHaveBeenCalledWith({ pathname: '/beeline/channels', params: { communityId: WORKSPACE } });
    });

    it('deletes only with manage authority, after confirming', async () => {
        let tree = render();
        await act(async () => { await pressable(tree, 'delete-chat').props.onPress(); });
        expect(modal.confirm).toHaveBeenCalledTimes(1);
        expect(operation).toHaveBeenCalledWith('deleteRoom', { roomId: ROOM });
        data.room = { ...data.room, viewer: { permissions: { manage: false, send: true } } };
        tree = render();
        expect(tree.root.findAll((node: any) => node.type === 'ListItem' && node.props.testID === 'delete-chat')).toHaveLength(0);
    });

    it('has no Workflows section', () => {
        expect(flat(render())).not.toMatch(/Workflows/);
    });
});
