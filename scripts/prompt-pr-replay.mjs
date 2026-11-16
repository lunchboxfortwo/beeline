/** Run in the assigned Beeline agent's corner, never in GitHub Actions. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadCases, loadSource } from './prompt-cases.ts';
import { executeSample } from './prompt-subscription-replay.mjs';
import { needsSquire } from './prompt-nightly.mjs';

const ROOT = resolve(import.meta.dirname, '..');
export const MODEL_PINS = { small: 'gpt-6-luna', large: 'gpt-6.1-sol' };
export const SAMPLES = 3;
const variant = { name: 'full', mode: 'full', core: [], promptEdits: [], appendRules: '' };
const cell = value => String(value ?? '').replace(/[|\r\n]/g, ' ').slice(0, 250);
export function verdict(result) {
  const eligible = result.rows.filter(row => row.status !== 'skipped:squire');
  return eligible.length > 0 && eligible.length === result.expected && eligible.every(row => row.pass === true &&
    row.samples?.length===SAMPLES && row.samples.every(sample=>sample.pass===true)) && !result.error;
}
export function markdown(result) {
  return [`<!-- beeline-prompt-replay:${result.head} -->`,
    `**Prompt replay: ${verdict(result) ? 'PASS' : 'FAIL'}**`, '',
    `Head: \`${result.head}\` · subscription pins: ${Object.entries(MODEL_PINS).map(([size,model])=>`${size}=\`${model}\``).join(', ')}`,
    'Three fresh samples per case per model; all three must pass. Assertions use tool calls and plain text checks, with no model grader. Simulated tools only.',
    ...(result.error ? ['', `Replay error: ${cell(result.error)}`] : []), '',
    '| Case | Model | Samples | Result | Detail |', '| --- | --- | --- | --- | --- |',
    ...result.rows.map(row => `| ${cell(row.id)} | ${cell(row.model)} | ${row.samples?.filter(sample=>sample.pass).length ?? 0}/3 | ${row.status === 'skipped:squire' ? 'SKIP' : row.pass ? 'PASS' : 'FAIL'} | ${cell(row.reason)} |`), '',
    `${result.rows.filter(row => row.pass).length}/${result.expected} eligible cases passed; ${result.rows.filter(row => row.status === 'skipped:squire').length} browser cases skipped.`,
  ].join('\n');
}
export function liveHead(repository, number) {
  // gh-axi renders scalar responses in an api_response envelope. Request only
  // fixed-format state/hash, avoiding assumptions about its object formatter.
  const output = execFileSync('gh-axi', ['api', `repos/${repository}/pulls/${number}`,
    '--template', '{{.state}} {{.head.sha}}'], { encoding: 'utf8' });
  const match = output.match(/\b(open|closed) ([a-f0-9]{40})\b/);
  if (!match) throw new Error('Could not read live PR head');
  return { state: match[1], head: match[2] };
}
export async function replay({ repository, number, head, agent = 'subscription', out, sourceRoot = ROOT, only }, dependencies = {}) {
  if (repository !== 'Beeline-Work/beeline' || !Number.isSafeInteger(number) || number < 1 ||
      !/^[a-f0-9]{40}$/.test(head)) throw new Error('Expected Beeline PR and exact head');
  const current = dependencies.liveHead ?? liveHead;
  const isCurrent = () => { const live = current(repository, number); return live.state === 'open' && live.head === head; };
  if (!isCurrent()) return { status: 'superseded' };
  const checkout = dependencies.checkout ?? (() => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim());
  if (checkout() !== head) throw new Error('Checkout is not the requested PR head');
  mkdirSync(out, { recursive: true });
  const cases = (dependencies.loadCases ?? loadCases)().filter(testCase=>!only || testCase.id.startsWith(only));
  const result = { repository, number, head, agent, models: MODEL_PINS, expected: cases.filter(c => !needsSquire(c)).length * Object.keys(MODEL_PINS).length, rows: [] };
  const save = () => {
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    writeFileSync(join(out, 'verdict.md'), markdown(result) + '\n');
  };
  save();
  try {
    const source = await (dependencies.loadSource ?? loadSource)(sourceRoot);
    for (const model of Object.values(MODEL_PINS)) for (const testCase of cases) {
      if (needsSquire(testCase)) result.rows.push({ id: testCase.id, model, status: 'skipped:squire', reason: 'Requires a real browser session' });
      else {
        const samples=[];
        for (let sampleIndex=0;sampleIndex<SAMPLES;sampleIndex++) {
          try {
            const sample=await (dependencies.executeSample ?? executeSample)({source,testCase,variant,model,
              seed:1000+sampleIndex,directory:join(out,model,testCase.id,String(sampleIndex+1))});
            const pass=sample.status==='behavior' && sample.pass===true && !sample.timedOut && sample.exitCode===0;
            samples.push({pass,status:sample.status,reason:sample.error || sample.reason || (pass?'':'Incomplete model sample')});
          } catch(error) { samples.push({pass:false,status:'incomplete',reason:error.message}); }
          save();
        }
        result.rows.push({id:testCase.id,model,samples,status:'behavior',pass:samples.every(sample=>sample.pass),
          reason:samples.flatMap((sample,index)=>sample.pass?[]:[`sample ${index+1}: ${sample.reason}`]).join('; ')});
      }
      save();
    }
  } catch (error) { result.error = error.message; }
  // Every model/case pair has an explicit row, including infrastructure failures.
  for (const model of Object.values(MODEL_PINS)) for (const testCase of cases)
    if (!result.rows.some(row=>row.id===testCase.id && row.model===model))
      result.rows.push({id:testCase.id,model,pass:false,status:'incomplete',reason:result.error});
  save();
  if (!isCurrent()) return { status: 'superseded', result };
  const publish = dependencies.publish ?? (() => execFileSync('gh-axi', ['pr', 'comment', String(number),
    '--repo', repository, '--body-file', join(out, 'verdict.md')], { encoding: 'utf8' }));
  publish();
  return { status: verdict(result) ? 'pass' : 'fail', result };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  replay({ repository: option('--repository'), number: Number(option('--number')), head: option('--head'),
    agent: option('--agent'), only:option('--only'), out: resolve(option('--out') ?? '.beeline-proof/prompt-pr-replay') })
    .then(result => { console.log(result.status); process.exitCode = result.status === 'fail' ? 1 : 0; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
