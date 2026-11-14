import { expect, it } from 'vitest';
import { rewriteHostMcpDeclaration } from './host-mcp-route.js';

const scope = { agentId: 'agent', roomId: 'room', relay: {
  url: 'http://127.0.0.1:1234', token: 'private-relay-token', contextFile: '/private/turn.json',
} };
it('mounts a granted Squire relay without another resource forwarding child', () => {
  const route = rewriteHostMcpDeclaration('squire', {}, '/operator', '/private/auth.json', scope);
  expect(route.env).toMatchObject({ BEELINE_SQUIRE_RELAY_TOKEN: scope.relay.token,
    BEELINE_TURN_CONTEXT_FILE: scope.relay.contextFile });
  expect(route.env).not.toHaveProperty('BEELINE_RESOURCE_LAUNCH');
});
it('keeps the resource boundary for other host servers and direct Squire routes', () => {
  for (const [name, declaration, context] of [
    ['other', { command: '/server' }, scope],
    ['squire', {}, { agentId: 'agent', roomId: 'room' }],
  ] as const) {
    const route = rewriteHostMcpDeclaration(name, declaration, '/operator', '/private/auth.json', context);
    expect(route.env).toMatchObject({ BEELINE_RESOURCE_AUTH_FILE: '/private/auth.json' });
    expect(route.env).toHaveProperty('BEELINE_RESOURCE_LAUNCH');
  }
});
