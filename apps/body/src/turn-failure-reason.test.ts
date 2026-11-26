import { describe, expect, it } from 'vitest';
import { redactToolDetail } from './turn-failure-reason.js';

describe('redactToolDetail', () => {
  it('preserves lowercase Python assignments and URL query parameters', () => {
    const command = `cd ~/x-ads; head -c 3500 2026-11-25.json; python3 -I -c 'import json;d=json.load(open("2026-11-25.json"));print(d.get("notes"))'`;
    expect(redactToolDetail(command)).toBe(command);

    const payload = JSON.stringify({
      date: '2026-11-25',
      status: 'ok',
      sourceUrl: 'https://ads.x.com/manager/18ce55ws4zb/campaigns?tab=campaigns&VIEW=ALL',
    });
    expect(redactToolDetail(payload)).toBe(payload);
    expect(JSON.parse(redactToolDetail(payload))).toEqual(JSON.parse(payload));
  });

  it('redacts uppercase shell env prefixes, named secrets, tokens, Bearer headers, PEM keys, and secret flags', () => {
    expect(redactToolDetail('FOO_BAR=planted-val rg foo')).toBe('FOO_BAR=[REDACTED] rg foo');
    expect(redactToolDetail('ls && export MY_ENV=planted-val; echo hi')).toBe(
      'ls && export MY_ENV=[REDACTED]; echo hi',
    );
    expect(redactToolDetail('echo hi&FOO_KEY=planted-val')).toBe('echo hi&FOO_KEY=[REDACTED]');
    expect(redactToolDetail('echo hi &FOO_KEY=planted-val')).toBe('echo hi &FOO_KEY=[REDACTED]');
    expect(redactToolDetail('Bearer secret-bearer-value')).toBe('Bearer [REDACTED]');
    expect(redactToolDetail('Authorization: Bearer secret-bearer-value')).not.toContain(
      'secret-bearer-value',
    );
    const bearerReceipt = redactToolDetail(
      JSON.stringify({ authorization: 'Bearer secret-bearer-value', status: 'ok' }),
    );
    expect(bearerReceipt).not.toContain('secret-bearer-value');
    expect(JSON.parse(bearerReceipt)).toEqual({ authorization: '[REDACTED]', status: 'ok' });

    const headerReceipt = redactToolDetail(
      JSON.stringify({ header: 'Bearer secret-bearer-value', status: 'ok' }),
    );
    expect(headerReceipt).not.toContain('secret-bearer-value');
    expect(JSON.parse(headerReceipt)).toEqual({ header: 'Bearer [REDACTED]', status: 'ok' });
    expect(redactToolDetail('{"api_key": "planted-key", "token": "planted-tok"}')).toContain(
      '[REDACTED]',
    );
    expect(redactToolDetail('{"api_key": "planted-key"}')).not.toContain('planted-key');
    expect(redactToolDetail('curl --token planted-flag https://example.invalid')).toBe(
      'curl --token [REDACTED] https://example.invalid',
    );
    expect(redactToolDetail('sk-abcdefghijklmnop')).toBe('[REDACTED]');
    expect(redactToolDetail('ghp_1234567890abcdef')).toBe('[REDACTED]');
    expect(
      redactToolDetail(
        '-----BEGIN RSA PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----',
      ),
    ).toBe('[REDACTED]');
  });
});
