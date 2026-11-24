import { describe, expect, it } from 'vitest';
import { nonPortableSchemaPatterns } from '@beeline/api-contract/daemon';
import { MCP_AGENT_TOOLS, MCP_OPERATOR_TOOLS } from './rooms-mcp-agent.js';
import { ROOM_TOOLS } from './rooms-mcp.js';

describe('server MCP tool schemas compile in RE2 harnesses', () => {
  it('keeps every advertised pattern portable', () => {
    const problems = [...ROOM_TOOLS, ...MCP_AGENT_TOOLS, ...MCP_OPERATOR_TOOLS].flatMap(tool =>
      nonPortableSchemaPatterns(tool.inputSchema).map(problem => ({ tool: tool.name, ...problem })));
    expect(problems).toEqual([]);
  });
});
