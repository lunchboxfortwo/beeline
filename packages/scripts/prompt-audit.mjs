// npm run prompt-audit [-- --out /tmp/beeline-prompt-audit]
// Offline rendering only: add --render-only. No model calls or CI threshold.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAuditPrompts } from './prompt-surface.ts';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
if (args.some((arg, i) => !['--out', '--render-only'].includes(arg) && !(outIndex !== -1 && i === outIndex + 1))
  || (outIndex !== -1 && (!args[outIndex + 1] || args[outIndex + 1].startsWith('--')))) {
  throw new Error('Usage: npm run prompt-audit -- [--out <directory outside the checkout>] [--render-only]');
}
const root = fileURLToPath(new URL('../..', import.meta.url));
const out = outIndex === -1 ? mkdtempSync(join(tmpdir(), 'beeline-prompt-audit-')) : resolve(args[outIndex + 1]);
const inside = relative(root, out);
if (!inside || (!inside.startsWith(`..${sep}`) && inside !== '..')) {
  throw new Error('Keep audit output outside the checkout; use a temporary directory.');
}
const prompts = await renderAuditPrompts();
const paths = prompts.map(prompt => {
  const path = join(out, 'prompts', prompt.name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${prompt.text}\n`);
  return path;
});
console.log(`Rendered ${paths.length} prompts in ${join(out, 'prompts')}`);
if (!args.includes('--render-only')) {
  // Install latest in the audit's own temporary environment, never the host's
  // Python or the repository. The dependency-free linter sends no prompt data.
  const run = (command, argv) => {
    const child = spawnSync(command, argv, { stdio: 'inherit' });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`${command} exited ${child.status ?? child.signal}`);
  };
  const env = join(out, 'promptdoctor-env');
  run('python3', ['-m', 'venv', env]);
  const python = join(env, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  run(python, ['-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', 'promptdoctor']);
  const version = spawnSync(python, ['-m', 'promptdoctor', '--version'], { encoding: 'utf8' });
  if (version.error || version.status !== 0) throw version.error ?? new Error(version.stderr);
  // Output-format/length prescriptions and chatbot safety coverage are outside
  // this audit. Keep duplication, vague wording, bloat and conflicting wording.
  const doctor = spawnSync(python, ['-m', 'promptdoctor', '--no-color', '--disable', 'PD101,PD102,PD104,PD105', ...paths],
    { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  if (doctor.error) throw doctor.error;
  if (doctor.status !== 0 && doctor.status !== 1) throw new Error(`promptdoctor exited ${doctor.status ?? doctor.signal}`);
  writeFileSync(join(out, 'promptdoctor.txt'), `${version.stdout}\n${doctor.stdout}`);
  console.log(doctor.stdout);
  console.log(`Advisory findings: ${join(out, 'promptdoctor.txt')}`);
}
console.log('Read every rendered file for contradictions, competing paths, inapplicable instructions and repetition. Quote findings; prefer deleting text.');
