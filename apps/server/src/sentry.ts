import {postgresErrorContext} from './postgres-error.js';
import { ExpectedRefusalError } from './command-refusal.js';
import { GitHubCheckPermissionError, GitHubHttpError, ProductionReleaseBusyError } from '@beeline/auth/github';
import * as Sentry from '@sentry/node';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SqlDatabase } from './database.js';
import { createErrorEventFilter } from '@beeline/api-contract/error-reporting';

const filterErrorEvent = createErrorEventFilter();

/** No HTTP/console instrumentation; existing request and background recovery owns handled failures. */
if (process.env.SENTRY_DSN) {
  try { Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? 'production',
    release: process.env.BEELINE_RELEASE_SHA ?? process.env.FLY_IMAGE_REF,
    sendDefaultPii: false,
    defaultIntegrations: false,
    // Drain fatal reports before Node's normal exit(1); defer to any existing
    // uncaught-exception handler. Unhandled-rejection policy stays with the app.
    integrations: [Sentry.onUncaughtExceptionIntegration({ exitEvenIfOtherHandlersAreRegistered: false })],
    skipOpenTelemetrySetup: true,
    sampleRate: 1,
    maxBreadcrumbs: 0,
    beforeSend: filterErrorEvent,
    initialScope: { tags: { surface: 'server' } },
  }); } catch { /* Telemetry configuration must not prevent startup. */ }
}

/**
 * The signed-in account of the request or socket operation now running. Sentry's own
 * isolation scopes do not follow async work here (no OpenTelemetry context), so this
 * store carries the account and a global event processor names it on every event,
 * including automatic fatal ones.
 */
type SentryHolder = { id?: string; agentId?: string; database?: Pick<SqlDatabase, 'query'> };
const sentryUser = new AsyncLocalStorage<SentryHolder>();
/** Agent id to owning account. Owners never change, so a hit never goes stale. */
const accounts = new Map<string, string>();
const ACCOUNT_CACHE_LIMIT = 10_000;
/**
 * Account or agent taken when the error is captured. The processor can run after that
 * request's context has moved on, and a user already on the Sentry scope must not replace it.
 */
type PendingSentryUser = { accountId?: string; agentId?: string; database?: Pick<SqlDatabase, 'query'> };
const pendingEvents = new WeakMap<object, PendingSentryUser>();

function accountOn(holder: SentryHolder | undefined): string | undefined {
  return holder?.id ?? (holder?.agentId ? accounts.get(holder.agentId) : undefined);
}

function unnamed<T extends { user?: unknown }>(event: T): T {
  if (!event.user) return event;
  const { user: _user, ...rest } = event;
  return rest as T;
}

try {
  Sentry.getGlobalScope().addEventProcessor((event, hint) => {
    const pending = hint?.originalException && typeof hint.originalException === 'object'
      ? pendingEvents.get(hint.originalException) : undefined;
    if (pending?.accountId) return { ...event, user: { id: pending.accountId } };
    if (pending?.agentId && pending.database) {
      const cached = accounts.get(pending.agentId);
      if (cached) return { ...event, user: { id: cached } };
      // The owner is looked up only when an event is sent, so connecting and
      // ordinary requests never spend a database connection on telemetry.
      const agentId = pending.agentId, database = pending.database;
      return sentryAccount(database, agentId).then(account =>
        account ? { ...event, user: { id: account } } : unnamed(event));
    }
    // A server-reported event with no account names nobody.
    if (pending) return unnamed(event);
    // Outside any server request or operation, leave other events as captured: the
    // server never sets a scope user, and other code in the same process may.
    const holder = sentryUser.getStore();
    if (!holder) return event;
    const known = accountOn(holder);
    return known ? { ...event, user: { id: known } } : unnamed(event);
  });
} catch { /* Telemetry configuration must not prevent startup. */ }

/** Each HTTP request gets its own holder, so one person's id never reaches another's event. */
export function withSentryUserScope<T>(work: () => T): T {
  return sentryUser.run({}, work);
}

/** Record the account for the current request or operation scope. */
export function noteSentryUser(accountId: string | null | undefined): void {
  const holder = sentryUser.getStore();
  if (holder && accountId) holder.id = accountId;
}

/** Run one authenticated socket frame or registration as that account. */
export function withSentryUser<T>(accountId: string, work: () => T): T {
  return sentryUser.run({ id: accountId }, work);
}

/** Record an agent for the current request scope; Sentry counts its owner. */
export function noteSentryAgent(database: Pick<SqlDatabase, 'query'>, agentId: string | null | undefined): void {
  const holder = sentryUser.getStore();
  if (holder && agentId) Object.assign(holder, { agentId, database });
}

/** Run one agent socket frame or registration; Sentry counts the agent's owner. */
export function withSentryAgent<T>(database: Pick<SqlDatabase, 'query'>, agentId: string, work: () => T): T {
  return sentryUser.run({ agentId, database }, work);
}

/** The owning account already learned for an agent. Never the agent id itself. */
export function cachedSentryAccount(identityId: string): string | undefined {
  return accounts.get(identityId);
}

/** Remember an agent's owner learned elsewhere, so later frames need no lookup. */
export function rememberSentryAccount(identityId: string, ownerId: string | null | undefined): void {
  if (!ownerId) return;
  if (accounts.size >= ACCOUNT_CACHE_LIMIT) accounts.clear();
  accounts.set(identityId, ownerId);
}

/** Resolve and remember an agent's owner. A miss or a failed read names nobody. */
export async function sentryAccount(
  database: Pick<SqlDatabase, 'query'>,
  identityId: string,
): Promise<string | undefined> {
  const known = accounts.get(identityId);
  if (known) return known;
  try {
    const owner = (await database.query<{ owner_id: string | null }>(
      'SELECT owner_id FROM agents WHERE agent_id=$1', [identityId])).rows[0]?.owner_id;
    if (!owner) return undefined;
    rememberSentryAccount(identityId, owner);
    return owner;
  } catch { return undefined; }
}

export function captureServerError(error: unknown, tags: Record<string, string> = {}): void {
  if (error instanceof ExpectedRefusalError) return;
  if (error instanceof ProductionReleaseBusyError) return;
  if (error instanceof GitHubCheckPermissionError) return;
  if (error instanceof GitHubHttpError && error.rateLimited) return;
  try { const database=postgresErrorContext(error);
    const holder = sentryUser.getStore();
    const id = accountOn(holder);
    if (typeof error === 'object' && error) {
      if (id) pendingEvents.set(error, { accountId: id });
      else if (holder?.agentId && holder.database)
        pendingEvents.set(error, { agentId: holder.agentId, database: holder.database });
      else pendingEvents.set(error, {});
    }
    Sentry.captureException(error, { tags: { surface: 'server', ...tags }, ...(id ? { user: { id } } : {}),
    ...(database?{contexts:{postgresql:database}}:{}) }); }
  catch { /* Reporting must never change the original failure path. */ }
}

export async function flushServerErrors(): Promise<void> {
  try { await Sentry.flush(2000); } catch { /* Shutdown stays bounded. */ }
}

