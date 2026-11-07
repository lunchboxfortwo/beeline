import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { RoomViewMember } from '@beeline/api-contract/phone';
const open = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: open }));
vi.mock('./IndexRow', () => ({ IndexRow: 'IndexRow' }));
import { AgentDeliveryStatus } from './AgentDeliveryStatus';
const member = (
  offline: boolean,
  state: NonNullable<RoomViewMember['delivery']>['state'] = 'setup_unfinished',
): RoomViewMember => ({
  identity: { pubkey: 'member', kind: 'agent', name: 'Codex' },
  role: 'member',
  delivery: { state, offline, reconnectUrl: 'https://join.usebeeline.app' },
});
it('shows only the server-proved offline fact and restarts joining with one shared IndexRow', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let tree: any;
  try {
    await act(async () => {
      tree = create(<AgentDeliveryStatus members={[member(false)]} />);
    });
    expect(tree.toJSON()).toBeNull();
    await act(async () => tree.update(<AgentDeliveryStatus members={[member(true, 'failed')]} />));
    const row = tree.root.findByType('IndexRow');
    expect(row.props.title).toBe('Codex is offline');
    expect(row.props.action).toBe('Connect again');
    expect(row.props.description).toBeUndefined();
    await act(async () => row.props.onPress());
    expect(open).toHaveBeenCalledWith('https://join.usebeeline.app');
    await act(async () =>
      tree.update(<AgentDeliveryStatus members={[member(false, 'host_without_live_delivery')]} />),
    );
    expect(tree.toJSON()).toBeNull();
    await act(async () =>
      tree.update(<AgentDeliveryStatus members={[member(false, 'proved_ready')]} />),
    );
    expect(tree.toJSON()).toBeNull();
  } finally {
    if (tree) await act(async () => tree.unmount());
  }
});
