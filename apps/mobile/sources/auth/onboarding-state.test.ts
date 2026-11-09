import { describe, expect, it } from 'vitest';
import { OidcBindError } from '@beeline/buzz-client';
import { noticeForAuthError } from './onboarding-state';

describe.each([['google', 'Google'], ['github', 'GitHub']] as const)('%s sign-in notices', (provider, name) => {
  it.each(['ticket_expired', 'unknown_ticket', 'invalid_oidc_flow'])('names the provider when %s', code => {
    expect(noticeForAuthError(new OidcBindError(code, code), provider).message)
      .toBe(`Continue with ${name} again to start a new sign-in.`);
  });
  it.each(['state_mismatch', 'unknown'])('names the provider when %s', code => {
    expect(noticeForAuthError(new OidcBindError(code, code), provider).message)
      .toBe(`Continue with ${name} again to finish signing in.`);
  });
  it.each(['invalid_redirect', 'invalid_configuration', 'invalid_state'])('names the provider when %s', code => {
    expect(noticeForAuthError(new OidcBindError(code, code), provider).message)
      .toBe(`Update Beeline, then continue with ${name} again.`);
  });
  it('names the provider for an account conflict', () => {
    expect(noticeForAuthError(new OidcBindError('identity_conflict', 'conflict'), provider).message)
      .toBe(`This ${name} account is linked to another device key. Replace it to continue with a new identity, or import your backed-up key to keep the existing identity.`);
  });
});
