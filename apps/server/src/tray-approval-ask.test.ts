import { expect, it } from 'vitest';
import { approvalAsk } from './tray-approval-ask.js';

it.each([
  ['choice', { ask: 'Ship the OTA tonight?', prompt: 'Full choice prompt' }, 'Ship the OTA tonight?'],
  ['permission', { repository: 'owner/beeline' }, 'Open an edit corner for owner/beeline'],
  ['permission', { purpose: 'squire-spending', tool: 'wallet' }, 'Spend with wallet'],
  ['connector-offer', { connectorName: 'Gmail' }, 'Connect Gmail'],
  ['agent-sign-in', { harness: 'claude' }, 'Sign in to Claude'],
  ['app-sign-in', { name: 'Gmail' }, 'Connect Gmail'],
  ['squire-approval', { title: 'Checkout', linkKind: 'approval' }, 'Checkout'],
  ['squire-approval', { title: 'Checkout', linkKind: 'passkey' }, 'Checkout'],
  ['grant-request', { grants: [{ kind: 'command', target: 'npm test' }] }, 'Run a command'],
] as const)('generates the plain ask for %s', (type, card, expected) => {
  expect(approvalAsk(type, card)).toBe(expected);
});

it('uses the legacy card prompt when an old ask is empty', () => {
  expect(approvalAsk('choice', { ask: '', prompt: '**Ship now?**' })).toBe('Ship now?');
});
