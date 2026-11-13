import * as daemonWorkbench from './daemon/workbench.js';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import * as Sentry from '@sentry/node';
import type { Event } from '@sentry/node';
import { createErrorEventFilter } from '@beeline/api-contract/error-reporting';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
import { LiveHub } from './live.js';
import { TokenAuth, tokenHash } from './auth.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { captureServerError, withSentryAgent, withSentryUser } from './sentry.js';

const owner = 'a'.repeat(64), first = 'b'.repeat(64), second = 'c'.repeat(64);
const otherOwner = 'd'.repeat(64), otherAgent = 'e'.repeat(64);
const tokens = { first: 'bdt_sentry_user_first_123456789', second: 'bdt_sentry_user_second_12345678', other: 'bdt_sentry_user_other_123456789' };
const events: Event[] = [];
let db: PgliteDatabase;
let daemon: DaemonService;
let server: ReturnType<typeof createBeelineServer>;
let origin: string;

beforeAll(async () => {
  // The real SDK and privacy filter, with a transport that keeps each emitted event here.
  Sentry.init({
    dsn: 'https://public@sentry.invalid/1', defaultIntegrations: false, skipOpenTelemetrySetup: true,
    beforeSend: createErrorEventFilter(),
    transport: () => ({
      send: async envelope => {
        for (const [header, payload] of envelope[1] as unknown as [{ type: string }, Event][])
          if (header.type === 'event') events.push(payload);
        return {};
      },
      flush: async () => true,
    }),
  });
  // CI reuses one worker. Earlier files run helper code that names an owner on the
  // process-wide Sentry scope. Plant that leftover user; events still name the
  // account captured with them, or nobody.
  Sentry.setUser({ id: otherAgent });
  db = await migratedDatabase();
  daemon = new DaemonService(db, new LiveHub());
  vi.spyOn(daemonWorkbench, 'daemonWarmConnectorIndex').mockResolvedValue();
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','First'),($3,'agent','Second'),($4,'human','Other'),($5,'agent','Other agent')`,
    [owner, first, second, otherOwner, otherAgent]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3),($4,$5)`, [first, second, owner, otherAgent, otherOwner]);
  await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2),($3,$4),($5,$6)`,
    [tokenHash(tokens.first), first, tokenHash(tokens.second), second, tokenHash(tokens.other), otherAgent]);
  const auth = new TokenAuth(db, async () => { throw new Error('unused'); });
  server = createBeelineServer({ database: db, daemon, live: new LiveHub(), auth, phone: new PhoneService(db, 'http://test'), mediaMaximumBytes: 1 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => {
  await Sentry.close();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await db?.close();
});

const emitted = async () => { await Sentry.flush(); return events.splice(0); };
const userByMessage = (list: Event[]) => Object.fromEntries(list.map(event => [event.exception?.values?.[0]?.value, event.user]));

it('Reproduction sentry-no-user: concurrent agent requests report their owners, never each other', async () => {
  // The first request fails last, so a shared scope would hand it another account.
  const delays: Record<string, number> = { [first]: 80, [second]: 40, [otherAgent]: 10 };
  const names: Record<string, string> = { [first]: 'first', [second]: 'second', [otherAgent]: 'other' };
  const execute = vi.spyOn(daemon, 'execute').mockImplementation(async (_operation, _input, agentId) => {
    await new Promise(resolve => setTimeout(resolve, delays[agentId]));
    throw new Error(`operation failed for ${names[agentId]}`);
  });
  const call = (token: string) => fetch(`${origin}/v1/daemon/operations/archiveCorner`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ cornerId: '33333333-3333-4333-8333-333333333333' }),
  });
  try {
    const responses = await Promise.all([call(tokens.first), call(tokens.second), call(tokens.other)]);
    expect(responses.every(response => response.status >= 500)).toBe(true);
  } finally { execute.mockRestore(); }
  // Two agents of one person count once; the event names only the opaque id.
  expect(userByMessage(await emitted())).toEqual({
    'operation failed for first': { id: owner },
    'operation failed for second': { id: owner },
    'operation failed for other': { id: otherOwner },
  });
});

it('events raised outside the reporting wrapper, such as fatal crashes, carry the scoped account', async () => {
  await Promise.all([
    withSentryUser(owner, async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      Sentry.captureException(new Error('fatal for owner'), { captureContext: { level: 'fatal' } });
    }),
    withSentryUser(otherOwner, async () => { captureServerError(new Error('handled for other')); }),
  ]);
  captureServerError(new Error('background'));
  expect(userByMessage(await emitted())).toEqual({
    'fatal for owner': { id: owner },
    'handled for other': { id: otherOwner },
    background: undefined,
  });
});

it('a failed owner lookup does not report the agent', async () => {
  const database = { query: async () => { throw new Error('owner lookup down'); } };
  withSentryAgent(database, 'f'.repeat(64), () => captureServerError(new Error('lookup down')));
  expect(userByMessage(await emitted())).toEqual({ 'lookup down': undefined });
});
