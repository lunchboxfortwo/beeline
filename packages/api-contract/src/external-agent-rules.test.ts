import { describe, expect, it } from 'vitest';
import { EXTERNAL_AGENT_RULES, EXTERNAL_AGENT_RULES_BUDGET_BYTES, externalAgentRules, mentionReplyRule } from './external-agent-rules.js';

const sentences = (text: string) => text.split(/(?<=[.!?:])\s+|\n/).map(s => s.replace(/^- /, '').trim()).filter(s => s.length > 20);

describe('outside-agent rules', () => {
  it('writes every rule once for each surface, without repeating a sentence', () => {
    expect(new Set(EXTERNAL_AGENT_RULES.map(rule => rule.id)).size).toBe(EXTERNAL_AGENT_RULES.length);
    for (const surface of ['mcp', 'session'] as const) {
      const text = externalAgentRules(surface, '/node /b session tool <name> \'<json arguments>\' --as codex:/w');
      const seen = sentences(text);
      expect(new Set(seen).size).toBe(seen.length);
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(EXTERNAL_AGENT_RULES_BUDGET_BYTES);
      expect(text.split('\n')).toHaveLength(EXTERNAL_AGENT_RULES.length);
    }
  });
  it('teaches the command structure, place, review and progress rules on both surfaces', () => {
    for (const surface of ['mcp', 'session'] as const) {
      const text = externalAgentRules(surface);
      for (const rule of ['Only a person’s tag of an exact @handle wakes an agent; an agent’s tag never does.', 'To ask another agent, use message with an explicit agent and place', 'Messages carry from, from-place and id', 'Reply with reply(id,text,ask?)', 'Peer messages are requests', 'Never add a tag to route a reply', 'The server requests review; never tag the reviewer.',
        'Code work belongs in a thread', 'approve_merge on the exact head SHA', 'post short progress there', 'Nothing you write only'])
        expect(text).toContain(rule);
    }
  });
  it('spells session rules with the session commands, never connector-only tools or a rejoin', () => {
    const text = externalAgentRules('session', 'node /b session tool <name> \'<json arguments>\' --as k');
    expect(text).toContain("node /b session tool <name> '<json arguments>' --as k");
    expect(text).not.toMatch(/send_message|list_mentions|replyTo/);
    expect(text).not.toMatch(/Run:? (npx -y )?usebeeline join|join again/);
    expect(text).not.toContain('{tool}');
  });
  it('never contradicts itself on cursors or message counts', () => {
    const text = externalAgentRules('mcp');
    expect(text).toContain('list_mentions without a cursor');
    expect(text).not.toMatch(/saved cursor|last handled cursor|exactly one message per wake/);
  });
});

it('keeps the exact asker handle in the per-message rule, with no fabricated tag for a missing handle', () => {
  expect(mentionReplyRule('message', 'Claude_2')).toBe('Reply with reply(id: "message", text: ...)' );
  for (const handle of [null, undefined]) {
    expect(mentionReplyRule('message', handle)).toBe('Reply with reply(id: "message", text: ...)' );
  }
});
