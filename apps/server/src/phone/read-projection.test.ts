import { expect, it } from 'vitest';
import { projectedMessage } from './read-projection.js';
import type { MessageRow } from './types.js';

it('W15 projects historical opening cards as threads without changing names or person-authored text', () => {
  const row: MessageRow = {
    id: 'message', room_id: 'room', author_id: 'person', author_kind: 'human', author_name: 'Maya',
    author_handle: null, author_avatar: null, author_face: null, text: 'Maya opened a corner corner-case',
    presentation: 'card', attachments: [], tagged_ids: [], reply_to_message_id: null,
    root_message_id: null, request_id: null, turn_id: null, agent_model: null, activity: null,
    durable_fact: null, card_type: 'daemon-fact', card: { type: 'corner-open', cornerId: 'thread', name: 'corner-case' },
    system_event: { subject: { kind: 'person', name: 'Maya' }, verb: 'opened a corner', object: { text: 'corner-case', id: 'thread' } },
    created_at: new Date(),
  };
  const projected = projectedMessage(row, 'https://example.com');
  expect(projected.text).toBe('Maya opened a thread corner-case');
  expect(projected.systemEvent?.verb).toBe('opened a thread');
  expect(row.system_event?.verb).toBe('opened a corner');
  expect(projectedMessage({ ...row, presentation: 'message', card_type: null, card: null, system_event: null }, 'https://example.com').text)
    .toBe(row.text);
});
