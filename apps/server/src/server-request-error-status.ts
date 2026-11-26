import { postgresErrorContext } from './postgres-error.js';
import { isTransientDatabaseConnectionError } from './database.js';
import { ComposioRequestError } from './composio-apps.js';
import { WallRefusal } from '@beeline/api-contract/daemon';
import { PhoneOperationError } from "./phone-operations.js";
import { WorkflowAuthorizationError } from "./workflow-admin.js";
import { ClientAbortError, CommandRefusalError, ExpectedRefusalError } from "./command-refusal.js";
import { WorkspaceSkillNotFoundError } from "./institutional-skills.js";
import { institutionalMemoryErrorStatus } from "./institutional-memory-shadow.js";
import { AGENT_OWNER_AUTHORITY_MESSAGE, WORKSPACE_ADMIN_AUTHORITY_MESSAGE, SPENDING_OWNER_AUTHORITY_MESSAGE, YOLO_AUTHORITY_MESSAGE, CONNECTOR_OFFER_AUTHORITY_MESSAGE, CONNECTOR_OFFER_WALLET_AUTHORITY_MESSAGE } from "./phone-service.js";
import { GitHubHttpError, ProductionReleaseBusyError } from "@beeline/auth/github";
import { GitHubSignInError } from "./auth.js";

export function requestErrorStatus(error: unknown): number {
  if (error instanceof ClientAbortError) return 499;
  if (error instanceof GitHubSignInError) return 401;
  if (error instanceof WallRefusal) return error.status;
  if (error instanceof ProductionReleaseBusyError) return 409;
  if (error instanceof PhoneOperationError) return error.status;
  if (error instanceof WorkflowAuthorizationError || error instanceof CommandRefusalError ||
      error instanceof WorkspaceSkillNotFoundError) return error.status;
  if (isTransientDatabaseConnectionError(error)) return 503;
  if (error instanceof Error && 'code' in error &&
      (error.code === 'ECONNREFUSED' || error.code === '57P02')) return 503;
  if (postgresErrorContext(error)) return 500;
  const message = error instanceof Error ? error.message : 'request failed';
  const status = institutionalMemoryErrorStatus(message) ??
        ((message.startsWith('thread brief attachment ') &&
            message.endsWith('is missing or unavailable in this chat')) ||
          message.includes('required') ||
          message.includes('invalid') ||
          message.includes('too large') ||
          message.includes('size is outside')
        ? 400
        : message === 'github_account_mismatch' ||
            message.includes('already linked') ||
            message.includes('already claimed') ||
            message.includes('conflict') ||
            message.includes('checks are failing')
          ? 409
          : message.includes('access denied') ||
              message.includes('command output authority rejected') ||
              message.includes('command turn cancelled') ||
              message.includes('command already completed') ||
              message.includes('manager') ||
              message.includes(AGENT_OWNER_AUTHORITY_MESSAGE) ||
              message.includes(WORKSPACE_ADMIN_AUTHORITY_MESSAGE) ||
              message.includes(SPENDING_OWNER_AUTHORITY_MESSAGE) ||
              message.includes('yolo cannot be enabled in a public workspace') ||
              message.includes(YOLO_AUTHORITY_MESSAGE) ||
              message.includes(CONNECTOR_OFFER_AUTHORITY_MESSAGE) ||
              message.includes(CONNECTOR_OFFER_WALLET_AUTHORITY_MESSAGE)
            ? 403
            : message.includes('not found')
              ? 404
              : undefined);
  // GitHub's own outage or rate limit is a bad gateway, not this server
  // being unavailable; the message already names GitHub's status.
  if (error instanceof GitHubHttpError && (error.status >= 500 || error.status === 429 || error.rateLimited)) {
    return 502;
  }
  if (status !== undefined) return status;
  if (error instanceof ExpectedRefusalError) return 400;
  if (error instanceof ComposioRequestError && error.status >= 500) return 503;
  if (message === 'Cannot use a pool after calling end on the pool' ||
      message === 'database unavailable' || message === 'Beeline Sentry Telegram delivery failed') return 503;
  return 500;
}
