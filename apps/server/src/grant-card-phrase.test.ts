import { expect, it } from 'vitest';
import { grantCardPhrase } from './daemon/values.js';

const requester = { pubkey: 'human', kind: 'human' as const, name: 'lunchbox' };
const agent = { pubkey: 'agent', name: 'Jellybean' };

it.each([
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

it('names the command purpose and host, keeping argv out of the request sentence',()=>{
  expect(grantCardPhrase(requester,agent,[{kind:'command',target:'["/private/node","/private/deploy.mjs"]',
    purpose:'Deploy the Milo site',machine:'squire'}]).object).toBe('deploy the Milo site on squire');
  expect(grantCardPhrase(requester,agent,[{kind:'command',target:'node private.mjs'}]).object).toBe('run a command');
  expect(grantCardPhrase(requester,agent,[{kind:'command',target:'node private.mjs',script:{}}]).object).toBe('run a script');
});

it('keeps connection request wording and agent subject', () => {
  expect(grantCardPhrase(requester, agent, [{ kind: 'mcp', target: 'connection-install:github' }]))
    .toEqual({ subject: { kind: 'agent', id: agent.pubkey, name: agent.name },
      verb: 'wants to connect', object: 'GitHub' });
});
