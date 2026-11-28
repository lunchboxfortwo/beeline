import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Check } from 'typebox/value';
import { institutionalMemoryKeywords } from '@beeline/api-contract/daemon';
import { agentToolsFor, callAgentTool } from './read-only-mcp.js';
import { advertisedAgentTool, normalizeAgentToolArgs, validateAdvertisedToolInput } from './read-only-mcp-open-poll.js';
import { toolValidationSchema, type ToolDefinition } from './minimal-tool-surface.js';
import { combinationSummary } from './minimal-tool-surface-repository-tools.js';
import { drawAvatarSkillMarkdown } from './draw-avatar-skill.js';
import { beelineManagedSkills } from '@beeline/api-contract/beeline-guides';
import { assembleSessionPrompt, PROMPT_SURFACES } from './prompt-assembly.js';

const harnesses = ['claude-agent-acp', 'claude-code-acp', 'codex-acp', 'pi-acp', 'grok', 'buzz-agent', 'cursor-acp-bridge'];
const missingOnClaude = ['request_grant', 'connect', 'app_tool', 'wake', 'remember', 'revise_thread', 'create_work_item', 'update_work', 'message'];
const rootCombinators = ['anyOf', 'oneOf', 'allOf'];
const invalidInputs = [
  ['request_grant', { mode: 'request', action: 'Use the requested resource', kind: 'command' }],
  ['connect', { mode: 'ensure', service: 'Linear' }],
  ['app_tool', { app: 'beeline:workflow', args: {} }],
  ['wake', { action: 'create', trigger: 'schedule', title: 'Reminder', prompt: 'x'.repeat(2001) }],
  ['remember', { kind: 'fact', action: 'save', body: 'No sources' }],
  ['revise_thread', { action: 'brief', address: 'child', brief: { spec: 'Change' } }],
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
      expect(tools.map(tool => tool.name)).not.toContain('post');
      expect(tools.map(tool => tool.name)).not.toContain('reply');
      if (corner) {
        const facets = tools.find(tool => tool.name === 'read')?.inputSchema.properties as {facet:{enum:string[]}};
        expect(facets.facet.enum).toContain('threads');
        expect(facets.facet.enum).toContain('addresses');
        expect(tools.find(tool => tool.name === 'open_thread')?.inputSchema.required).not.toContain('room');
      }
      const prompt = assembleSessionPrompt({ surface, agentName: 'Bee', agentCommand }).systemPrompt;
      const inventory = prompt.match(/^Beeline tools: (.+)\.$/m)?.[1]?.replaceAll('`', '').split(/,\s*/);
      const core = agentToolsFor(true, surface === 'dm', corner, surface === 'code-corner', false, true, true);
      expect(inventory).toEqual(core.map(tool => tool.name));
      for (const name of inventory ?? []) expect(accepted.map(tool => tool.name)).toContain(name);
    }
  });

  it('advertises reviewer only on thread updates', () => {
    const tools = agentToolsFor(true, false, false, false, true, true, true);
    expect(tools.find(tool => tool.name === 'open_thread')?.inputSchema.properties).not.toHaveProperty('reviewer');
    expect(tools.find(tool => tool.name === 'revise_thread')?.inputSchema.properties).toHaveProperty('reviewer');
  });

  it.each(invalidInputs)('still rejects invalid %s arguments before any server call', async (name, args) => {
    await expect(callAgentTool(name, args, 'invalid-combination')).rejects.toThrow(name === 'request_grant' || name === 'connect' ? /Supply (action|purpose)/ : /invalid arguments/);
  });

  it('explains how to answer when a malformed message call cannot post', async () => {
    await expect(callAgentTool('message', { inReplyTo: 'request', text: 'The test passed.' }, 'bad-reply'))
      .rejects.toThrow('Give the full answer in your final response, or send type "reply" with the full answer in text. The tool posts text immediately.');
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

  it('normalizes an oversized thread name and objective before schema validation', async () => {
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
    delete process.env.BEELINE_DAEMON_BASE_URL;
    try {
      await callAgentTool('open_thread', args, 'oversized-corner');
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
  });

  it('folds fixed feedback certification without exposing its retired tool',()=>{
    const schema=toolValidationSchema('report_feedback')!;
    expect(Check(schema,{action:'fixed',item_ids:['item'],title:'Fix',pr_url:'https://github.com/Beeline-Work/beeline/pull/59'})).toBe(true);
    expect(Check(schema,{category:'bug',summary:'A rough patch'})).toBe(true);
    expect(Check(schema,{action:'fixed'})).toBe(false);
    expect(agentToolsFor(true,false).map(tool=>tool.name)).not.toContain('notify_feedback_fixed');
    expect(agentToolsFor(true,false).map(tool=>tool.name)).not.toContain('send_operator_system_dm');
    expect(agentToolsFor(true,false,false,false,true,true,true,false,true).map(tool=>tool.name))
      .toEqual(expect.arrayContaining(['send_operator_system_dm','read_operator_system_dm']));
  });

  it('retains every field, nested schema and branch rule for Claude without changing the canonical contract', () => {
    for (const tool of agentToolsFor(true, false, false, false, true, true, true)) {
      const canonical = toolValidationSchema(tool.name);
      if (!canonical) continue;
      const { requestId, ...canonicalProperties } = canonical.properties as Record<string, unknown>;
      if (tool.name !== 'message') expect(requestId).toMatchObject({ type: 'string', minLength: 1 });
      expect(tool.inputSchema.properties).toEqual(canonicalProperties);
      expect(tool.inputSchema.properties).not.toHaveProperty('requestId');
      expect(tool.inputSchema.required).toEqual(canonical.required);
      const rules = Object.fromEntries(rootCombinators.filter(key => key in canonical).map(key => [key, canonical[key]]));
      expect(tool.description).not.toContain('Argument combinations');
      expect(tool.description).not.toContain('"anyOf"');
      if (Object.keys(rules).length) expect(tool.description).toContain(combinationSummary(rules));
    }
    const valid = { kind: 'procedure', action: 'save', slug: 'widget', description: 'Build widgets', markdown: 'Steps' };
    expect(Check(toolValidationSchema('remember')!, valid)).toBe(true);
    expect(Check(toolValidationSchema('remember')!, { ...valid, action: 'update' })).toBe(false);
  });

  it('summarizes argument sets in a few words generated from the validated schema', () => {
    const tools = agentToolsFor(true, false, false, false, true, true, true);
    const description = (name: string) => tools.find(tool => tool.name === name)!.description;
    expect(description('request_grant')).toContain('Needs: mode=request: kind,target,reason,action,purpose.');
    expect(description('remember')).toContain('kind=procedure (action=save: slug,description,markdown; action=delete: slug,version,source_message_ids).');
    expect(description('wake')).toContain('action=create (trigger=schedule: title; trigger=event: title,when);');
    expect(description('wake')).toContain('Rules: if trigger=schedule: prompt max 2000 chars.');
    expect(description('revise_thread')).toContain('if action=metadata: name,no brief;');
    expect(description('report_feedback')).toContain('Needs: category,summary,no action; action=fixed: item_ids,title,pr_url.');
    expect(description('app_tool')).toContain('Needs: no tool/args/arguments; tool,args; tool,arguments.');
    // An unfamiliar branch shape keeps its full JSON rather than losing a rule.
    expect(combinationSummary({ anyOf: [{ minProperties: 2 }] })).toBe('Needs: {"minProperties":2}.');
    // All nine summaries together stay well under the raw JSON they replace.
    const summaries = [...agentToolsFor(false, false), ...tools, ...agentToolsFor(true, false, false, false, false, true, false)]
      .filter((tool, index, all) => all.findIndex(other => other.name === tool.name) === index)
      .map(tool => combinationSummary(toolValidationSchema(tool.name) ?? {})).filter(Boolean);
    expect(summaries).toHaveLength(9);
    expect(Buffer.byteLength(summaries.join(' '))).toBeLessThan(1210);
  });

  it('accepts and checks an unadvertised requestId on every tool but message', () => {
    const tool = advertisedAgentTool('wake');
    const args = { action: 'pause', scheduleId: 'sched-1' };
    expect(() => validateAdvertisedToolInput(tool, { ...args, requestId: 'req-1' })).not.toThrow();
    expect(() => validateAdvertisedToolInput(tool, { ...args, requestId: '' })).toThrow(/invalid arguments/);
    expect(() => validateAdvertisedToolInput(tool, { ...args, requestId: 7 })).toThrow(/invalid arguments/);
    expect(() => validateAdvertisedToolInput(advertisedAgentTool('message'), { type: 'reply', quoteMsgId: 'q1', text: 'Done', requestId: 'req-1' })).toThrow(/message: invalid arguments/);
    expect(() => validateAdvertisedToolInput(advertisedAgentTool('message'), { type: 'reply', quoteMsgId: 'q1', text: 'Done' })).not.toThrow();
  });

  it('names only live tools and fields in managed skills, schemas and prompts', () => {
    const tools = agentToolsFor(true, false, true, true, true, true, false);
    const surface = [
      drawAvatarSkillMarkdown('test'), ...beelineManagedSkills('test', { isReviewer: true }).map(skill => skill.content), JSON.stringify(tools),
      ...PROMPT_SURFACES.map(surface => assembleSessionPrompt({ surface, agentName: 'Bee', agentCommand: 'claude-agent-acp' }).systemPrompt),
    ].join('\n');
    for (const stale of ['get_avatar', 'start_workflow', 'request_grant(action:', 'open_thread(chat', 'report_feedback(category:bug']) expect(surface).not.toContain(stale);
    expect(surface).toContain('app_tool(app:"beeline:avatar", tool:"read", args:{})');
    expect(surface).toContain('request_grant(mode:"request", kind, target, action, purpose, reason)');
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
        ...invalidInputs.map(([name, args], index) => ({ jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: { name, arguments: { ...args, requestId: 'req-1' } } })),
        { jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'wake', arguments: { action: 'pause', scheduleId: 'sched-1', requestId: 'req-1' } } },
        { jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'wake', arguments: { action: 'pause', scheduleId: 'sched-1', requestId: 7 } } },
      ];
      child.stdin.end(requests.map(request => JSON.stringify(request)).join('\n') + '\n');
      expect(await closed, stderr).toBe(0);
      const responses = stdout.trim().split('\n').map(line => JSON.parse(line)) as Array<{
        id: number; result: { tools: ToolDefinition[]; isError?: boolean; content?: Array<{ text: string }> };
      }>;
      const tools = responses.find(response => response.id === 1)!.result.tools;
      expect(tools).toEqual(agentToolsFor(true, false, false, false, true, true, true));
      expect(tools.every(tool => rootCombinators.every(key => !(key in tool.inputSchema)))).toBe(true);
      expect(tools.filter(tool => 'requestId' in (tool.inputSchema.properties as object)).map(tool => tool.name)).toEqual([]);
      // A valid call carrying requestId passes validation and stops only at the missing host.
      const accepted = responses.find(response => response.id === 100)!.result.content?.[0]?.text;
      expect(accepted).not.toMatch(/invalid arguments|unknown fields/);
      expect(responses.find(response => response.id === 101)!.result.content?.[0]?.text).toMatch(/wake: invalid arguments/);
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
