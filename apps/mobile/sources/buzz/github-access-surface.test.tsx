import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BuzzRigTransport } from '@/sync/transport';
const reset = vi.hoisted(() => ({ generation: 0 }));

vi.mock('./surface-storage', async () => {
  const { SurfaceResponseCache } = await import('@beeline/buzz-client');
  const { SurfaceRegistry } = await import('./surface-registry');
  return {
    mobileSurfaceCache: new SurfaceRegistry(new SurfaceResponseCache({ get: async () => null, set: async () => {}, remove: async () => {} })),
    surfaceAddress: (relayOrigin: string, viewerPubkey: string, endpoint: string) => ({ relayOrigin, viewerPubkey, endpoint }),
  };
});
vi.mock('./use-shared-surface', () => ({
  useSurfaceSnapshot: (address: any, guard: any) => React.useSyncExternalStore(
    listener => mobileSurfaceCache.subscribe(address, listener),
    () => mobileSurfaceCache.peek(address, guard)),
}));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ register: async () => () => {} }) }));
vi.mock('@/sync/client-reset', () => ({ clientResetGeneration: () => reset.generation, subscribeClientReset: () => () => {} }));
vi.mock('react-native', () => ({ VirtualizedList: ({ data, getItem, getItemCount, renderItem }: any) =>
  React.createElement('List', {}, Array.from({ length: getItemCount(data) }, (_, index) => {
    const item = getItem(data, index);
    return React.createElement(React.Fragment, { key: item.key }, renderItem({ item, index }));
  })) }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('./use-text-draft', () => ({ useTextDraft: (_key: string, initial: string) => React.useState(initial) }));
vi.mock('@/ui/grammar', () => ({ Placeheld: (props: any) => React.createElement('Input', props) }));
vi.mock('@/components/buzz/HullDialog', () => ({ HullDialogInput: 'Input' }));
vi.mock('@/components/buzz/HullActionSheet', () => ({ HullActionSheetRow: 'Row' }));
vi.mock('@/components/buzz/RepositoryMark', () => ({ RepositoryMark: 'Mark' }));
vi.mock('@/components/buzz/EmptyState', () => ({ EmptyState: 'Empty' }));

import { mobileSurfaceCache } from './surface-storage';
import { readGitHubAccess, useGitHubAccess, writeGitHubAccess, type GitHubAccessView } from './github-access-surface';
import { RepoList } from '@/components/buzz/RepoList';
const scope = { relay: 'https://test.invalid', viewer: 'owner' };
const access = (name: string): GitHubAccessView => ({ installed: true, installations: [], githubReconnectNeeded: false,
  candidates: [{ key: 'github:1373962491', name: `bananaman614305/${name}`, remote: `git://github.com/bananaman614305/${name}` }] });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let renderer: ReactTestRenderer | undefined;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); reset.generation = 0; mobileSurfaceCache.clear(); });
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; });
function Picker() {
  const value = useGitHubAccess(scope);
  return <RepoList candidates={value?.candidates ?? []} currentKey={null} loading onSelect={() => {}}
    testIDPrefix="repos" draftContext="rename-proof" />;
}
it('shows the latest stored catalog while GitHub is pending, then updates the open search without polling', async () => {
  await writeGitHubAccess(scope, access('older-local-copy'));
  const fresh = deferred<GitHubAccessView>();
  const request = vi.fn(({ refresh }: { refresh?: boolean }) => refresh ? fresh.promise : Promise.resolve(access('milo')));
  const transport = { workspaceGitHubAccess: request } as unknown as BuzzRigTransport;
  let opening!: Promise<GitHubAccessView>;
  await act(async () => { renderer = create(<Picker />); opening = readGitHubAccess(transport, scope, true); });
  try {
    expect(renderer!.root.findByType('Row').props.label).toBe('bananaman614305/milo');
    act(() => renderer!.root.findByType('Input').props.onChangeText('grunt'));
    expect(renderer!.root.findAllByType('Row')).toHaveLength(0);
  } finally {
    await act(async () => { fresh.resolve(access('grunt')); await opening; });
  }
  expect(renderer!.root.findByType('Row').props.label).toBe('bananaman614305/grunt');
  expect(request.mock.calls.map(([input]) => input)).toEqual([{ refresh: true }, { refresh: false }]);
  await act(async () => { await readGitHubAccess(transport, scope, true); });
  expect(request.mock.calls.filter(([input]) => input.refresh)).toHaveLength(2);
});
it('leaves the latest cached list visible when the refresh fails', async () => {
  const fresh = deferred<GitHubAccessView>();
  const transport = { workspaceGitHubAccess: ({ refresh }: { refresh?: boolean }) => refresh ? fresh.promise : Promise.resolve(access('milo')) } as BuzzRigTransport;
  let opening!: Promise<GitHubAccessView>;
  await act(async () => { renderer = create(<Picker />); opening = readGitHubAccess(transport, scope, true); });
  await act(async () => { const result = expect(opening).resolves.toEqual(access('milo')); fresh.reject(new Error('GitHub unavailable')); await result; });
  expect(renderer!.root.findByType('Row').props.label).toBe('bananaman614305/milo');
});
it('shows a fast fresh response immediately and never replaces it with a late cached response', async () => {
  const cached = deferred<GitHubAccessView>();
  const transport = { workspaceGitHubAccess: ({ refresh }: { refresh?: boolean }) => refresh ? Promise.resolve(access('grunt')) : cached.promise } as BuzzRigTransport;
  await act(async () => { renderer = create(<Picker />); await readGitHubAccess(transport, scope, true); });
  expect(renderer!.root.findByType('Row').props.label).toBe('bananaman614305/grunt');
  await act(async () => { cached.resolve(access('milo')); });
  expect(renderer!.root.findByType('Row').props.label).toBe('bananaman614305/grunt');
});
it('does not restore an old account response after a client reset between the two reads', async () => {
  const cached = deferred<GitHubAccessView>();
  const fresh = deferred<GitHubAccessView>();
  const transport = { workspaceGitHubAccess: ({ refresh }: { refresh?: boolean }) => refresh ? fresh.promise : cached.promise } as BuzzRigTransport;
  const opening = readGitHubAccess(transport, scope, true);
  reset.generation++;
  mobileSurfaceCache.clear();
  const result = expect(opening).rejects.toThrow('GitHub access response was superseded');
  cached.resolve(access('milo'));
  await result;
  fresh.resolve(access('grunt'));
  await fresh.promise;
  expect(await mobileSurfaceCache.read({ relayOrigin: scope.relay, viewerPubkey: scope.viewer, endpoint: '/github/repositories' },
    (value: unknown): value is GitHubAccessView => Boolean(value))).toBeNull();
});
