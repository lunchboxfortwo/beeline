import { describe, expect, it } from 'vitest';
import { approvalSentence, harnessApprovalIntent, normalizeApprovalIntent } from './approval-copy.js';

describe('action to purpose approval copy', () => {
  it('keeps the concrete object, amount and complete purpose', () => {
    const intent = normalizeApprovalIntent({ action: 'Connect Stripe Link', purpose: 'pay for the $29 domain renewal for whitejade.xyz' });
    expect(approvalSentence(intent.action, intent.purpose)).toBe('Connect Stripe Link to pay for the $29 domain renewal for whitejade.xyz');
  });
  it.each(['action', 'purpose'] as const)('asks the agent to supply or shorten %s', field => {
    const intent = { action: 'Connect Gmail', purpose: 'read the renewal notice' };
    for (const value of [undefined, '', '   ']) expect(() => normalizeApprovalIntent({ ...intent, [field]: value })).toThrow(`Supply ${field}`);
    expect(() => normalizeApprovalIntent({ ...intent, [field]: 'word '.repeat(field === 'action' ? 13 : 21) })).toThrow(`Shorten ${field}`);
    expect(() => normalizeApprovalIntent({ ...intent, [field]: 'x'.repeat(field === 'action' ? 121 : 241) })).toThrow(`Shorten ${field}`);
    expect(normalizeApprovalIntent({ ...intent, [field]: 'word '.repeat(field === 'action' ? 12 : 20) })[field].split(' ')).toHaveLength(field === 'action' ? 12 : 20);
  });
  it('uses the last stated sentence for a harness prompt and keeps commands out of the action', () => {
    const intent = harnessApprovalIntent('Run shell command: node -e "SECRET_SCRIPT"', "I checked the cache. I’ll remove stale files so the build can finish.");
    expect(approvalSentence(intent.action, intent.purpose)).toBe('Run shell command to remove stale files so the build can finish');
    expect(harnessApprovalIntent('node -e "SECRET_SCRIPT"')).toEqual({ action: 'Run a command' });
    expect(harnessApprovalIntent('Edit build configuration')).toEqual({ action: 'Edit build configuration' });
  });
});
