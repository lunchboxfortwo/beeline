import { describe, expect, it, vi } from 'vitest';
import { approvalAsk, normalizeAgentApprovalIntent } from './tray-approval-ask.js';
import { daemonRequestAgentGrant } from './daemon/grants.js';
import { daemonOfferConnector } from './daemon/connector-offers.js';
import { daemonConnectAppFrontDoor, daemonConnectService } from './daemon/apps.js';
import { daemonSquireApproval, daemonPermissionRequest } from './daemon/approvals.js';

describe('approval intent at the posting boundary', () => {
  it.each(['grant-request', 'permission', 'connector-offer', 'squire-approval', 'app-sign-in', 'agent-sign-in'])('renders %s from typed intent instead of its title or raw detail', type => {
    const sentence = approvalAsk(type, { action: 'Connect Stripe Link', purpose: 'pay for the $29 domain renewal for whitejade.xyz',
      approvalPurpose: 'pay for the $29 domain renewal for whitejade.xyz', title: 'Link', detail: 'RAW_SCRIPT',
      ask: 'Bare title?', grants: [{ action: 'Connect Stripe Link', purpose: 'pay for the $29 domain renewal for whitejade.xyz', kind: 'command', target: 'RAW_SCRIPT' }] });
    expect(sentence).toBe('Connect Stripe Link to pay for the $29 domain renewal for whitejade.xyz');
  });
  it('keeps legacy scripts off the row and preserves typed question asks', () => {
    expect(approvalAsk('grant-request', { grants: [{ kind: 'command', target: 'RAW_SCRIPT', script: {} }] })).toBe('Run a script');
    expect(approvalAsk('agent-sign-in', { harness: 'codex' })).toBe('Sign in to ChatGPT');
    expect(approvalAsk('choice', { prompt: 'Which?', ask: 'Use the queue?' })).toBe('Use the queue?');
  });
  it.each([daemonRequestAgentGrant, daemonOfferConnector, daemonConnectAppFrontDoor, daemonConnectService, daemonSquireApproval, daemonPermissionRequest])('rejects missing intent before writing a card (%s)', async operation => {
    const query = vi.fn();
    const ctx = { database: { query }, access: vi.fn() } as any;
    await expect(operation(ctx, { roomId: 'room', purpose: 'finish the task' } as any, 'agent')).rejects.toThrow('Supply action');
    expect(query).not.toHaveBeenCalled();
  });
  it('returns a plain agent refusal for long copy', () => {
    expect(() => normalizeAgentApprovalIntent({ action: 'word '.repeat(13), purpose: 'finish the task' })).toThrow('Shorten action');
  });
});
