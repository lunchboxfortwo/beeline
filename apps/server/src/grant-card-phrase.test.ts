import { expect, it } from 'vitest';
import { grantCardPhrase } from './daemon/values.js';

const requester = { pubkey: 'human', kind: 'human' as const, name: 'lunchbox' };
const agent = { pubkey: 'agent', name: 'Jellybean' };

it.each([
  ['command', 'node scripts/live-a.mjs', 'run'],
  ['path', '/tmp/report', 'read'],
  ['repository', 'team/repo', 'edit'],
  ['secret', 'API_KEY', 'use'],
  ['host', 'example.com', 'reach'],
  ['device', 'emulator', 'use'],
  ['budget', '$10', 'spend'],
  ['mcp', 'squire', 'use'],
  ['shared_asset', 'cache', 'isolate'],
] as const)('R1: the asking agent wants to %s with the per-kind verb', (kind, target, verb) => {
  expect(grantCardPhrase(requester, agent, [{ kind, target }])).toEqual({
    subject: { kind: 'agent', id: agent.pubkey, name: agent.name },
    verb: 'wants to',
    object: `${verb} ${target}`,
  });
});

it('keeps connection request wording and agent subject', () => {
  expect(grantCardPhrase(requester, agent, [{ kind: 'mcp', target: 'connection-install:github' }]))
    .toEqual({ subject: { kind: 'agent', id: agent.pubkey, name: agent.name },
      verb: 'wants to connect', object: 'GitHub' });
});
