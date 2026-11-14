const { test } = require('node:test');
const assert = require('node:assert/strict');
const { transformSync } = require('@babel/core');
const plugin = require('./direct-lucide-imports.cjs');

test('named icons and package aliases resolve through public per-icon modules', () => {
  const result = transformSync("import { Check, MoreHorizontal as Menu, Copy as CopyIcon } from 'lucide-react-native';", {
    configFile: false, babelrc: false, plugins: [plugin],
  }).code;
  assert.match(result, /import Check from "lucide-react-native\/icons\/check"/);
  assert.match(result, /import Menu from "lucide-react-native\/icons\/ellipsis"/);
  assert.match(result, /import CopyIcon from "lucide-react-native\/icons\/copy"/);
  assert.doesNotMatch(result, /from ['"]lucide-react-native['"]/);
});

test('namespace and non-icon imports preserve their package contract', () => {
  const source = "import * as Icons from 'lucide-react-native'; import { createLucideIcon } from 'lucide-react-native'; import 'lucide-react-native';";
  const result = transformSync(source, { configFile: false, babelrc: false, plugins: [plugin] }).code;
  assert.match(result, /import \* as Icons from 'lucide-react-native'/);
  assert.match(result, /import \{ createLucideIcon \} from 'lucide-react-native'/);
  assert.match(result, /import 'lucide-react-native'/);
});
