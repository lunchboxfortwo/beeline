/**
 * The registered agent-facing surface: every tool, wake template and guide a
 * Beeline agent can be handed, keyed by runtime and capability.
 *
 *   node --import tsx packages/scripts/prompt-surface.ts           rewrite docs/prompts/surface.json
 *   node --import tsx packages/scripts/prompt-surface.ts --check   fail when the committed snapshot is stale
 *
 * Inventories: native body tools per session variant with their nested app_tool
 * capabilities (`apps/body/src/minimal-tool-surface.ts`), external MCP tools
 * (`apps/server/src/rooms-mcp.ts`, `rooms-mcp-agent.ts`), wake template
 * families with one fixture per branch, and first-party skills
 * (`packages/api-contract/src/beeline-guides.ts`). It never calls a model.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CAPABILITY_TOOLS, agentToolsFor, type ToolDefinition } from '../../apps/body/src/minimal-tool-surface.js';
import { resumePrompt } from '../../apps/body/src/place-prompt.js';
import { beelineManagedSkills } from '../api-contract/src/beeline-guides.js';
import { MCP_AGENT_TOOLS, MCP_OPERATOR_TOOLS, MCP_RETIRED_TOOLS } from '../../apps/server/src/rooms-mcp-agent.js';
import { mcpWakeNext } from '../../apps/server/src/rooms-mcp-events.js';
import { ROOM_TOOLS } from '../../apps/server/src/rooms-mcp.js';

const SNAPSHOT = join(resolve(__dirname, '../..'), 'docs', 'prompts', 'surface.json');

type Tool = { name: string; description?: string; inputSchema: unknown };
const byName = (tools: readonly Tool[]) =>
  Object.fromEntries([...tools].sort((a, b) => a.name.localeCompare(b.name))
    .map(tool => [tool.name, { description: tool.description ?? '', inputSchema: tool.inputSchema }]));

/** The body session variants the assembler renders (`agentToolsFor` arguments). */
const BODY_VARIANTS: Record<string, Parameters<typeof agentToolsFor>> = {
  room: [true, false, false, false, true, true, true],
  dm: [true, true, false, false, true, true, true],
  thread: [true, false, true, false, true, true, true],
  'code-thread': [true, false, true, true, true, true, true],
  'no-command-runner': [true, false, false, false, false, true, true],
  'free-agent': [true, false, false, false, true, true, true, true],
  operator: [true, false, false, false, true, true, true, false, true],
  'repository-only': [false, false],
};

/** One fixture per template branch; runtime data stays out of the trusted text. */
const RESUME_BRANCHES: Record<string, Parameters<typeof resumePrompt>[0]> = {
  'squire-approval': { body: '<decision>', systemEvent: { kind: 'squire-approval-decided' } as never },
  'connector-offer': { body: '<decision>', systemEvent: { kind: 'connector-offer-decided' } as never },
  'device-grant': { body: '<person> approved device <device>' },
  'mcp-grant': { body: '<person> approved mcp <route>' },
  'command-grant': { body: '<person> approved command <argv>' },
};
const MCP_WAKE_BRANCHES: Record<string, [string | null, string | null]> = {
  message: ['message', 'message'], reply: ['reply', 'reply'], order: ['order', 'order'],
  review: ['lifecycle', 'corner_review_dispatch'], lifecycle: ['lifecycle', 'corner_check'], event: [null, 'subscribed_event'],
};

export function extractSurface() {
  const bodyTools = Object.values(BODY_VARIANTS).flatMap(variant => agentToolsFor(...variant));
  const skills = (options: Parameters<typeof beelineManagedSkills>[1]) => beelineManagedSkills('source', options);
  const guideVariants = { default: skills({ isReviewer: false }), reviewer: skills({ isReviewer: true }), 'free-agent': skills({ isReviewer: false, freeAgent: true }) };
  return {
    body: {
      tools: byName([...new Map(bodyTools.map(tool => [tool.name, tool])).values()]),
      variants: Object.fromEntries(Object.entries(BODY_VARIANTS).map(([name, variant]) =>
        [name, agentToolsFor(...variant).map(tool => tool.name)])),
      capabilities: Object.fromEntries(Object.entries(CAPABILITY_TOOLS).sort(([a], [b]) => a.localeCompare(b))
        .map(([app, tools]) => [app, byName(Object.values(tools) as ToolDefinition[])])),
    },
    mcp: { chat: byName(ROOM_TOOLS), agent: byName(MCP_AGENT_TOOLS), operator: byName(MCP_OPERATOR_TOOLS),
      retired: Object.fromEntries(Object.entries(MCP_RETIRED_TOOLS).sort(([a], [b]) => a.localeCompare(b))) },
    wakes: {
      'mcp-next': Object.fromEntries(Object.entries(MCP_WAKE_BRANCHES).map(([branch, [kind, reason]]) => [branch, mcpWakeNext(kind, reason)])),
      'body-resume': Object.fromEntries(Object.entries(RESUME_BRANCHES).map(([branch, item]) => [branch, resumePrompt(item)])),
    },
    guides: {
      skills: Object.fromEntries([...new Map(Object.values(guideVariants).flat().map(skill => [skill.name, skill.content])).entries()]
        .sort(([a], [b]) => a.localeCompare(b))),
      variants: Object.fromEntries(Object.entries(guideVariants).map(([name, list]) => [name, list.map(skill => skill.name)])),
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  const rendered = `${JSON.stringify(extractSurface(), null, 1)}\n`;
  if (process.argv.includes('--check')) {
    if (readFileSync(SNAPSHOT, 'utf8') !== rendered) {
      console.error('docs/prompts/surface.json is stale: run node --import tsx packages/scripts/prompt-surface.ts and commit the result.');
      process.exit(1);
    }
  } else writeFileSync(SNAPSHOT, rendered);
}
