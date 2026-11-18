import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { phoneIdentity } from './phone-identity.js';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenAfterBestEffortRecovery } from './startup.js';

describe('server startup containment', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it('listens after a rejected presence recovery and reports it once', async () => {
    const server = createServer((_request, response) => response.end('ok'));
    servers.push(server);
    const report = vi.fn();

    await listenAfterBestEffortRecovery(
      server,
      async () => {
        throw new Error('canceling statement due to statement timeout');
      },
      0,
      '127.0.0.1',
      report,
    );

    expect(server.listening).toBe(true);
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(
      '[startup] presence recovery unavailable; continuing',
      'canceling statement due to statement timeout',
    );
  });


});

it('keeps call portrait URLs absolute through the production startup wiring', () => {
  // Evaluate only the real constructor options: importing index would start the server.
  const source = ts.createSourceFile('index.ts', readFileSync(new URL('./index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  let constructor: ts.NewExpression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'VoiceService') constructor = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(constructor).toBeDefined();
  const publicOrigin = 'https://server.example';
  const options = runInNewContext(`(${constructor!.arguments![2]!.getText(source)})`, {
    voiceConfig: {}, objectService: undefined, publicOrigin,
  }) as { publicOrigin?: string };
  const portrait = '/v1/agent-avatars/33333333-3333-4333-8333-333333333333';
  const row = { id: 'ruby', kind: 'agent' as const, name: 'Ruby', handle: 'ruby', avatar: portrait, face_id: 'owl' };
  const callIdentity = phoneIdentity(row, options.publicOrigin ?? '');
  expect(callIdentity.avatar).toBe(`${publicOrigin}${portrait}`);
  expect(callIdentity).toEqual(phoneIdentity(row, publicOrigin));
});
