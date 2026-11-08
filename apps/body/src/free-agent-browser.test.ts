import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { BodyConfig } from './config.js';
import { freeAgentModelEnv } from './free-agent-vm.js';
import { agentToolsFor } from './minimal-tool-surface.js';
import { beelineConnectSkillMarkdown, beelineManagedSkills } from './beeline-skill.js';
import { sessionGrantedResources } from './room-session.js';

describe('hosted browser boundary', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('passes Lightpanda selection into the isolated native shell', () => {
    const env = freeAgentModelEnv({ modelToken: 'test-token' });
    expect(env).toContain('AGENT_BROWSER_ENGINE=lightpanda\n');
    expect(env).toContain('AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/lightpanda\n');
    expect(env).toContain('AGENT_BROWSER_SOCKET_DIR=/tmp/beeline-browser\n');
    expect(env).toContain('BEELINE_BODY_AGENT_ENV_PASSTHROUGH=BEELINE_FREE_AGENT_MODEL_TOKEN,AGENT_BROWSER_ENGINE,AGENT_BROWSER_EXECUTABLE_PATH,AGENT_BROWSER_SOCKET_DIR');
  });

  it('refuses to remount a persisted Squire grant while preserving other routes and personal agents', async () => {
    const read = async () => ({ grants: ['squire', 'local-tool'].map(target => ({ kind: 'mcp', target, status: 'approved' })) });
    const config = { operatorHome: resolve('nonexistent-browser-fixture'), agentKind: 'pi',
      agentEnv: { BEELINE_FREE_AGENT_MODEL_TOKEN: 'test-token' } } as BodyConfig;
    const hosted = await sessionGrantedResources(config, read as never);
    expect(hosted.hostRoutes).toEqual(['local-tool']);
    const personal = await sessionGrantedResources({ ...config, agentEnv: {} }, read as never);
    expect(personal.hostRoutes).toEqual(['squire', 'local-tool']);
  });

  it('removes Squire setup hints from the hosted catalog and service instructions', () => {
    const tools = agentToolsFor(true, false, false, false, true, true, true, true);
    const connect = tools.find(tool => tool.name === 'connect')!;
    expect(JSON.stringify(connect)).not.toMatch(/Squire|switchGoogleAccount|noApi|signedInUrl/);
    const guide = beelineConnectSkillMarkdown('test', true);
    expect(guide).not.toMatch(/Squire|operate_/);
    expect(guide).toContain('Never retry');
    vi.stubEnv('BEELINE_FREE_AGENT_ID', 'hosted-test');
    expect(beelineManagedSkills('test', { isReviewer: false }).map(skill => skill.content).join('\n')).not.toMatch(/Squire|operate_drive|operate_type/);
    expect(beelineConnectSkillMarkdown('test')).toContain('Trusty Squire');
  });
});
