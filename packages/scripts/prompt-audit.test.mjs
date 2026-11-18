import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderAuditPrompts } from './prompt-surface.ts';
import { INSTRUCTIONS } from '../../apps/server/src/rooms-mcp.ts';
import { mcpPendingWakeNext } from '../../apps/server/src/rooms-mcp-events.ts';

test('audit covers every situation in all three runtimes, without replay-controller instructions', async () => {
  const prompts = await renderAuditPrompts();
  const situations = ['person-tag', 'agent-request', 'informational-reply', 'reply-with-ask',
    'check-system-event', 'commander-worker-report', 'fresh-thread-first-turn'];
  assert.deepEqual(prompts.map(prompt => prompt.name).sort(), ['native', 'mcp', 'session-joined']
    .flatMap(runtime => situations.map(situation => `${runtime}/${situation}.txt`)).sort());
  for (const prompt of prompts) {
    assert.doesNotMatch(prompt.text, /Prompt case replay:|You are the agent described below|Return calls:\[\]/);
    assert.match(prompt.text, /commander/);
    if (prompt.name.startsWith('mcp/')) assert.ok(prompt.text.startsWith(INSTRUCTIONS));
    if (prompt.name.endsWith('informational-reply.txt') || prompt.name.endsWith('commander-worker-report.txt')) {
      assert.match(prompt.text, /This reply is information/);
      assert.doesNotMatch(prompt.text, /Reply: .*tool reply/);
    }
    if (prompt.name.endsWith('fresh-thread-first-turn.txt')) {
      assert.match(prompt.text, /corner-7f3a/);
      assert.match(prompt.text, /install_brief/);
    }
  }
  const native = prompts.find(prompt => prompt.name === 'native/check-system-event.txt').text;
  assert.match(native, /Your final reply is posted to Inventory/);
  assert.match(native, /This is background context/);
  const joined = prompts.find(prompt => prompt.name === 'session-joined/reply-with-ask.txt').text;
  assert.match(joined, /Reply: .*tool reply/);
  assert.match(joined, /--as claude-code:\/audit\/project/);
});

test('MCP audit next steps preserve the delivered pending-wake prefix and informational exception', () => {
  assert.match(mcpPendingWakeNext('wake-id', 'lifecycle', 'corner_check'), /^Reply with reply\(wake-id,text\)\. Handle it/);
  assert.match(mcpPendingWakeNext('wake-id', 'reply', 'reply'), /^This reply is information/);
  assert.match(mcpPendingWakeNext('wake-id', 'reply', 'reply', { question: 'Continue?', options: ['Yes', 'No'] }), /^Reply with reply\(wake-id,text\)/);
});
