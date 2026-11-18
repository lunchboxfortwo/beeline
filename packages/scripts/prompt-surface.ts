/**
 * The registered agent-facing surface: every tool, wake template and guide a
 * Beeline agent can be handed, keyed by runtime and capability.
 *
 *   node --import tsx packages/scripts/prompt-surface.ts           rewrite docs/prompts/surface.json and docs/prompts/rendered
 *   node --import tsx packages/scripts/prompt-surface.ts --check   fail when either committed snapshot is stale
 *
 * Inventories: native body tools per session variant with their nested app_tool
 * capabilities (`apps/body/src/minimal-tool-surface.ts`), external MCP tools
 * (`apps/server/src/rooms-mcp.ts`, `rooms-mcp-agent.ts`), wake template
 * families with one fixture per branch, and first-party skills
 * (`packages/api-contract/src/beeline-guides.ts`). It never calls a model.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CAPABILITY_TOOLS, agentToolsFor, type ToolDefinition } from '../../apps/body/src/minimal-tool-surface.js';
import { itemPrompt, resumePrompt } from '../../apps/body/src/place-prompt.js';
import { renderMention, renderRules, renderWake } from '../../apps/body/src/session-join/bridge.js';
import type { JoinedSession } from '../../apps/body/src/session-join/store.js';
import type { AgentCommand } from '../api-contract/src/daemon-operations.js';
import { generatedThreadRenamePrompt } from '../api-contract/src/corner-text.js';
import { mentionRouting } from '../../apps/server/src/owed-mentions.js';
import { loadCases, loadSource } from './prompt-cases.js';
import { beelineManagedSkills } from '../api-contract/src/beeline-guides.js';
import { MCP_AGENT_TOOLS, MCP_OPERATOR_TOOLS, MCP_RETIRED_TOOLS } from '../../apps/server/src/rooms-mcp-agent.js';
import { mcpWakeText } from '../../apps/server/src/rooms-mcp-events.js';
import { INSTRUCTIONS, ROOM_TOOLS } from '../../apps/server/src/rooms-mcp.js';

const SNAPSHOT = join(resolve(__dirname, '../..'), 'docs', 'prompts', 'surface.json');
/** What `npm run prompt-audit` renders, so a prompt change shows its full message diff. */
const RENDERED = join(resolve(__dirname, '../..'), 'docs', 'prompts', 'rendered');

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
const MCP_WAKE_BRANCHES: Record<string, [reason: string, ask?: unknown]> = {
  tag: ['human_tag'], message: ['message'], reply: ['reply'], 'reply-with-ask': ['reply', {question:'<question>',options:['<option>','<option>']}], order: ['order'],
  review: ['corner_review_dispatch'], lifecycle: ['corner_check'], event: ['subscribed_event'],
};
const wakeFixture = (reason: string, ask?: unknown) => mcpWakeText({ id: '<id>', fromName: '<name>', placeName: '<place>',
  from: { agent: '<agent>', place: '<place>' }, reason, ask, text: '<text>' });

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
    mcp: { instructions: INSTRUCTIONS, chat: byName(ROOM_TOOLS), agent: byName(MCP_AGENT_TOOLS), operator: byName(MCP_OPERATOR_TOOLS),
      retired: Object.fromEntries(Object.entries(MCP_RETIRED_TOOLS).sort(([a], [b]) => a.localeCompare(b))) },
    wakes: {
      'mcp-next': Object.fromEntries(Object.entries(MCP_WAKE_BRANCHES).map(([branch, args]) => [branch, wakeFixture(...args)])),
      'body-resume': Object.fromEntries(Object.entries(RESUME_BRANCHES).map(([branch, item]) => [branch, resumePrompt(item)])),
    },
    guides: {
      skills: Object.fromEntries([...new Map(Object.values(guideVariants).flat().map(skill => [skill.name, skill.content])).entries()]
        .sort(([a], [b]) => a.localeCompare(b))),
      variants: Object.fromEntries(Object.entries(guideVariants).map(([name, list]) => [name, list.map(skill => skill.name)])),
    },
  };
}

/** Synthetic situations, assembled by the delivery functions the runtimes use.
 * Keep these separate from replayPrompt's simulated-model instructions. */
