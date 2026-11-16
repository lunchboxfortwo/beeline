import { expect, it } from 'vitest';
import { MCP_AGENT_EXCLUSIONS, MCP_AGENT_TOOLS, MCP_APP_ROUTE_OPERATIONS, MCP_RETIRED_TOOLS } from './rooms-mcp-agent.js';

it('keeps retired app operations out of external AI discovery and exclusions', () => {
  const retired = ['corner', 'app'].join('_');
  for (const name of [...Object.keys(MCP_AGENT_EXCLUSIONS), ...MCP_AGENT_TOOLS.map(tool => tool.name), ...MCP_APP_ROUTE_OPERATIONS]) {
    expect(name).not.toContain(retired);
  }
});

it('answers every retired tool name with a replacement that is still a tool', () => {
  const live = new Set([...MCP_AGENT_TOOLS.map(tool => tool.name), 'list_chats']);
  for (const [name, reason] of Object.entries(MCP_RETIRED_TOOLS)) {
    expect(live.has(name), name).toBe(false);
    for (const tool of reason.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) expect(live.has(tool), `${name} -> ${tool}`).toBe(true);
  }
});
