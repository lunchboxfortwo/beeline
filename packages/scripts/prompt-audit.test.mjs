import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderAuditPrompts } from './prompt-surface.ts';
import { INSTRUCTIONS } from '../../apps/server/src/rooms-mcp.ts';
import { mcpWakeText } from '../../apps/server/src/rooms-mcp-events.ts';

test('audit covers every situation in all three runtimes, without replay-controller instructions', async () => {
  const prompts = await renderAuditPrompts();
  const situations = ['person-tag', 'agent-request', 'informational-reply', 'reply-with-ask',
    'check-system-event', 'commander-worker-report', 'fresh-thread-first-turn'];
  assert.deepEqual(prompts.map(prompt => prompt.name).sort(), ['native', 'mcp', 'session-joined']
    .flatMap(runtime => situations.map(situation => `${runtime}/${situation}.txt`)).sort());
  for (const prompt of prompts) {
    assert.doesNotMatch(prompt.text, /Prompt case replay:|You are the agent described below|Return calls:\[\]/);
    assert.equal(prompt.text.includes('Message other agents only when you need something from them, or when you are replying to something they need.'), !prompt.name.startsWith('native/'), prompt.name);
    assert.doesNotMatch(prompt.text, /Message only|final reply is posted|This reply is information|background context|Reply with reply/, prompt.name);
    if (prompt.name.startsWith('mcp/')) assert.ok(prompt.text.startsWith(INSTRUCTIONS));
    if (prompt.name.endsWith('informational-reply.txt') || prompt.name.endsWith('commander-worker-report.txt')) {
      if (!prompt.name.startsWith('native/')) assert.match(prompt.text, /Reply needed: false/);
      assert.doesNotMatch(prompt.text, /Reply\(id: e{64}/);
    }
    if (prompt.name.endsWith('fresh-thread-first-turn.txt')) {
      assert.match(prompt.text, /corner-7f3a/);
      assert.match(prompt.text, /install_brief/);
    }
  }
  const native = prompts.find(prompt => prompt.name === 'native/check-system-event.txt').text;
  assert.match(native, /^From: System in #widget\nid: a{64}\ntext: All widget checks passed\./m);
  assert.match(prompts.find(prompt => prompt.name === 'native/reply-with-ask.txt').text, /id: a{64}\ntext:/);
  for (const runtime of ['mcp', 'session-joined'])
    assert.match(prompts.find(prompt => prompt.name === `${runtime}/reply-with-ask.txt`).text, /Reply\(id: e{64}, text: \.\.\.\) with your reply/);
  const joined = prompts.find(prompt => prompt.name === 'session-joined/reply-with-ask.txt').text;
  assert.match(joined, /--as claude-code:\/audit\/project/);
});

test('MCP wakes carry the one message format, with a reply line only when a reply is needed', () => {
  const wake = (reason, ask) => mcpWakeText({ id: 'wake-id', fromName: 'Ruby', placeName: 'beeline', from: { agent: 'ruby', place: 'room' },
    reason, ask, text: 'Are you still working?' });
  assert.equal(wake('message'), 'From: Ruby in #beeline\ncommandId: wake-id\nReply needed: true\ntext: Are you still working?\nReply(id: wake-id, text: ...) with your reply');
  for (const reason of ['corner_check', 'reply']) assert.equal(wake(reason), 'From: Ruby in #beeline\ncommandId: wake-id\nReply needed: false\ntext: Are you still working?');
  assert.match(wake('reply', { question: 'Continue?', options: ['Yes', 'No'] }), /\nReply\(id: wake-id, text: \.\.\.\) with your reply$/);
  const tag = mcpWakeText({id:'wake-id', commandId:'wake-id', messageId:'message-id',
    from:{agent:'ruby',place:'room'},reason:'human_tag',text:'Check the build.'});
  assert.match(tag, /messageId: message-id\ncommandId: wake-id/);
  assert.match(tag, /Reply\(id: message-id, text: \.\.\.\)/);
});
