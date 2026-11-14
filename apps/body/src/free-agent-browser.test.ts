import { afterEach, describe, expect, it, vi } from 'vitest';
import { freeAgentModelEnv } from './free-agent-vm.js';
import { agentToolsFor } from './minimal-tool-surface.js';
import { beelineConnectSkillMarkdown, beelineManagedSkills } from './beeline-skill.js';

describe('hosted browser boundary', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('passes Lightpanda selection into the isolated native shell', () => {
    const env = freeAgentModelEnv({ modelToken: 'test-token' });
    expect(env).toContain('AGENT_BROWSER_ENGINE=lightpanda\n');
    expect(env).toContain('AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/lightpanda\n');
    expect(env).toContain('AGENT_BROWSER_SOCKET_DIR=/tmp/beeline-browser\n');
    expect(env).toContain('BEELINE_BODY_AGENT_ENV_PASSTHROUGH=BEELINE_FREE_AGENT_MODEL_TOKEN,AGENT_BROWSER_ENGINE,AGENT_BROWSER_EXECUTABLE_PATH,AGENT_BROWSER_SOCKET_DIR');
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
