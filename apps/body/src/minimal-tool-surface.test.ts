import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Check } from 'typebox/value';
import { institutionalMemoryKeywords } from '@beeline/api-contract/daemon';
import { agentToolsFor, callAgentTool } from './read-only-mcp.js';
import { advertisedAgentTool, normalizeAgentToolArgs, validateAdvertisedToolInput } from './read-only-mcp-open-poll.js';
import { toolValidationSchema, type ToolDefinition } from './minimal-tool-surface.js';
import { assembleSessionPrompt, PROMPT_SURFACES } from './prompt-assembly.js';

const harnesses = ['claude-agent-acp', 'claude-code-acp', 'codex-acp', 'pi-acp', 'grok', 'buzz-agent', 'cursor-acp-bridge'];
const missingOnClaude = ['request_grant', 'connect', 'app_tool', 'wake', 'remember', 'revise_corner', 'create_work_item', 'set_work_state', 'assign_work_item', 'add_work_note', 'attach_to_work_item'];
const rootCombinators = ['anyOf', 'oneOf', 'allOf'];
const invalidInputs = [
  ['request_grant', { mode: 'request', action: 'Use the requested resource', kind: 'command' }],
  ['connect', { mode: 'ensure', service: 'Linear' }],
  ['app_tool', { app: 'beeline:workflow', args: {} }],
  ['wake', { action: 'create', trigger: 'schedule', title: 'Reminder', prompt: 'x'.repeat(2001) }],
  ['remember', { kind: 'fact', action: 'save', body: 'No sources' }],
  ['revise_corner', { action: 'brief', address: 'child', brief: { spec: 'Change' } }],
] as const;

