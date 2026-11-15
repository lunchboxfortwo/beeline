import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { freeAgentConfigFromEnv } from './free-agents.js';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});
afterEach(() => vi.mocked(readFileSync).mockRestore());

it('uses the immutable image shipped inside the server instead of an independently staged secret', () => {
  const image = 'registry.fly.io/beeline-free-agents:matching@sha256:' + 'a'.repeat(64);
  vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({ image }));
  expect(freeAgentConfigFromEnv({ NODE_ENV: 'production', BEELINE_FREE_AGENT_SEAL_KEY: 'test',
    FLY_FREE_AGENT_IMAGE: 'independently-staged-image' }, 'https://server.test')?.image).toBe(image);
});

it('refuses an unfinished production image rather than selecting a stale secret', () => {
  vi.mocked(readFileSync).mockReturnValueOnce('{"image":null}');
  expect(() => freeAgentConfigFromEnv({ NODE_ENV: 'production', BEELINE_FREE_AGENT_SEAL_KEY: 'test',
    FLY_FREE_AGENT_IMAGE: 'stale' }, 'https://server.test')).toThrow('missing its free-agent image');
});
