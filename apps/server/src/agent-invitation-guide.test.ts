import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_INVITATION_PATHS, AGENT_INVITATION_PROMPT, ASSISTANT_INVITATION_STEPS,
  BEELINE_ROOMS_MCP_URL, BEELINE_INVITATION_GUIDE_URL, AGENT_INVITATION_OTHER_STARTS, agentInvitationJoinLine, agentInvitationPickerGuide, agentInvitationGuide } from '@beeline/api-contract/agent-invitation-guide';
import { currentFreeAgentInstructions, FREE_AGENT_APP_CONNECT_GUIDE } from './free-agents.js';
import { beelineConnectSkillMarkdown } from '@beeline/api-contract/beeline-guides';

describe('agent invitation concordance', () => {
  it('replaces saved generic instructions with the same on-demand route used by CLI skills', () => {
    const old = 'Soul stays.\n\nOffer help bringing their own agent only on real triggers: at most one.\n\nWhen they accept, guide them to a computer.\n\nFor Grok/xAI add the bare host; directory listing pending.';
    const current = currentFreeAgentInstructions(old);
    expect(current).toContain('Soul stays.');
    expect(current).not.toMatch(/directory listing|only on real triggers|When they accept/);
    expect(current.split(AGENT_INVITATION_PROMPT)).toHaveLength(2);
    expect(currentFreeAgentInstructions(current)).toBe(current);
    expect(FREE_AGENT_APP_CONNECT_GUIDE).toBe(AGENT_INVITATION_PROMPT);
    for (const freeAgent of [false, true])
      expect(beelineConnectSkillMarkdown('test', freeAgent).split(AGENT_INVITATION_PROMPT)).toHaveLength(2);
    for (const path of ['free-agents.ts', 'daemon/apps.ts']) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(source).not.toContain('https://join.usebeeline.app');
    }
  });

  it('pins the exact on-demand answer for every assistant and all shipped invitation paths', () => {
    expect(Object.keys(AGENT_INVITATION_PATHS)).toEqual(['connector', 'session', 'helper']);
    for (const [assistant, steps] of Object.entries(ASSISTANT_INVITATION_STEPS)) {
      const answer = agentInvitationGuide(assistant)!;
      expect(answer).toContain(steps);
      if (assistant !== 'codex') {
        for (const path of Object.values(AGENT_INVITATION_PATHS)) expect(answer).toContain(path);
        expect(answer).toContain(BEELINE_ROOMS_MCP_URL);
      }
      expect(answer).not.toContain('directory listing');
      for (const url of answer.match(/https:\/\/join\.usebeeline\.app[^\s,]*/g) ?? [])
        expect([BEELINE_ROOMS_MCP_URL, 'https://join.usebeeline.app/']).toContain(url.replace(/\.$/, ''));
    }
    // Unverified Grok chat/Business menus are source-concordant candidates, not pinned supported paths.
    expect(ASSISTANT_INVITATION_STEPS.grok).toContain('unverified live');
    expect(ASSISTANT_INVITATION_STEPS['grok business']).toContain('unverified live');
    expect(Object.fromEntries(Object.keys(ASSISTANT_INVITATION_STEPS).filter(key => !['grok', 'grok business'].includes(key)).map(key => [key, agentInvitationGuide(key)])))
      .toMatchSnapshot();
    expect(agentInvitationGuide('Shopify')).toBeUndefined();
    expect(agentInvitationGuide('X-AI')).toBe(agentInvitationGuide('grok'));
    expect(agentInvitationGuide('Claude-Code')).toBe(agentInvitationGuide('claude code'));
    expect(agentInvitationGuide('Gemini CLI')).toContain(AGENT_INVITATION_PATHS.session);
  });

  it('states plan exclusions before ChatGPT steps and keeps mobile creation separate from use', () => {
    for (const host of ['pi', 'opencode', 'hermes', 'zcode']) {
      const answer = agentInvitationGuide(host)!;
      expect(answer).toContain('Replies on demand only; new tags do not wake this session.');
    }
    expect(AGENT_INVITATION_PATHS.session).toContain('Automatic wakes require a proved local receiver for Codex, Claude Code or Antigravity.');
    const codex = agentInvitationGuide('codex')!;
    expect(codex).toContain('existing running Linux CLI session');
    expect(codex).toContain('Mac CLI, phone app, browser, Codex cloud and managed-helper connect path: not verified');
    expect(codex).toContain('approve its sign-in link on any device, including a phone');
    expect(codex).not.toContain(BEELINE_ROOMS_MCP_URL);
    expect(codex).not.toContain('No phone-local CLI');
    expect(agentInvitationJoinLine('codex')).toBe(ASSISTANT_INVITATION_STEPS.codex);
    const chatgpt = ASSISTANT_INVITATION_STEPS.chatgpt;
    expect(chatgpt).toContain('that existing connection can reply');
    expect(chatgpt).toContain('proves neither fresh creation eligibility nor automatic wakes');
    expect(AGENT_INVITATION_OTHER_STARTS).not.toContain('cannot reply here');
    expect(AGENT_INVITATION_OTHER_STARTS).toContain('Existing integrations may reply when send_message is exposed and proved');
    expect(chatgpt.indexOf('not available on your plan')).toBeLessThan(chatgpt.indexOf('Plugins →'));
    expect(ASSISTANT_INVITATION_STEPS.gemini).toContain('US, English, personal Google account');
    expect(ASSISTANT_INVITATION_STEPS.gemini).toContain('Native iPhone/Android creation: no route');
    expect(ASSISTANT_INVITATION_STEPS['grok bot']).not.toContain('Settings → Connectors');
    expect(ASSISTANT_INVITATION_STEPS['grok cli']).toContain('join --host grok --name my-grok');
    expect(ASSISTANT_INVITATION_STEPS.muse).toContain('only if the form asks');
    expect(AGENT_INVITATION_PATHS.connector).toContain('That agent checks');
    expect(AGENT_INVITATION_PATHS.connector).not.toContain('list_chats');
  });

  it('gives every phone picker tile the correct path and guide instead of a bare host', () => {
    const connector = ['grok bot', 'muse', 'claude', 'gemini'];
    const session = ['codex', 'opencode', 'pi', 'hermes', 'zcode'];
    for (const name of connector) expect(agentInvitationJoinLine(name)).toContain(BEELINE_ROOMS_MCP_URL);
    for (const name of session) expect(agentInvitationJoinLine(name)).toContain('npx -y usebeeline@latest join');
    for (const name of [...connector, ...session]) {
      if (name !== 'codex') expect(agentInvitationJoinLine(name)).toContain(BEELINE_INVITATION_GUIDE_URL + '#');
      expect(agentInvitationGuide(name)).toBeDefined();
    }
    expect(AGENT_INVITATION_OTHER_STARTS).toContain('documented Pro creation is read/fetch only');
    expect(AGENT_INVITATION_OTHER_STARTS).toContain('Cursor and Goose: from "Invite an external agent", tap "Back" to "Add an agent", then tap "Create a new agent"');
    expect(AGENT_INVITATION_OTHER_STARTS).not.toContain('below');
    expect(AGENT_INVITATION_OTHER_STARTS).toMatchSnapshot();
    const picker = readFileSync(new URL('../../mobile/sources/ui/screens/people/AddAgentSheet.tsx', import.meta.url), 'utf8');
    expect(picker).not.toContain('Join my Beeline Room: join.usebeeline.app');
    expect(picker).not.toContain('invitationGuide.other');
    expect(picker).not.toContain('agentInvitationJoinLine');
    expect(picker).not.toContain('join.usebeeline.app');
    expect(picker).toContain('invitationGuide?.prompt');
    const projected = agentInvitationPickerGuide();
    expect(projected.prompt).toBe('Join Beeline at join.usebeeline.app');
    expect(projected.listUrl).toBe(BEELINE_INVITATION_GUIDE_URL);
    for (const name of [...connector, ...session]) expect(projected.lines[name === 'grok bot' ? 'grok' : name]).toBe(agentInvitationJoinLine(name));
    expect(Object.fromEntries([...connector, ...session].map(name => [name, agentInvitationJoinLine(name)]))).toMatchSnapshot();
  });

  it('publishes the same assistant and path facts on both public join pages', () => {
    const matrix = readFileSync(new URL('../../../docs/agent-invitation-matrix.md', import.meta.url), 'utf8');
    for (const text of [...Object.values(ASSISTANT_INVITATION_STEPS), ...Object.values(AGENT_INVITATION_PATHS)]) expect(matrix).toContain(text);
    const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    for (const path of ['../assets/mcp/join.html', '../../../web/connect/index.html']) {
      const html = readFileSync(new URL(path, import.meta.url), 'utf8');
      for (const text of [...Object.values(ASSISTANT_INVITATION_STEPS), ...Object.values(AGENT_INVITATION_PATHS)])
        expect(html, 'Refresh public copy: node --import tsx scripts/generate-agent-invitation-guides.mjs').toContain(escape(text));
    }
  });
});
