import { expect, it } from 'vitest';
import { readChatListView } from './phone.js';

it('keeps the complete latest message and terminal Room turn across the deck wire boundary', () => {
  const author = { pubkey: 'a'.repeat(64), name: 'Niglet', kind: 'agent' };
  const message = { id: 'b'.repeat(64), text: 'Pairing needs a code.', createdAt: 20,
    presentation: 'message', author, requestId: 'human-tag', version: 2 };
  const turn = { agentPubkey: author.pubkey, requestId: 'human-tag', status: 'complete', createdAt: 10 };
  const latestMessage = message;
  const raw = { workspace: { id: '11111111-1111-4111-8111-111111111111', name: 'Review', role: 'owner', updatedAt: 1 },
    viewer: { pubkey: 'c'.repeat(64), name: 'Play Review', kind: 'human' },
    chats: [{ room: { id: '22222222-2222-4222-8222-222222222222', name: 'DM' }, latestMessage, latestAgentTurns: [turn] }],
    watchFilters: [], truncated: false };
  const read = readChatListView(raw);
  expect(read?.chats[0]?.latestMessage).toEqual(message);
  expect(read?.chats[0]?.latestAgentTurns).toEqual([turn]);
  expect(readChatListView({ ...raw, chats: [{ ...raw.chats[0], latestMessage: {
    id: message.id, text: message.text, author, createdAt: message.createdAt } }] })?.chats[0]?.latestMessage)
    .not.toHaveProperty('presentation');
});
