import { expect, it } from 'vitest';
import { readChatListView } from './phone.js';

const raw = {
  workspace: { id: '11111111-1111-4111-8111-111111111111', name: 'Beeline Work', role: 'member', updatedAt: 1 },
  viewer: { pubkey: 'c'.repeat(64), name: 'Dan', kind: 'human' },
  chats: [],
  watchFilters: [],
  truncated: false,
};

it('reads the public chats the viewer can join, dropping unreadable rows', () => {
  const launch = { id: '22222222-2222-4222-8222-222222222222', name: 'launch', memberCount: 8 };
  const read = readChatListView({ ...raw, joinable: [launch, { id: 'not-a-uuid', name: 'x', memberCount: 1 },
    { id: '33333333-3333-4333-8333-333333333333', name: 'bad', memberCount: -1 }] });
  expect(read?.joinable).toEqual([launch]);
});

it('leaves joinable absent when an older server omits it', () => {
  expect(readChatListView(raw)).not.toHaveProperty('joinable');
});
