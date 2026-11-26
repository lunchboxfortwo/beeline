import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { captureException } from '@sentry/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenAuth } from './auth.js';
import type { DaemonService } from './daemon-service.js';
import type { SqlDatabase } from './database.js';
import { LiveHub } from './live.js';
import type { ObjectService } from './object-service.js';
import type { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

describe('phone media upload client abort handling', () => {
  const servers: ReturnType<typeof createBeelineServer>[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it('classifies a client-aborted phone media upload as 499 and does not send it to Sentry', async () => {
    const uploadMedia = vi.fn();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const server = createBeelineServer({
      database: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as SqlDatabase,
      auth: {
        authenticatePhone: vi.fn(async (token: string) =>
          token === 'phone-token-0000000000' ? 'ident-1' : null,
        ),
      } as unknown as TokenAuth,
      phone: { uploadMedia } as unknown as PhoneService,
      daemon: {} as DaemonService,
      live: new LiveHub(),
      objectService: {} as ObjectService,
      mediaMaximumBytes: 1024 * 1024,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    vi.mocked(captureException).mockClear();
    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/phone/media',
        headers: {
          authorization: 'Bearer phone-token-0000000000',
          'content-type': 'image/png',
          'x-file-name': 'aborted.png',
          'content-length': '65536',
        },
      });
      req.on('error', () => resolve());
      req.write(Buffer.alloc(256, 1), () => {
        setTimeout(() => req.destroy(), 20);
      });
    });

    await vi.waitFor(() => {
      expect(errorLog).toHaveBeenCalledWith(
        '[req-error]',
        'POST',
        '/v1/phone/media',
        'status=499',
        expect.any(String),
      );
    });
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();

    // Real 500s still report to Sentry so the assertion above proves suppression.
    const fault = new Error('unexpected storage boom');
    const authBoom = createBeelineServer({
      database: { query: vi.fn() } as unknown as SqlDatabase,
      auth: {
        authenticatePhone: vi.fn().mockRejectedValue(fault),
      } as unknown as TokenAuth,
      phone: {} as PhoneService,
      daemon: {} as DaemonService,
      live: new LiveHub(),
      objectService: {} as ObjectService,
      mediaMaximumBytes: 1024,
    });
    servers.push(authBoom);
    await new Promise<void>((resolve) => authBoom.listen(0, '127.0.0.1', resolve));
    const boomPort = (authBoom.address() as AddressInfo).port;
    const failed = await fetch(`http://127.0.0.1:${boomPort}/v1/phone/media`, {
      method: 'POST',
      headers: { authorization: 'Bearer phone-token-0000000000' },
      body: 'hi',
    });
    expect(failed.status).toBe(500);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(fault, expect.anything());
  });
});
