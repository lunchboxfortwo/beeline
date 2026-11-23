import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_README = resolve(dirname(fileURLToPath(import.meta.url)), '../../README.md');

export function smokeHelperPackage(tarball, version, { readme = ROOT_README } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'helper-package-smoke-'));
  try {
    const home = join(directory, 'home');
    mkdirSync(home);
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state') };
    const prefix = join(directory, 'install');
    execFileSync('npm', ['install', '--global', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', resolve(tarball)], { env, timeout: 120_000, stdio: 'pipe' });
    const installed = join(prefix, 'lib/node_modules/usebeeline');
    const metadata = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    if (metadata.name !== 'usebeeline' || metadata.version !== version) throw new Error(`Unexpected installed package: ${metadata.name}@${metadata.version}; expected usebeeline@${version}`);
    // npm shows the package README: it must be the GitHub README, byte for byte.
    let packed;
    try { packed = readFileSync(join(installed, 'README.md')); } catch { throw new Error('Package README.md is missing'); }
    if (!packed.equals(readFileSync(readme))) throw new Error('Package README.md differs from the repository README.md');
    // start --help returns before any install, pairing, or daemon operation.
    const output = execFileSync(join(prefix, 'bin/beeline'), ['start', '--help'], { env, timeout: 20_000, encoding: 'utf8' });
    if (!output.includes('beeline start [--all|--agent <public key>]')) throw new Error(`Unexpected CLI help: ${output}`);
    console.log(`Local usebeeline@${version} installed and CLI started successfully`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2] || !process.argv[3]) throw new Error('usage: smoke-helper-package <tarball> <version>');
    smokeHelperPackage(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
