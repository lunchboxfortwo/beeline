import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanGrammarTree } from './mobile-grammar-policy.mjs';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const errors = scanGrammarTree(root);
for (const error of errors) console.error(`apps/mobile/sources/${error.file}:${error.line} [${error.rule}] ${error.message}`);
if (errors.length) {
  console.error(`Design grammar check failed: ${errors.length} off-grammar value(s). Use the tokens, type styles, spacing steps, radii and control heights in apps/mobile/sources/ui/grammar.tsx.`);
  process.exitCode = 1;
} else console.log('Design grammar check passed.');
