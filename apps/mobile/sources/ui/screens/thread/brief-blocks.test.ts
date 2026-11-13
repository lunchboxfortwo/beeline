import { expect, it } from 'vitest';
import { briefBlocks, briefSpans } from './brief-blocks';

it('reads a spec as title, paragraphs, headings and bullets', () => {
  expect(briefBlocks([
    '# Reconnect keeps place',
    'When the live connection drops and returns,',
    'the transcript keeps **the message** in place.',
    '',
    '## Done when',
    '- A reconnect while reading history leaves it where it was.',
    '* A reconnect at the bottom still follows new messages.',
    '# Second level one',
    '```',
    'const a = 1;',
    '```',
    'See [the PR](https://example.com).',
  ].join('\n'))).toEqual([
    { kind: 'title', text: 'Reconnect keeps place' },
    { kind: 'paragraph', text: 'When the live connection drops and returns, the transcript keeps the message in place.' },
    { kind: 'heading', text: 'Done when' },
    { kind: 'bullet', text: 'A reconnect while reading history leaves it where it was.' },
    { kind: 'bullet', text: 'A reconnect at the bottom still follows new messages.' },
    { kind: 'heading', text: 'Second level one' },
    { kind: 'code', text: 'const a = 1;' },
    { kind: 'paragraph', text: 'See the PR.' },
  ]);
});

it('keeps inline code as its own spans', () => {
  expect(briefSpans('Edit `Transcript.tsx` and `live.ts` only')).toEqual([
    { code: false, text: 'Edit ' }, { code: true, text: 'Transcript.tsx' }, { code: false, text: ' and ' },
    { code: true, text: 'live.ts' }, { code: false, text: ' only' },
  ]);
});