describe('Beeline tool surface across harnesses', () => {
  it.each(harnesses)('%s receives every tool named by its prompt', agentCommand => {
    for (const surface of PROMPT_SURFACES) {
      const corner = surface.endsWith('corner');
      const tools = agentToolsFor(true, surface === 'dm', corner, surface === 'code-corner', true, true, true);
      // Claude Code can drop a tool whose root schema has a combinator. Pi
      // accepts the same schema: this was Ruby's exact 28 -> 22 discrepancy.
      const accepted = tools.filter(tool => rootCombinators.every(key => !(key in tool.inputSchema)));
      expect(accepted.map(tool => tool.name)).toEqual(tools.map(tool => tool.name));
      expect(accepted.map(tool => tool.name)).toEqual(expect.arrayContaining(missingOnClaude));
      const prompt = assembleSessionPrompt({ surface, agentName: 'Bee', agentCommand }).systemPrompt;
      const inventory = prompt.match(/^Beeline tools: (.+)\.$/m)?.[1]?.replaceAll('`', '').split(/,\s*/);
      const core = agentToolsFor(true, surface === 'dm', corner, surface === 'code-corner', false, true, true);
      expect(inventory).toEqual(core.map(tool => tool.name));
      for (const name of inventory ?? []) expect(accepted.map(tool => tool.name)).toContain(name);
    }
  });

  it.each(invalidInputs)('still rejects invalid %s arguments before any server call', async (name, args) => {
    await expect(callAgentTool(name, args, 'invalid-combination')).rejects.toThrow(name === 'request_grant' || name === 'connect' ? /Supply (action|purpose)/ : /invalid arguments/);
  });

  it('names the field and the limit when a value is too long', async () => {
    await expect(callAgentTool('remember', {
      kind: 'fact', action: 'save', subject_is_requester: false, canonical_key: 'deploy',
      body: 'x'.repeat(201), keywords: ['deploy'], source_message_ids: ['m1'], person_asked: false, confidence: 0.9,
    }, 'too-long-body')).rejects.toThrow(/body: 201 characters; the limit is 200/);
    await expect(callAgentTool('wake', {
      action: 'create', trigger: 'schedule', title: 'Reminder', prompt: 'x'.repeat(2001),
    }, 'too-long-prompt')).rejects.toThrow(/prompt: 2001 characters; the limit is 2000/);
  });

  it('normalizes an oversized corner name and objective before schema validation', async () => {
    const objective = 'word '.repeat(401);
    expect(objective).toHaveLength(2005);
    const args = {
      room: '11111111-1111-4111-8111-111111111111',
      implementer: 'worker',
      name: 'n'.repeat(121),
      objective,
      brief: { spec: 'Build the widget' },
    };
    const savedUrl = process.env.BEELINE_DAEMON_BASE_URL;
    const savedTurn = process.env.BEELINE_TURN_CONTEXT_FILE;
    delete process.env.BEELINE_DAEMON_BASE_URL;
    delete process.env.BEELINE_TURN_CONTEXT_FILE;
    try {
      await callAgentTool('open_corner', args, 'oversized-corner');
      throw new Error('expected the call to stop before a daemon');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/agent tool is missing host context: BEELINE_DAEMON_BASE_URL/);
      expect(message).not.toMatch(/2005 characters/);
      expect(message).not.toMatch(/121 characters; the limit is 120/);
      expect(message).toMatch(/Removed:/);
      expect(message).toMatch(/name was 121 characters; cut to 120/);
      expect(message).toMatch(/objective was 401 words; cut to 24/);
    } finally {
      if (savedUrl === undefined) delete process.env.BEELINE_DAEMON_BASE_URL;
      else process.env.BEELINE_DAEMON_BASE_URL = savedUrl;
      if (savedTurn === undefined) delete process.env.BEELINE_TURN_CONTEXT_FILE;
      else process.env.BEELINE_TURN_CONTEXT_FILE = savedTurn;
    }
  });

  it('saves capital letters and a short word such as ci after fixing them', () => {
    const args = {
      kind: 'fact', action: 'save', subject_is_requester: false, canonical_key: 'deploy',
      body: 'Deploys use ci.', keywords: ['Deploy', 'ci'], source_message_ids: ['m1'], person_asked: false, confidence: 0.9,
    };
    expect(normalizeAgentToolArgs('remember', args).join(' ')).toContain('deploy, ci');
    expect(args.keywords).toEqual(['deploy', 'ci']);
    expect(() => validateAdvertisedToolInput(advertisedAgentTool('remember'), args)).not.toThrow();
    expect(institutionalMemoryKeywords(args.keywords)).toEqual(['deploy', 'ci']);
    const reply = { text: 'Still here.', replyTo: 'not-a-message' };
    expect(normalizeAgentToolArgs('post', reply)).toEqual(['reply link']);
    expect(reply).toEqual({ text: 'Still here.' });
    expect(() => validateAdvertisedToolInput(advertisedAgentTool('post'), reply)).not.toThrow();
  });

  it('retains every field, nested schema and branch rule for Claude without changing the canonical contract', () => {
    for (const tool of agentToolsFor(true, false, false, false, true, true, true)) {
      const canonical = toolValidationSchema(tool.name);
      if (!canonical) continue;
      expect(tool.inputSchema.properties).toEqual(canonical.properties);
      expect(tool.inputSchema.required).toEqual(canonical.required);
      const rules = Object.fromEntries(rootCombinators.filter(key => key in canonical).map(key => [key, canonical[key]]));
      if (Object.keys(rules).length) expect(tool.description).toContain(JSON.stringify(rules));
    }
    const valid = { kind: 'procedure', action: 'save', slug: 'widget', description: 'Build widgets', markdown: 'Steps' };
    expect(Check(toolValidationSchema('remember')!, valid)).toBe(true);
    expect(Check(toolValidationSchema('remember')!, { ...valid, action: 'update' })).toBe(false);
  });

  it('also preserves the fallback repository and scratch tools under Claude schema rules', () => {
    const tools = [...agentToolsFor(false, false), ...agentToolsFor(true, false, false, false, false, true, false)];
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['repository_io', 'scratch_io']));
    for (const tool of tools) {
      for (const key of rootCombinators) expect(tool.inputSchema).not.toHaveProperty(key);
    }
    expect(tools.find(tool => tool.name === 'scratch_io')!.inputSchema.properties).toMatchObject({ action: { enum: ['write', 'image'] } });
  });

  it('serves the same catalog over MCP stdio with Claude-compatible schemas', async () => {
    // Standalone MCP discovery only: no helper, harness, credentials or server.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BEELINE_')));
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./read-only-mcp.ts', import.meta.url))], {
      env: { ...env, BEELINE_MCP_SURFACE: 'agent', BEELINE_NATIVE_IO_PROVEN: '1', BEELINE_GRANT_RUNNER_URL: 'http://127.0.0.1:1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      const requests = [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        ...invalidInputs.map(([name, args], index) => ({ jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: { name, arguments: args } })),
      ];
      child.stdin.end(requests.map(request => JSON.stringify(request)).join('\n') + '\n');
      expect(await closed, stderr).toBe(0);
      const responses = stdout.trim().split('\n').map(line => JSON.parse(line)) as Array<{
        id: number; result: { tools: ToolDefinition[]; isError?: boolean; content?: Array<{ text: string }> };
      }>;
      const tools = responses.find(response => response.id === 1)!.result.tools;
      expect(tools).toEqual(agentToolsFor(true, false, false, false, true, true, true));
      expect(tools.every(tool => rootCombinators.every(key => !(key in tool.inputSchema)))).toBe(true);
      for (let index = 0; index < invalidInputs.length; index++) {
        const response = responses.find(response => response.id === index + 2)!;
        expect(response.result.isError).toBe(true);
        expect(response.result.content?.[0]?.text).toMatch(['request_grant', 'connect'].includes(invalidInputs[index]![0]) ? /Supply (action|purpose)/ : /invalid arguments/);
      }
    } finally {
      child.kill();
    }
  });
});
