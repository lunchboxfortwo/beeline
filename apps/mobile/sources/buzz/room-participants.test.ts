import { expect, it, vi } from 'vitest';
import { hasChannelMentionToken } from './room-participants';

it.each([
  ['hello @channel', true], ['＠ＣＨＡＮＮＥＬ', true], ['(@CHANNEL!)', true],
  ['@channel...', true], ['@channel-- ', true], ['mail@channel', false],
  ['@channels', false], ['@channel_name', false], ['@channel.other', false],
  ['@channel..other', false], ['é@channel', false], ['@channelé', false],
  ['@channel.other then @channel', true],
])('recognizes the reserved broadcast in %s', (text, expected) => {
  expect(hasChannelMentionToken(text)).toBe(expected);
});

it('does not tokenize every member mention to find a broadcast', () => {
  const scan = vi.spyOn(String.prototype, 'matchAll');
  try {
    expect(hasChannelMentionToken('@alice @bob ordinary prose')).toBe(false);
    expect(hasChannelMentionToken('@alice @channel')).toBe(true);
    expect(scan).not.toHaveBeenCalled();
  } finally { scan.mockRestore(); }
});
