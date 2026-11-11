import { expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';
import { ProductionReleaseBusyError } from '@beeline/auth/github';
import { CommandRefusalError, ExpectedRefusalError } from './command-refusal.js';
import { CornerVerdictRejectedError } from './corner-merge-approval.js';
import { captureServerError } from './sentry.js';
import { requestErrorStatus } from './server-request-error-status.js';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

it('Reproduction SENTRY-REFUSALS: shared capture excludes typed refusals and retains unknown failures', () => {
  for (const status of [400, 403, 404, 409, 410, 429] as const) {
    captureServerError(new CommandRefusalError('Expected refusal', status));
  }
  captureServerError(new ExpectedRefusalError('Expected legacy refusal'));
  captureServerError(new CornerVerdictRejectedError('STALE_HEAD', 'Review current head'));
  const busy = new ProductionReleaseBusyError();
  expect(busy.message).toBe('busy');
  expect(requestErrorStatus(busy)).toBe(409);
  captureServerError(busy);
  expect(Sentry.captureException).not.toHaveBeenCalled();
  for (const error of [new Error('Unexpected fault'), { status: 403 }, 'unknown failure']) {
    captureServerError(error);
    expect(Sentry.captureException).toHaveBeenLastCalledWith(error, expect.anything());
  }
});
