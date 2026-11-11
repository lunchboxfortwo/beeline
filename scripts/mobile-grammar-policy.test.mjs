import assert from 'node:assert/strict';
import test from 'node:test';
import { scanGrammarSource } from './mobile-grammar-policy.mjs';

const tamagui = body => `import { YStack, Text } from 'tamagui';\nexport const X = () => ${body};\n`;
const rules = (text, file = 'screens/x.tsx') => scanGrammarSource(file, text).map(e => e.rule);

test('grammar values pass', () => {
  assert.deepEqual(rules(tamagui(`<YStack padding="4" gap={on ? '2' : '3'} borderRadius="md" backgroundColor="raised" minHeight={44} />`)), []);
  assert.deepEqual(rules(tamagui(`<YStack paddingTop="0.5" margin={0} borderColor={on ? 'needsYou' : 'transparent'} minHeight={HEIGHT.primary} />`)), []);
});

test('off-grammar spacing, radius, colour and heights fail', () => {
  assert.deepEqual(rules(tamagui(`<YStack padding="7" />`)), ['off-grammar']);
  assert.deepEqual(rules(tamagui(`<YStack padding={10} />`)), ['off-grammar']);
  assert.deepEqual(rules(tamagui(`<YStack borderRadius={10} />`)), ['off-grammar']);
  assert.deepEqual(rules(tamagui(`<YStack backgroundColor="red" />`)), ['off-grammar']);
  assert.deepEqual(rules(tamagui(`<YStack minHeight={40} />`)), ['off-grammar']);
  assert.deepEqual(rules(tamagui(`<YStack gap={size} />`)), ['off-grammar']);
});

test('type is set only by the grammar', () => {
  assert.deepEqual(rules(tamagui(`<Text fontSize={15} />`)), ['type-scale']);
  assert.deepEqual(rules(tamagui(`<Text fontFamily="SpaceGrotesk-Regular" />`), 'ui/grammar.tsx'), []);
});

test('colour literals and style escapes fail', () => {
  assert.deepEqual(rules(tamagui(`<YStack testID={'#fff'} />`)), ['colour-literal']);
  assert.deepEqual(rules(tamagui(`<YStack style={{ padding: 3 }} />`)), ['style-escape']);
});

test('files that use neither Tamagui nor the grammar are out of scope', () => {
  assert.deepEqual(rules(`export const c = '#ffffff';\n`), []);
});
