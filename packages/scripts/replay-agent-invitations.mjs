// Replay onboarding/product answers with real free/CLI prompt sources and simulated tools.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadCases, loadSource } from './prompt-cases.ts';
import { executeSample } from './prompt-subscription-replay.mjs';

const root = resolve(import.meta.dirname, '../..');
const outputIndex = process.argv.indexOf('--out');
const out = outputIndex < 0 ? join(root, '.beeline-proof/agent-invitations/replay') : resolve(process.argv[outputIndex + 1]);
mkdirSync(out, { recursive: true });
const source = await loadSource(root);
const only = process.argv.indexOf('--only');
const selected = only < 0 ? undefined : process.argv[only + 1]?.split(',');
const modelIndex = process.argv.indexOf('--model');
const model = modelIndex < 0 ? 'gpt-6.1-sol' : process.argv[modelIndex + 1];
const extra = ['tools-connects-service', 'finish-orders-then-ends', 'room-requests-host-grant',
  'memory-rule-05', 'corners-keeps-reviewer-independent'];
const cases = loadCases().filter(c => selected ? selected.includes(c.id) : c.id.startsWith('onboarding-') || extra.includes(c.id));
const rows = [];
for (const testCase of cases) {
  const row = { id: testCase.id, prompt: testCase.session?.freeAgent ? 'free' : 'cli',
    ...await executeSample({ source, testCase, variant: { name: 'full', mode: 'full', core: [] }, model,
      directory: join(out, testCase.id), timeoutMs: 180000 }) };
  rows.push(row);
  writeFileSync(join(out, 'result.json'), JSON.stringify({ model, rows }, null, 2) + '\n');
  console.log(JSON.stringify({ id: row.id, pass: row.pass, status: row.status, error: row.error }));
  if (row.modelStopped) break;
}
if (rows.length !== cases.length || rows.some(row => row.status !== 'behavior' || !row.pass || row.timedOut || row.exitCode !== 0)) process.exitCode = 1;
