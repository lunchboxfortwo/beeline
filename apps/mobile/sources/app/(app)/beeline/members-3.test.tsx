import { WORKSPACE, VIEWER, OWNER, MEMBER, AGENT, state, liveListeners, roomView, phoneOperation, member, baseWorkspace, baseAgent, render, press, agentChanged, openAgentProfile, openAgentManagement, fixtureScope1 } from "../../../test/fixtures/members.test-support";
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act } from 'react-test-renderer';
import { expect, it } from 'vitest';

it('refreshes an open profile from its plain read after a usage change', async () => {
  const renderer = await render(); await openAgentProfile(renderer);
  const before = roomView.agent.mock.calls.length;
  await act(async () => { for (const listener of liveListeners) listener({ monolithLive: {
    type: 'resource-change', roomId: '', resource: 'agent', resourceId: AGENT, usageOnly: true,
  } }); });
  expect(roomView.agent.mock.calls.length).toBe(before + 1);
  await agentChanged(); expect(roomView.agent.mock.calls.length).toBe(before + 2);
});


it('the existing Refresh usage action does not follow its receipt with a full Agent read', async () => {
  state.agent.usage = { updatedAt: 10, windows: [{ rateLimitType: 'five_hour', status: 'allowed', utilization: 0.14, updatedAt: 10 }] };
  const renderer = await render(); await openAgentProfile(renderer);
  const before = roomView.agent.mock.calls.length; phoneOperation.mockResolvedValueOnce({ status: 'fresh' });
  const refresh = renderer.root.findAllByType('Button' as any).find((node: any) => node.props.accessibilityLabel === 'Refresh usage');
  expect(refresh).toBeDefined();
  await act(async () => { await refresh!.props.onPress(); });
  expect(phoneOperation).toHaveBeenCalledWith('refreshAgentUsage', { workspaceId: WORKSPACE, agentId: AGENT }, expect.any(Object));
  expect(roomView.agent.mock.calls.length).toBe(before);
});
