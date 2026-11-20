import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/auth/buzz-identity-storage', () => ({ clearBuzzIdentity: vi.fn(async () => undefined) }));
vi.mock('@/auth/github-auth-session', () => ({ clearPendingGitHubSignInState: vi.fn(async () => undefined) }));
vi.mock('@/auth/monolith-session', () => ({ monolithSession: {}, MonolithSession: class {} }));
vi.mock('@/buzz/surface-storage', () => ({ clearMobileSurfaceStorage: vi.fn() }));
vi.mock('./signin-funnel', () => ({ suppressSigninFunnel: vi.fn() }));
import { signInWithReviewSecret } from './review-sign-in';

const session = {
  reviewIdentityForSecret: vi.fn(async () => null as string | null),
  identityId: vi.fn(async () => null as string | null),
  signOut: vi.fn(async () => undefined),
  exchangeReviewSecret: vi.fn(async () => 'review-identity'),
};

beforeEach(() => { vi.clearAllMocks(); });

it('signs a fresh device in without a sign-out, so no identity change restarts the link', async () => {
  await expect(signInWithReviewSecret('secret', session as never)).resolves.toBe('review-identity');
  expect(session.signOut).not.toHaveBeenCalled();
  expect(session.exchangeReviewSecret).toHaveBeenCalledWith('secret');
});

it('signs the previous identity out before the exchange', async () => {
  session.identityId.mockResolvedValueOnce('someone-else');
  await signInWithReviewSecret('secret', session as never);
  expect(session.signOut).toHaveBeenCalledTimes(1);
  expect(session.signOut.mock.invocationCallOrder[0]).toBeLessThan(session.exchangeReviewSecret.mock.invocationCallOrder[0]);
});