export async function renderAuditPrompts() {
  const source = await loadSource(resolve(__dirname, '../..'));
  const cases = loadCases();
  const fixture = (id: string) => {
    const saved = cases.find(testCase => testCase.id === id);
    if (!saved) throw new Error(`Missing prompt case: ${id}`);
    return saved;
  };
  const room = '22222222-2222-4222-8222-222222222222';
  const thread = '33333333-3333-4333-8333-333333333333';
  const id = 'e'.repeat(64);
  const person = fixture('routing-answers-source-message');
  const request = fixture('messaging-b01-finish');
  const checks = fixture('messaging-b05-system-checks');
  const first = fixture('rename-generated-corner');
  const ask = { question: 'Should I use the small batch?', options: ['Small batch', 'Full batch'] };
  const situations = [
    { name: 'person-tag', saved: person, reason: 'human_tag', kind: null, author: 'owner', from: room, place: room,
      text: person.turn.task.body },
    { name: 'agent-request', saved: request, reason: 'message', kind: 'message', author: 'ruby', from: room, place: room,
      text: 'Count the widgets and send me the result.' },
    { name: 'informational-reply', saved: request, reason: 'reply', kind: 'reply', author: 'ruby', from: thread, place: room,
      text: 'The count is 12 widgets.' },
    { name: 'reply-with-ask', saved: request, reason: 'reply', kind: 'reply', author: 'ruby', from: thread, place: room,
      text: 'The count is 12 widgets. Should I use the small batch? Options: Small batch; Full batch.', ask },
    { name: 'check-system-event', saved: checks, reason: 'corner_check', kind: 'lifecycle', author: 'system', from: thread, place: thread,
      text: 'All widget checks passed. No changes or public update are needed.', returnPlace: room },
    { name: 'commander-worker-report', saved: request, reason: 'reply', kind: 'reply', author: 'worker', from: thread, place: room,
      text: 'Done: the widget change is ready for review.' },
    { name: 'fresh-thread-first-turn', saved: first, reason: 'human_tag', kind: null, author: 'owner', from: thread, place: thread,
      text: first.turn.task.body },
  ];
  const names = new Map([['owner', 'Owner'], ['ruby', 'Ruby'], ['worker', 'Worker'], ['system', 'System']]);
  const runner = { node: '/usr/bin/node', bundle: '/audit/usebeeline.mjs' };
  const joined: JoinedSession = { key: 'claude-code:/audit/project', agent: 'claude-code', cwd: '/audit/project',
    name: 'Jellybean', handle: 'jellybean', server: 'https://beeline.invalid', clientId: 'audit-client',
    cursor: '0', deliveredWakes: [], joinedAt: '2026-11-17T00:00:00.000Z' };
  return situations.flatMap(situation => {
    const saved = situation.saved;
    const context = [
      ...(situation.name === 'fresh-thread-first-turn'
        ? [generatedThreadRenamePrompt(saved.turn.generatedTitle as string)] : []),
      ...(saved.session?.brief ? [`Current thread brief, revision 1. It governs this thread; earlier instructions that conflict with it are historical:\n${(saved.session.brief as { spec: string }).spec}`] : []),
      'Members (exact tag spellings):\n- @owner — Owner (person)\n- @ruby — Ruby (agent)\n- @worker — Worker (agent)\nYou are @jellybean, a member here; you are not listed above.',
    ].join('\n\n');
    const command: AgentCommand = { id, roomId: situation.place, roomName: situation.place === thread ? 'widget' : 'Inventory',
      returnRoomId: situation.returnPlace ?? situation.from,
      returnRoomName: (situation.returnPlace ?? situation.from) === thread ? 'widget' : 'Inventory', agentId: 'jellybean',
      sourceMessageId: 'a'.repeat(64), from: { agent: situation.author, place: situation.from }, turnRequestId: id,
      action: 'input', reason: situation.reason, ask: situation.ask, rootCommandId: id, rootSourceMessageId: 'a'.repeat(64),
      agentDepth: situation.author === 'owner' ? 0 : 1, createdAt: 0,
      source: { id: 'a'.repeat(64), type: situation.author === 'system' ? 'system' : 'message', authorId: situation.author,
        body: situation.text, createdAt: 0, attachments: [], conversationContext: context } };
    const session = source.assembly.assembleSessionPrompt({
      ...saved.session, surface: saved.place, agentName: 'Jellybean', agentCommand: 'claude-agent-acp',
      memoryMaxBytes: 32 * 1024 ** 3, squireAvailable: true,
    } as Parameters<typeof source.assembly.assembleSessionPrompt>[0]);
    const mention = { ...mentionRouting(command.agentId, situation.place, command.sourceMessageId, situation.author),
      id: command.sourceMessageId, room_id: situation.place, room_name: command.roomName,
      author_handle: situation.author, author_name: names.get(situation.author), text: situation.text,
      institutionalContext: context, attachments: [], created_at: joined.joinedAt, deliveryCursor: '1', truncated: false };
    const named = { fromName: names.get(situation.author) ?? null, placeName: situation.from === thread ? 'widget' : 'Inventory' };
    const next = mcpWakeText({ id, from: command.from!, ...named, reason: situation.reason, ask: situation.ask, text: situation.text });
    const wake = { id, address: situation.place, from: command.from!, ...named, reason: situation.reason,
      ...(situation.kind ? { kind: situation.kind } : {}), ...(situation.ask ? { ask: situation.ask } : {}),
      text: situation.text, institutionalContext: context, attachments: [], createdAt: joined.joinedAt, next };
    const mcpDelivery = situation.reason === 'human_tag' ? mention : wake;
    return [
      { name: `native/${situation.name}.txt`, text: [session.systemPrompt, itemPrompt(command, { names, fresh: true })].join('\n\n') },
      { name: `mcp/${situation.name}.txt`, text: `${INSTRUCTIONS}\n\n${JSON.stringify(mcpDelivery, null, 2)}` },
      { name: `session-joined/${situation.name}.txt`, text: `${renderRules(joined, runner)}\n\n${situation.reason === 'human_tag'
        ? renderMention(mention) : renderWake(wake, joined, runner)}` },
    ];
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) void (async () => {
  const files = new Map([[SNAPSHOT, `${JSON.stringify(extractSurface(), null, 1)}\n`],
    ...(await renderAuditPrompts()).map(prompt => [join(RENDERED, prompt.name), `${prompt.text}\n`] as const)]);
  if (process.argv.includes('--check')) {
    const committed = readdirSync(RENDERED, { recursive: true, encoding: 'utf8' }).map(path => join(RENDERED, path))
      .filter(path => statSync(path).isFile());
    if ([...files].some(([path, text]) => !existsSync(path) || readFileSync(path, 'utf8') !== text)
      || committed.some(path => !files.has(path))) {
      console.error('docs/prompts/surface.json or docs/prompts/rendered is stale: run node --import tsx packages/scripts/prompt-surface.ts and commit the result.');
      process.exit(1);
    }
  } else {
    rmSync(RENDERED, { recursive: true, force: true });
    for (const [path, text] of files) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  }
})();
