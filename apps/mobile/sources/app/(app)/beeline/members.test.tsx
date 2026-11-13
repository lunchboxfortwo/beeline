import { WORKSPACE, VIEWER, OWNER, MEMBER, AGENT, state, roomView, share, modal, platform, client, phoneOperation, safeArea, chevronDirections, baseWorkspace, baseAgent, create, render, press, agentChanged, openAgentProfile, openAgentManagement, fixtureScope1 } from "../../../test/fixtures/members.test-support";
import { HumanProfile } from './human-profile';
import AgentProfileRoute from './agent-profile';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';




it('does not expose wake setup when the server omits owner-only wake configuration', async () => {
  const renderer = await render();
  await openAgentProfile(renderer);
  expect(renderer.root.findAll((node: any) => node.props.title === 'Webhook URL')).toHaveLength(0);
});
describe('Members workspace management', () => {
const scope1 = fixtureScope1();





  it('opens a human profile on Android when window has no browser event API', async () => {
    platform.OS = 'android';
    vi.stubGlobal('window', {});
    try {
      const renderer = await scope1.personProfile();
      expect(renderer.root.findByProps({ testID: 'human-profile' })).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });


  it('opens an agent profile on Android when window has no browser event API', async () => {
    platform.OS = 'android';
    vi.stubGlobal('window', {});
    try {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<AgentProfileRoute />);
      });
      expect(renderer.root.findByProps({ testID: 'agent-profile' })).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });



  it('saves role edits from the human profile and supports cancel', async () => {
    const renderer = await scope1.personProfile();
    expect(roomView.workspace).not.toHaveBeenCalled(); // R12c
    await press(renderer, 'edit-person-role');
    await press(renderer, 'person-role-admin');
    expect(phoneOperation).not.toHaveBeenCalled();
    await press(renderer, 'save-person-role');
    expect(phoneOperation).toHaveBeenCalledWith('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: MEMBER,
      role: 'admin',
    });
    expect(renderer.root.findAllByProps({ testID: 'person-role-editor' })).toHaveLength(0);
  });






  it('keeps peers and owners outside admin role edit authority', async () => {
    state.workspace = baseWorkspace('admin');
    let renderer = await scope1.personProfile(OWNER);
    expect(renderer.root.findAllByProps({ testID: 'edit-person-role' })).toHaveLength(0);
    state.workspace.members = state.workspace.members.map((m: any) =>
      m.identity.pubkey === MEMBER ? { ...m, role: 'admin' } : m,
    );
    renderer = await scope1.personProfile();
    expect(renderer.root.findAllByProps({ testID: 'edit-person-role' })).toHaveLength(0);
  });


  it('lists members without any Banned members roster (banning UI removed)', async () => {
    const renderer = await render();
    // No "Banned members" disclosure, no lift controls, no ban operation call.
    expect(renderer.root.findAllByProps({ title: 'Banned members' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'workspace-bans' })).toHaveLength(0);
    expect(phoneOperation).not.toHaveBeenCalledWith('listWorkspaceBans', expect.anything());
  });


  it('offers role edits without any ban control (banning UI removed)', async () => {
    const renderer = await scope1.personProfile();
    expect(renderer.root.findAllByProps({ testID: 'ban-person' })).toHaveLength(0);
    await press(renderer, 'edit-person-role');
    // Edit mode still renders Save; the Ban from Workspace row is gone.
    expect(renderer.root.findByProps({ testID: 'save-person-role' })).toBeDefined();
    expect(renderer.root.findAllByProps({ testID: 'ban-person' })).toHaveLength(0);
    expect(phoneOperation).not.toHaveBeenCalledWith('banWorkspaceMember', expect.anything());
  });



  it('skips the remove control when the viewer declines the confirm dialog', async () => {
    modal.confirm.mockResolvedValueOnce(false);
    const renderer = await scope1.personProfile();
    await press(renderer, 'edit-person-role');
    await press(renderer, 'remove-person');
    expect(phoneOperation).not.toHaveBeenCalledWith('removeWorkspaceMember', expect.anything());
  });


  it('lets members view a human profile and message without management powers', async () => {
    state.workspace.viewer = {
      ...state.workspace.viewer,
      role: 'member',
      permissions: { send: true, manage: false },
    };
    const renderer = await scope1.personProfile();
    expect(renderer.root.findAllByProps({ testID: 'edit-person-role' })).toHaveLength(0);
    phoneOperation.mockResolvedValueOnce({ id: 'dm-room' });
    await press(renderer, 'human-profile-message');
    expect(phoneOperation).toHaveBeenCalledWith('resolveDirectMessage', {
      workspaceId: WORKSPACE,
      participantId: MEMBER,
    });
  });


  it('keeps human profile mutation failures visible for retry', async () => {
    const renderer = await scope1.personProfile();
    phoneOperation.mockRejectedValueOnce(new Error('network unavailable'));
    await press(renderer, 'human-profile-message');
    expect(
      renderer.root
        .findAllByType('Text' as any)
        .some((node: any) => String(node.props.children).includes('Could not complete request')),
    ).toBe(true);
  });








});
