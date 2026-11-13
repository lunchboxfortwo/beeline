/** Explicit content checks: a route header or a mounted loader is never completion. */
import { fixture, workspace, viewer, agent, peer, hash, uuid } from './web-fixtures.mjs';
const room = fixture('open-room');
const corners = fixture('open-corner');
const workflow = fixture('start-workflow');
const id = (value) => `[data-testid="${value}"]`;
const content = (selector, extra = {}) => ({ selector, state: 'content', ...extra });
const text = (value, extra = {}) => ({ text: value, state: 'content', ...extra });
const deck = content(id(`room-${room.roomId}`));
const settings = content(id('sign-out-setting'));
// The Members page and the People tab both list the fixture agent as a member row.
const members = content(id(`member-${agent}`));
// Redirect cases measure their real destination and retain that fact in evidence.
export const routeFixtures = {
  '/': deck,
  '/artifact-viewer': text('latency route code', {
    params: { roomId: uuid('route-artifact-room'), messageId: hash('route-code'), blockIndex: '0' },
  }),
  '/beeline/agent-profile': content(id('agent-profile-head'), { params: { agentId: agent } }),
  '/beeline/brief': text('This thread has no brief yet', {
    params: { roomId: corners.cornerId },
    state: 'corner-without-brief',
  }),
  '/beeline/browser-share': text('This shared browser link is invalid.', { state: 'invalid-link' }),
  '/beeline/channels': deck,
  '/beeline/chat-info': content(id('chat-kind'), { params: { roomId: room.roomId } }),
  '/beeline/chat/[channelId]': text(room.text),
  '/beeline/community': content(id('choice-join-input'), { params: { mode: 'join' } }),
  '/beeline/corners/[roomId]': content(id(`thread-row-${corners.cornerId}`), {
    params: { roomId: corners.roomId },
  }),
  '/beeline/create-workspace': content(id('create-workspace-name')),
  '/beeline/github-callback': { ...deck, state: 'callback-redirect' },
  '/beeline/github-installation': text('Continue connecting GitHub', {
    params: { error: 'local-fixture' },
    state: 'connection-error',
  }),
  '/beeline/google-callback': { ...deck, state: 'callback-redirect' },
  '/beeline/human-profile': content(id('human-profile-head'), { params: { memberId: peer } }),
  '/beeline/members': { ...members, params: { roomId: room.roomId } },
  '/beeline/onboarding': { ...deck, state: 'signed-in-redirect' },
  '/beeline/people': members,
  '/beeline/settings': settings,
  '/beeline/settings/identity': settings,
  '/beeline/settings/schedule': content(id('schedule-gone'), { state: 'stopped-schedule' }),
  '/beeline/settings/schedules': content(id('scheduled-work-empty'), { state: 'empty-list' }),
  '/beeline/settings/subscription': content(id('subscription-gone'), {
    state: 'stopped-subscription',
  }),
  '/beeline/settings/workbench': content(id('connectors-search')),
  '/beeline/settings/workbench/app': text('Signed in', {
    params: { appId: uuid('route-app') },
    state: 'local-app-metadata',
  }),
  '/beeline/settings/workbench/connect': content(id('connect-no-helper-empty'), {
    state: 'no-helper',
  }),
  '/beeline/settings/workbench/connect-app': content(id('connect-app-input')),
  '/beeline/settings/workbench/connect-signin': content(id('signin-oauth-browser'), {
    params: { method: 'oauth', url: 'http://127.0.0.1/unused-provider' },
    state: 'provider-consent-prompt',
  }),
  '/beeline/settings/workbench/connection': content(id('connection-detail-identity'), {
    params: { connectionId: uuid('route-key') },
    state: 'local-key-metadata',
  }),
  '/beeline/settings/workbench/service': text('This company is no longer connected.', {
    state: 'unavailable-company',
  }),
  '/beeline/settings/workbench/wallet': content(id('wallet-connect-row'), {
    state: 'local-wallet-read-fixture',
  }),
  '/beeline/settings/workbench/wallet-receive': content(id('wallet-receive-solana'), {
    state: 'unconnected-wallet',
  }),
  '/beeline/settings/workbench/wallet-send': content(id('wallet-send-screen'), {
    state: 'unconnected-wallet',
  }),
  '/beeline/settings/workbench/wallet-service': content(id('wallet-connect-row'), {
    state: 'wallet-redirect-local-read-fixture',
  }),
  '/beeline/settings/workflows': text('No dispatchable workflows in this chat.', {
    state: 'empty-workflows',
  }),
  '/beeline/settings/workspace': content(id('workspace-name-row'), {
    state: 'workspace-settings-redirect',
  }),
  '/beeline/tray': content(id('tray-list'), { absent: id('tray-loader') }),
  '/beeline/workflow': content(id('workflow-steps'), {
    params: { roomId: workflow.roomId, name: 'latency-start-workflow' },
  }),
  '/beeline/workflow-run': text('workflow run not found', {
    state: 'unavailable-run',
    params: { runId: 'local-missing-run' },
  }),
  '/buzz/github-callback': { ...deck, state: 'legacy-callback-redirect' },
  '/buzz/github-installation': text('Continue connecting GitHub', {
    params: { error: 'local-fixture' },
    state: 'legacy-connection-error',
  }),
  '/changelog': text('RELEASE LEDGER'),
  '/join/[token]': content(id('invite-unavailable'), { state: 'invalid-invite' }),
  '/review/[secret]': { ...deck, state: 'review-signin-redirect' },
  '/settings': { ...settings, state: 'settings-redirect' },
  '/text-selection': text('Text not found or expired', {
    state: 'expired-selection',
    params: { textId: 'local-expired-selection' },
  }),
};
// These routes finish on the default review workspace. Its empty chats say
// "No messages yet"; the fixture room is not in that workspace.
for (const path of [
  '/beeline/github-callback',
  '/beeline/google-callback',
  '/beeline/onboarding',
  '/buzz/github-callback',
  '/review/[secret]',
]) {
  routeFixtures[path] = text('No messages yet', {
    state: `${routeFixtures[path].state}-default-review-workspace`,
  });
}
export function routeFixture(path, secret) {
  const config = routeFixtures[path];
  if (!config) throw new Error(`No web route fixture: ${path}`);
  const params = new URLSearchParams({
    communityId: workspace,
    workspaceId: workspace,
    viewerId: viewer,
    roomId: room.roomId,
    ...config.params,
  });
  const pathname = path
    .replace('[channelId]', room.roomId)
    .replace('[roomId]', corners.roomId)
    .replace('[token]', 'local-invalid-invite')
    .replace('[secret]', secret);
  return { ...config, path, url: `${pathname}?${params}` };
}
export async function waitForRouteContent(page, config) {
  const target = config.selector
    ? page.locator(config.selector)
    : page.getByText(config.text, { exact: true });
  await target.filter({ visible: true }).first().waitFor();
  if (config.absent) await page.locator(config.absent).waitFor({ state: 'hidden' });
}
