import { describe, expect, it } from 'vitest';
import { INSTITUTIONAL_HISTORY_QUERY_SCHEMA, nonPortableSchemaPatterns, regexPortabilityProblem } from '@beeline/api-contract/daemon';
import { CAPABILITY_TOOLS, agentToolsFor, repositoryTools, scratchTools, type ToolDefinition } from './minimal-tool-surface.js';

function everyAdvertisedTool(): ToolDefinition[] {
  const tools: ToolDefinition[] = [...repositoryTools(), ...scratchTools(true), ...scratchTools(false)];
  for (const corner of [false, true]) for (const repo of [false, true]) for (const free of [false, true]) for (const operator of [false, true])
    tools.push(...agentToolsFor(true, false, corner, repo, true, true, false, free, operator));
  for (const group of Object.values(CAPABILITY_TOOLS)) tools.push(...Object.values(group));
  return tools;
}

describe('advertised tool schemas compile in RE2 harnesses', () => {
  it('flags the syntax RE2 rejects', () => {
    for (const bad of ['^(?![\\s\\S]*\\u0000)\\S', '(?=a)', '(?<=a)b', '(?<!a)b', '(?<n>a)', '(a)\\1', '(?<n>a)\\k<n>', '\\u0041', '[](?=a)'])
      expect(regexPortabilityProblem(bad), bad).toBeDefined();
    for (const good of ['\\S', '^[0-9a-f]{64}$', '^[a-z0-9][a-z0-9_./-]{1,31}$', '\\\\u', '[(?=]', '(?:a|b)'])
      expect(regexPortabilityProblem(good), good).toBeUndefined();
  });

  it('keeps every body tool pattern portable, including the search query', () => {
    expect(regexPortabilityProblem(INSTITUTIONAL_HISTORY_QUERY_SCHEMA.pattern)).toBeUndefined();
    const problems = everyAdvertisedTool().flatMap(tool =>
      nonPortableSchemaPatterns(tool.inputSchema).map(problem => ({ tool: tool.name, ...problem })));
    expect(problems).toEqual([]);
  });
});
