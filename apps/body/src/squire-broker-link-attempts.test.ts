import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { runSquireBrokerLink } from './squire-broker-link.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A broker socket the test connects, closes or leaves pending by hand. */
class FakePeer extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  errored = null;
  write(line: string): boolean {
    this.written.push(line);
    return true;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    return super.removeListener(event, listener);
  }
}

async function link() {
  const dir = await mkdtemp(join(tmpdir(), 'squire-attempts-'));
  dirs.push(dir);
  const socketPath = join(dir, 'mcp.sock');
  const peers: FakePeer[] = [];
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  output.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) frames.push(JSON.parse(line));
  });
  const done = runSquireBrokerLink({
    agentId: 'beeline-helper',
    socketPath,
    input,
    output,
    onShutdownSignal: () => {},
    logError: () => {},
    connect: () => {
      const peer = new FakePeer();
      peers.push(peer);
      return peer as unknown as Socket;
    },
  });
  return { socketPath, peers, input, frames, done };
}

it('owns one connect attempt: duplicate publications open no second socket, and EOF destroys it', async () => {
  const { socketPath, peers, input, frames, done } = await link();
  expect(peers).toHaveLength(1);
  peers[0]!.emit('connect');
  await vi.waitFor(() => expect(peers[0]!.written[0]).toBe('beeline-helper\n'));
  // The established connection drops: one replacement attempt starts at once.
  peers[0]!.emit('close');
  await vi.waitFor(() => expect(peers).toHaveLength(2));
  // Publications while that attempt is pending start nothing more.
  await writeFile(socketPath, '');
  await writeFile(socketPath, 'again');
  await new Promise((resolve) => setImmediate(resolve));
  expect(peers).toHaveLength(2);
  // A request during the pending attempt waits only for that attempt.
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call' })}\n`);
  peers[1]!.emit('error', Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }));
  await vi.waitFor(() =>
    expect(frames).toContainEqual(
      expect.objectContaining({
        id: 7,
        error: expect.objectContaining({ data: { outcome: 'not-sent', reconnect: 'in-progress' } }),
      }),
    ),
  );
  // A publication seen during that attempt admits exactly one more; it fails too.
  await vi.waitFor(() => expect(peers).toHaveLength(3));
  peers[2]!.emit('error', Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }));
  await new Promise((resolve) => setImmediate(resolve));
  expect(peers).toHaveLength(3);
  // With no socket and no attempt, a request is answered at once as never sent.
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call' })}\n`);
  await vi.waitFor(() => expect(frames.some((frame) => frame.id === 8)).toBe(true));
  // The next publication reconnects; input EOF during that attempt ends the link and its peer.
  await writeFile(socketPath, 'published');
  await vi.waitFor(() => expect(peers).toHaveLength(4));
  input.end();
  await expect(done).resolves.toEqual({ ok: true });
  expect(peers[3]!.destroyed).toBe(true);
});
