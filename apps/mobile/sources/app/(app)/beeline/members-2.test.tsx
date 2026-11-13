import { WORKSPACE, VIEWER, OWNER, AGENT, state, liveListeners, roomView, modal, navigation, client, phoneOperation, chevronDirections, baseWorkspace, baseAgent, create, render, press, openAgentProfile, openAgentManagement, fixtureScope1, fixtureScope2 } from "../../../test/fixtures/members.test-support";
import * as React from 'react';
import { StyleSheet } from 'react-native';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import MembersScreen from './members';
import { router } from 'expo-router';

describe('Members workspace management', () => {
const scope1 = fixtureScope1();










  it('shows the seeded soul when its owner has not written one', async () => {
    state.agent = { ...baseAgent(), soul: undefined };
    const renderer = await render();
    await openAgentProfile(renderer);
    expect(renderer.root.findByProps({ testID: 'agent-profile-soul' }).props.children).toBe(
      state.agent.seededSoul,
    );
  });



  it('keeps profile read failures silent after a workspace refresh and recovers on reconnect', async () => {
    roomView.agent.mockRejectedValueOnce(new Error('Connection lost'));
    const renderer = await render();
    await openAgentProfile(renderer);
    expect(renderer.root.findAllByProps({ action: 'Retry' })).toHaveLength(0);
    const subscriptions = client.surfaceSubscribe.mock.calls as unknown as Array<
      [unknown, (event?: unknown) => void]
    >;
    const refresh = subscriptions.at(-1)![1];
    const readsBeforeRefresh = roomView.workspace.mock.calls.length;
    await act(async () => refresh({ monolithLive: { type: 'invalidate', roomId: '', reason: 'postgres:memberships' } }));
    expect(roomView.workspace.mock.calls.length).toBeGreaterThan(readsBeforeRefresh);
    expect(renderer.root.findAllByProps({ action: 'Retry' })).toHaveLength(0);
    await act(async () => {
      for (const listener of liveListeners) listener({ monolithLive: { type: 'invalidate', roomId: '', reason: 'reconnect' } });
    });
    expect(roomView.agent).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByProps({ testID: 'agent-profile-soul' })).toBeDefined();
  });


  it('R-USAGE-6: shows a cached profile, then reads it again from the server', async () => {
    const { mobileSurfaceCache, surfaceAddress } = await import('@/buzz/surface-storage');
    await act(async () => mobileSurfaceCache.write(
      surfaceAddress('https://relay.test', VIEWER, '/workspace/:id/agents/:agentId',
        { workspaceId: WORKSPACE, agentPubkey: AGENT }),
      { ...state.agent, soul: { ...state.agent.soul, instructions: 'Cached soul.' } },
      (value: unknown): value is typeof state.agent => Boolean(value)));
    const renderer = await render();
    await openAgentProfile(renderer);
    expect(roomView.agent).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByProps({ testID: 'agent-profile-soul' }).props.children).toBe(
      state.agent.soul.instructions,
    );
  });


  it('reconnects a failed profile read without collapsing the profile', async () => {
    roomView.agent.mockRejectedValueOnce(new Error('Connection lost'));
    const renderer = await render();
    await openAgentProfile(renderer);
    const profile = renderer.root.findByProps({ testID: 'agent-profile' });
    expect(renderer.root.findAllByProps({ action: 'Retry' })).toHaveLength(0);
    await act(async () => {
      for (const listener of liveListeners) listener({ monolithLive: { type: 'invalidate', roomId: '', reason: 'reconnect' } });
    });
    expect(renderer.root.findByProps({ testID: 'agent-profile' })).toBe(profile);
    expect(roomView.agent).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByProps({ testID: 'agent-profile-soul' })).toBeDefined();
  });







  it('saves an edited handle and shows a Workspace refusal under the handle field', async () => {
    const renderer = await render();
    await openAgentProfile(renderer);
    const first = (testID: string) => renderer.root.findAll((node: any) => node.props.testID === testID)[0];
    await act(async () => { first('edit-agent-soul').props.onPress(); });
    expect(first('agent-handle').props.value).toBe('clara');

    client.setAgentSoul.mockRejectedValueOnce(Object.assign(new Error('@goosy is already taken in this Workspace.'), { status: 409 }));
    await act(async () => { first('agent-handle').props.onChangeText('goosy'); });
    await act(async () => { await first('save-agent-soul').props.onPress(); });
    expect(first('agent-handle-error').props.children).toBe('@goosy is already taken in this Workspace.');
    expect(first('agent-handle').props.value).toBe('goosy');

    await act(async () => { first('agent-handle').props.onChangeText('code_bot'); });
    await act(async () => { await first('save-agent-soul').props.onPress(); });
    expect(client.setAgentSoul).toHaveBeenLastCalledWith(WORKSPACE, AGENT, expect.objectContaining({ handle: 'code_bot' }));
    expect(first('agent-handle-error')).toBeUndefined();
    expect(first('agent-handle')).toBeUndefined();
    expect(first('agent-profile-head').props.title).toBe('@code_bot');
  });

  it("hides another owner's agent configuration from a plain member", async () => {
    state.workspace = {
      ...baseWorkspace(),
      viewer: {
        ...baseWorkspace().viewer,
        role: 'member',
        permissions: { send: true, manage: false },
      },
    };
    state.agent = {
      ...baseAgent(),
      access: {
        policy: 'creator',
        owner: { id: OWNER, name: 'Captain', handle: 'lunchboxfortwo' },
        canChange: false,
      },
    };
    const renderer = await render();
    // A plain member cannot open the detail panel at all: the row is inert.
    expect(renderer.root.findAllByProps({ testID: `agent-${AGENT}-model-config` })).toHaveLength(0);

    expect(renderer.root.findAllByProps({ testID: 'agent-access-switch' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'edit-agent-soul' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'model-axis-model' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'remove-agent' })).toHaveLength(0);
  });





  it("hides another owner's yolo setting from a plain member", async () => {
    state.workspace = {
      ...baseWorkspace(),
      viewer: {
        ...baseWorkspace().viewer,
        role: 'member',
        permissions: { send: true, manage: false },
      },
    };
    state.agent = {
      ...baseAgent(),
      access: {
        policy: 'creator',
        owner: { id: OWNER, name: 'Captain', handle: 'lunchboxfortwo' },
        canChange: false,
      },
      yolo: { enabled: true, canChange: false, setBy: { name: 'Captain' }, setAt: 1_756_684_800 },
    };
    const renderer = await render();
    // A plain member cannot open the detail panel at all: the row is inert.
    expect(renderer.root.findAllByProps({ testID: `agent-${AGENT}-model-config` })).toHaveLength(0);

    expect(renderer.root.findAllByProps({ testID: 'agent-yolo-switch' })).toHaveLength(0);
  });




});
