// R1: run built Body's non-edit mount plan on the executing owner's machine.
// Optional --milo repeats the real reported checkout operations; it never restarts services.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { credentialMaskPaths, sandboxMountPlan, buildBwrapArgv } from '../apps/body/dist/bwrap-sandbox.js';

const operatorHome = homedir();
const runtime = `/run/user/${process.getuid()}`;
const cwd = process.argv.includes('--milo') ? resolve(operatorHome, 'milo-pi-main') : process.cwd();
const plan = sandboxMountPlan({ mode: 'readonly', cwd, operatorHome,
  userRuntimeDir: runtime, maskPaths: credentialMaskPaths(undefined, operatorHome) });
function run(command, args) {
  const wrapped = buildBwrapArgv({ bwrapPath: '/usr/bin/bwrap', plan, cwd, command, args });
  const result = spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8', timeout: 180_000,
    maxBuffer: 1024 * 1024 });
  console.log(`R1 ${command} ${args.join(' ')}: exit ${result.status}`);
  console.log(result.stdout ?? ''); console.log(result.stderr ?? '');
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (process.argv.includes('--milo')) {
  run('/usr/bin/git', ['pull', '--ff-only']);
  run('pnpm', ['install', '--frozen-lockfile']);
  run('pnpm', ['build']);
}
run('/usr/bin/systemctl', ['--user', 'status', 'milo-pi', '--no-pager']);
