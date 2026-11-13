import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';
import type { Event } from '@sentry/node';
import { createErrorEventFilter } from '@beeline/api-contract/error-reporting';
import { createBeelineServer } from '../../server/src/server.js';
import { migratedDatabase } from '../../server/src/test-support.js';
import type { DaemonService } from '../../server/src/daemon-service.js';
import { TokenAuth,tokenHash } from '../../server/src/auth.js';
import type { PhoneService } from '../../server/src/phone-service.js';
import { LiveHub } from '../../server/src/live.js';
import { MachineLink } from './machine-link.js';
import { captureHelperError } from './sentry.js';

it('helper error reports name the owning account once its agent registers', async () => {
  // The real SDK and privacy filter, with a transport that keeps each emitted event here.
  const events: Event[] = [];
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
  const database = await migratedDatabase();
  const owner = 'a'.repeat(64), agentId = 'ab'.repeat(32);
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Helper')`, [owner, agentId]);
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agentId, owner]);
  await database.query('INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)',[tokenHash('bdt_helper_owner_fixture'),agentId]);
  const auth=new TokenAuth(database,async()=>{throw new Error('unused');});
  const server = createBeelineServer({ database,
    daemon: { execute: vi.fn(async () => ({})) } as unknown as DaemonService,
    auth,
    phone: {} as unknown as PhoneService, live: new LiveHub(), mediaMaximumBytes: 1 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const sockets: WebSocket[] = [];
  const machine = new MachineLink({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    factory: (url, protocols, options) => { const socket = new WebSocket(url, protocols, options); sockets.push(socket); return socket; } });
  const opened = vi.fn();
  const channel = machine.attach(agentId, { registration: () => ({ token: 'bdt_helper_owner_fixture' }),
    onOpen: opened, onClose: () => {}, onMessage: () => {}, onUpdateRequired: () => {} });
  try {
    channel.start();
    await vi.waitFor(() => expect(opened).toHaveBeenCalled(), { timeout: 5_000 });
    captureHelperError(new Error('helper failure'));
    await Sentry.flush();
    expect(events.map(event => event.user)).toEqual([{ id: owner }]);
  } finally {
    machine.stop();
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await database.close();
    await Sentry.close();
  }
}, 30_000);
