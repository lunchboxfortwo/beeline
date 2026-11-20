import { expect, it } from 'vitest';
import { ASK_BRIEF_MAX_CHARACTERS, ASK_QUESTION_MAX_CHARACTERS, ASK_TOOL_TEXT, MESSAGE_ASK_SCHEMA, agentMessageText, replyNeeded, validateMessageAsk } from './agent-messaging.js';

it('renders the owner’s message format, with the reply line only when a reply is needed', () => {
  const message = { from: 'Ruby', place: 'beeline', id: 'h374774', text: 'Are you still working?' };
  expect(agentMessageText({ ...message, replyNeeded: true })).toBe(
    'From: Ruby in #beeline\nid: h374774\nReply needed: true\ntext: Are you still working?\nReply(id: h374774, text: ...) with your reply');
  expect(agentMessageText({ ...message, replyNeeded: false })).toBe(
    'From: Ruby in #beeline\nid: h374774\nReply needed: false\ntext: Are you still working?');
  expect(agentMessageText({ ...message, replyNeeded: false, attachments: ['plan.pdf', 'mock.png'] })).toBe(
    'From: Ruby in #beeline\nid: h374774\nReply needed: false\ntext: Are you still working?\nattachment: plan.pdf, mock.png');
});

it('needs a reply for a person’s tag or message, an agent message, and a reply that asks', () => {
  for (const reason of ['human_tag', 'direct_message', 'human_message', 'message', 'order', 'corner_objective', 'resume'])
    expect(replyNeeded(reason, undefined), reason).toBe(true);
  expect(replyNeeded('reply', { question: 'Web or phone?', options: ['Web', 'Phone'] })).toBe(true);
  for (const reason of ['reply', 'report', 'corner_check', 'corner_review_dispatch', 'subscribed_event', 'schedule', null])
    expect(replyNeeded(reason, undefined), String(reason)).toBe(false);
});

// The five real Needs you cards rewritten in the decision-digest research
// (19 Nov): before, the card showed the full post; after, question + brief.
const REWRITES = [
  { beforeChars: 2051, options: ['Open all three', 'Connector only', 'Wait for release'], recommended: 'Open all three',
    question: 'Open threads for the 3 unfixed bugs now?',
    brief: '3 of 19 reported issues have no fix anywhere: 297 connector tags stuck pending (a person was let down), an Android x86_64 launch crash Play may reject, and a sendable empty starter chip. Waiting holds them to the next release.' },
  { beforeChars: 1867, options: ['Newer copy', 'Rebuild from squire', 'Drop it'], recommended: 'Newer copy',
    question: 'Where should the beeline-dashboard repo come from?',
    brief: 'The repo move skipped it, and both old copies now 404, so the dashboard chat has no repo. The newest copy I can reach is squire\'s from 30 Oct (95e5940). Rebuilding from it loses any later work.' },
  { beforeChars: 3129, options: ['All four', 'Only 1-2', 'I\'ll do it'], recommended: 'All four',
    question: 'Ship Squire signup fixes 1-4 as one trusty-squire PR?',
    brief: 'Signups now reach the key page but stall below the 0.6 vote bar. Fixes: merge duplicate-button votes, accept clear winners, accept very clear clicks, click Send code before the inbox. Only 1-2 leaves zro\'s submit and tokenharbor stuck.' },
  { beforeChars: 1110, options: ['Yes, do it', 'I\'ll do it'], recommended: 'Yes, do it',
    question: 'May I create a GitHub classic token on your account through Squire?',
    brief: 'The 0.7.12 publish needs a repo+workflow token; the vaulted one is dead. I create it in Squire\'s signed-in browser and vault it unseen. Doing it yourself takes about 2 minutes. Either way it fails if you lack write access to grunt.' },
  { beforeChars: 1517, options: ['Open it', 'Homepage only', 'Hold'], recommended: 'Open it',
    question: 'Open the chat-icon fix as a #beeline thread?',
    brief: '#grunt shows the repo owner\'s face, not grunt.run\'s foreman, because chat icons skip the repo\'s homepage. Fix: homepage icon first, then a repo file scan, then the owner avatar. Homepage only skips the scan and misses repos with no homepage.' },
];

it.each(REWRITES.map((rewrite, index) => [index + 1, rewrite] as const))('accepts research rewrite %i within both limits', (_, rewrite) => {
  const { beforeChars, ...ask } = rewrite;
  expect(Array.from(ask.question).length).toBeLessThanOrEqual(ASK_QUESTION_MAX_CHARACTERS);
  expect(Array.from(ask.brief).length).toBeLessThanOrEqual(ASK_BRIEF_MAX_CHARACTERS);
  expect(() => validateMessageAsk(ask)).not.toThrow();
  // The former card body could never pass as a brief: it is refused, not clipped.
  expect(() => validateMessageAsk({ ...ask, brief: 'x'.repeat(beforeChars) }))
    .toThrow(`ask.brief is ${beforeChars} characters; the limit is 280. Rewrite it shorter`);
});

it('refuses an over-limit question or brief with the field, its length and the limit', () => {
  const ask = { question: 'Ship it?', brief: 'It is ready.', options: ['Yes', 'No'] };
  expect(() => validateMessageAsk({ ...ask, question: `${'q'.repeat(120)}?` }))
    .toThrow('ask.question is 121 characters; the limit is 120. Rewrite it shorter and send the ask again.');
  expect(() => validateMessageAsk({ ...ask, question: `${'q'.repeat(130)}?`, brief: 'b'.repeat(281) }))
    .toThrow('ask.question is 131 characters; the limit is 120; ask.brief is 281 characters; the limit is 280.');
  // Characters, not UTF-16 units: 280 emoji fit exactly.
  expect(() => validateMessageAsk({ ...ask, brief: '🐝'.repeat(280) })).not.toThrow();
  expect(() => validateMessageAsk({ ...ask, brief: '' })).toThrow('Add ask.brief');
  expect(() => validateMessageAsk({ question: 'Ship it?', options: ['Yes', 'No'] } as never)).toThrow('Add ask.brief');
});

it('states both limits up front in the ask schema and tool text', () => {
  for (const text of [MESSAGE_ASK_SCHEMA.description, ASK_TOOL_TEXT])
    expect(text).toContain('question at most 120 characters, brief at most 280 characters, both counted in characters; an ask over either limit is refused with its counts');
  expect(MESSAGE_ASK_SCHEMA.required).toContain('brief');
});
