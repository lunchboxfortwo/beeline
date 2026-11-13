import { expect, it } from 'vitest';
import {
  activeChannelAtCursor,
  channelSuggestionCandidates,
  channelSuggestionText,
  filterChannelSuggestions,
  replaceActiveChannel,
} from './channel-suggestions';

const rooms = [{ id: 'r1', name: 'beeline' }, { id: 'r2', name: 'issues-triage' }];
const threads = [
  { id: 't1', name: 'slow-taps-fix', activityAt: 100 },
  { id: 't2', name: 'sending-new-message', activityAt: 300 },
  { id: 't3', name: 'speed-back-to', activityAt: 200 },
];

it('puts this chat\'s threads first, newest activity on top, then the other Rooms', () => {
  const candidates = channelSuggestionCandidates(rooms, { name: 'beeline' }, threads);
  const { matches } = filterChannelSuggestions(candidates, 's');
  expect(matches.map((item) => item.name ?? `#${item.token}`)).toEqual([
    'sending-new-message', 'speed-back-to', 'slow-taps-fix', '#issues-triage',
  ]);
});

it('writes ↳name for a picked thread and #name for a picked Room', () => {
  const [newest, , , room] = channelSuggestionCandidates(rooms, { name: 'beeline' }, threads);
  const text = 'Same cause as #s';
  const active = activeChannelAtCursor(text, text.length)!;
  expect(replaceActiveChannel(text, active, channelSuggestionText(newest!))).toEqual({
    text: 'Same cause as ↳sending-new-message ', cursor: 35,
  });
  expect(channelSuggestionText(room!)).toBe('#beeline');
});
