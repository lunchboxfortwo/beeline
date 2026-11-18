import { expect, it } from 'vitest';
import { agentMessageText, replyNeeded } from './agent-messaging.js';

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
