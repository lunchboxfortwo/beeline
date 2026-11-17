import { expect, it } from 'vitest';
import { boundReplyExcerpt } from './reply-context.js';

it.each(['', '  Keep this whole.\n', 'x'.repeat(1500)])('keeps a short reply parent whole (%#)', text => {
  expect(boundReplyExcerpt(text)).toBe(text);
});

it.each([1501, 16000])('keeps the first and last 750 characters of a %i-character reply parent', length => {
  const start = 'Start: ', end = 'Want me to open a thread for that? End.';
  const text = start + 'x'.repeat(length - start.length - end.length) + end;
  expect(text).toHaveLength(length);
  expect(boundReplyExcerpt(text)).toBe(`${text.slice(0, 750)}…${text.slice(-750)}`);
});
