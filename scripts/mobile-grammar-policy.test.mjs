import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanGrammarSource } from './mobile-grammar-policy.mjs';
import { grandfatherRegistry, scanUiSource } from './mobile-ui-policy.mjs';

const tamagui = body => `import { YStack, Text } from 'tamagui';\nexport const X = () => ${body};\n`;
const rules = (text, file = 'screens/x.tsx') => scanGrammarSource(file, text).map(e => e.rule);

test('grammar values pass', () => {
  for (const radius of ['transcript', 'viewer']) assert.deepEqual(rules(tamagui(`<YStack borderRadius="${radius}" />`)), []);
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
  for (const prop of ['fontFamily', 'fontWeight']) {
    for (const text of [
      `const style = { ${prop}: chosen };`,
      `const style = { ['${prop}']: chosen };`,
      `const style = { ${prop} };`,
      `style.${prop} = chosen;`,
      `style['${prop}'] = chosen;`,
    ]) assert.deepEqual(rules(text), ['type-scale'], text);
    assert.deepEqual(rules(`const value = style.${prop};`), []);
    assert.deepEqual(rules(`const style = { ${prop}: chosen };`, 'ui/grammar-root.tsx'), []);
    assert.deepEqual(rules(`const style = { ${prop}: chosen };`, 'buzz/groknight.ts'), []);
  }
});

test('loading, sign-in status and empty-state roles cannot opt into stronger type', () => {
  for (const variant of ['heading', 'title', 'listTitle', 'metaStrong', 'code']) {
    assert.ok(rules(`const X = () => <YStack><SurfaceGlyphLoader /><T v="${variant}">Status</T></YStack>;`).includes('role-lock'));
    assert.ok(rules(`const X = () => <SignInCenter><Spinner /><T v="${variant}">Status</T></SignInCenter>;`).includes('role-lock'));
    assert.ok(rules(`function EmptyState({title}) { return <T v="${variant}">{title}</T>; }`).includes('role-lock'));
  }
  assert.deepEqual(rules(`const X = () => <YStack><SurfaceGlyphLoader /><T v="meta">Status</T></YStack>;`), []);
  assert.deepEqual(rules(`const X = () => <SignInCenter><Spinner /><T v="body">Status</T><Copy small quiet>Detail</Copy></SignInCenter>;`), []);
  assert.deepEqual(rules(`function EmptyState({title, description}) { return <YStack><T v="body">{title}</T><T v="meta">{description}</T></YStack>; }`), []);
  assert.ok(rules(`const X = () => <ConnectorLoading><Copy small strong>Status</Copy></ConnectorLoading>;`).includes('role-lock'));
  assert.ok(rules(`const X = () => <YStack><SurfaceGlyphLoader /><T v={chosen}>Status</T></YStack>;`).includes('role-lock'));
});

test('icons come from the approved concept list and retired marks cannot return', () => {
  assert.deepEqual(rules(`import { CornerDownRight as Thread, Hash } from 'lucide-react-native';`), []);
  assert.deepEqual(rules(`import type { LucideProps } from 'lucide-react-native'; export type { LucideProps } from 'lucide-react-native';`), []);
  for (const text of [
    `import { Triangle as CornerDownRight } from 'lucide-react-native';`,
    `import * as Icons from 'lucide-react-native';`,
    `import { CornerGlyph } from './CornerGlyph';`,
    `import { RoomGlyph } from '@/components/buzz/RoomGlyph';`,
    `import { CustomGlyph } from './CustomGlyph';`,
    `import { CustomIcon } from './drawing';`,
    `import { Star } from 'phosphor-react-native';`,
    `export { Star } from 'lucide-react-native';`,
    `const icons = require('lucide-react-native');`,
  ]) assert.ok(rules(text).includes('glyph-lock'), text);
  assert.ok(rules(`import Ionicons from '@expo/vector-icons/Ionicons'; const X = () => <Ionicons name="chatbubble" />;`).includes('glyph-lock'));
  assert.deepEqual(rules(`import Ionicons from '@expo/vector-icons/Ionicons'; const X = () => <Ionicons name="time-outline" />;`), []);
  assert.ok(rules(`import {MessagesSquare} from 'lucide-react-native'; function ChatMark() { return <Glyph icon={MessagesSquare} />; }`).includes('glyph-lock'));
  assert.ok(rules(`import {MessagesSquare} from 'lucide-react-native'; const tabs = [{value:'chats', icon:MessagesSquare}];`).includes('glyph-lock'));
  assert.ok(rules(`import {Hash} from 'lucide-react-native'; function ScheduledWorkWhere() { return <Inked glyph={Hash} />; }`).includes('glyph-lock'));
});

test('colour literals and style escapes fail', () => {
  assert.deepEqual(rules(tamagui(`<YStack testID={'#fff'} />`)), ['colour-literal']);
  assert.deepEqual(rules(tamagui(`<YStack style={{ padding: 3 }} />`)), ['style-escape']);
});

test('every module is in scope, not only Tamagui screens', () => {
  assert.deepEqual(rules(`export const c = '#ffffff';\n`), ['colour-literal']);
  assert.deepEqual(rules(`import { View } from 'react-native';\n`), ['component-lock']);
  assert.deepEqual(rules(`import { StyleSheet } from 'react-native-unistyles';\n`), ['legacy-styles']);
  assert.deepEqual(rules(`export const c = '#ffffff';\n`, 'buzz/groknight.ts'), []);
});

test('spacing that follows Text size uses step() with a grammar step', () => {
  assert.deepEqual(rules(tamagui(`<YStack gap={step('3')} />`)), []);
  assert.deepEqual(rules(tamagui(`<YStack gap={step('7')} />`)), ['off-grammar']);
  assert.deepEqual(rules(tamagui(`<YStack borderRadius={step('3')} />`)), ['off-grammar']);
});

test('spread object props are judged like written props', () => {
  assert.deepEqual(rules(tamagui(`<YStack {...{ style: { padding: 3 } }} />`)), ['style-escape']);
  assert.deepEqual(rules(tamagui(`<YStack {...{ padding: '3' }} />`)), []);
});

test('the UI policy command rejects font, role and glyph overrides in a registered component', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const proofRoot = path.join(root, '.beeline-proof');
  mkdirSync(proofRoot, { recursive: true });
  const sandbox = mkdtempSync(path.join(proofRoot, 'typography-policy-'));
  const file = 'components/Loading.tsx';
  const sources = path.join(sandbox, 'apps/mobile/sources/components');
  const design = path.join(sandbox, 'apps/mobile/design');
  try {
    mkdirSync(sources, { recursive: true });
    mkdirSync(design, { recursive: true });
    for (const [source, expected, rule] of [
      ['export const style = {};', 0],
      ["export const style = { fontFamily: 'system', fontWeight: '900' };", 1, 'type-scale'],
      ['export const Loading = () => <YStack><SurfaceGlyphLoader /><T v="heading">Status</T></YStack>;', 1, 'role-lock'],
      ["import { CornerGlyph } from './CornerGlyph'; export const Loading = () => <CornerGlyph />;", 1, 'glyph-lock'],
    ]) {
      writeFileSync(path.join(sources, 'Loading.tsx'), source);
      writeFileSync(path.join(design, 'ui-component-registry.json'), JSON.stringify(grandfatherRegistry([scanUiSource(source, file)])));
      const result = spawnSync(process.execPath, ['scripts/check-mobile-ui-components.mjs', '--root', sandbox], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, expected, result.stdout + result.stderr);
      if (expected) assert.ok(result.stderr.includes(`[${rule}]`), result.stderr);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
