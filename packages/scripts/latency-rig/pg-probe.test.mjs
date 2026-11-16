import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('socket reply spans retain their request scope without recording payloads', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'latency-socket-span-'));
  const log = path.join(output, 'sql.ndjson');
  try {
    const result = spawnSync(process.execPath, ['--require', fileURLToPath(new URL('./pg-probe.cjs', import.meta.url)), '-e', `
      const http = require('node:http');
      const { WebSocket, WebSocketServer } = require('ws');
      const server = http.createServer();
      const sockets = new WebSocketServer({ server });
      sockets.on('connection', socket => socket.on('message', data => {
        const frame = JSON.parse(String(data));
        // Replies run on async resources after both request callbacks return.
        setImmediate(() => socket.send(JSON.stringify({ t: 'res', id: frame.id,
          ok: frame.op === 'readRoom', result: 'PRIVATE_RESULT' })));
      }));
      server.listen(0, '127.0.0.1', () => {
        const client = new WebSocket('ws://127.0.0.1:' + server.address().port);
        client.on('open', () => {
          for (const op of ['readRoom', 'resolveDirectMessage'])
            client.send(JSON.stringify({ t: 'req', id: op, op, args: { secret: 'PRIVATE_ARGUMENT' } }));
        });
        let replies = 0;
        client.on('message', () => { if (++replies === 2) client.close(); });
        client.on('close', () => sockets.close(() => server.close()));
      });
    `], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', LATENCY_RIG_SQL_LOG: log,
        DATABASE_URL: 'postgresql://localhost/beeline_latency_rig_probe' },
    });
    assert.equal(result.status, 0, result.stderr);
    const raw = await readFile(log, 'utf8');
    const records = raw.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(record => record.operation).sort(), ['phone.readRoom', 'phone.resolveDirectMessage']);
    assert.equal(new Set(records.map(record => record.traceId)).size, 2);
    for (const record of records) {
      assert.equal(record.type, 'operation');
      assert.ok(record.endMs >= record.startMs);
      assert.equal(record.ok, record.operation === 'phone.readRoom');
    }
    assert.doesNotMatch(raw, /PRIVATE_ARGUMENT|PRIVATE_RESULT/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
