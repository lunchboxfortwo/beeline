import { expect, it } from 'vitest';
import { GRANT_PUSH_ACTIONS, PUSH_ACTION_CATEGORIES } from '@beeline/api-contract/phone';
import { handleNotificationAction, type OutcomeNotification } from '../../mobile/sources/push/notification-actions.js';

it.each((['android', 'ios'] as const).flatMap(platform =>
  (['once', 'always', 'deny'] as const).map(decision => ({ platform, decision })),
))('R1: $platform replaces the request after $decision', async ({ platform, decision }) => {
  const notifications: OutcomeNotification[] = [];
  const decisions: unknown[][] = [];
  const result = await handleNotificationAction({
    actionIdentifier: GRANT_PUSH_ACTIONS[decision],
    notification: { request: { identifier: 'grant-notification', content: {
      body: 'Jellybean wants to run node scripts/live-a.mjs',
      data: { categoryId: PUSH_ACTION_CATEGORIES.grant, grantId: 'grant-1',
        agentName: 'Jellybean', grantKind: 'command', grantTarget: 'node scripts/live-a.mjs' },
    } } },
  }, {
    platform,
    decideGrant: async (...args) => { decisions.push(args); },
    sendReply: async () => { throw new Error('Unexpected reply'); },
    newMessageId: () => 'unused',
    present: async notification => { notifications.push(notification); },
    handled: { has: async () => false, add: async () => {} },
    inFlight: new Map(),
  });
  expect(result).toBe('done');
  expect(decisions).toEqual([['grant-1', decision]]);
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toMatchObject({
    identifier: platform === 'android' ? 'grant-notification' : 'grant-notification#done',
    title: 'Beeline', body: decision === 'deny' ? 'Denied' : 'Accepted', quiet: true,
  });
  expect(notifications[0].categoryIdentifier).toBeUndefined();
  expect(notifications[0].data.categoryId).toBeUndefined();
  expect(notifications[0].subtitle).toBeUndefined();
});
