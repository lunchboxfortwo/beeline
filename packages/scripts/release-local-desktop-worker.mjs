// Runs the committed Desktop job on a source archive, with local-only artifacts.
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LocalActions } from './release-local-actions.mjs';
import { Processes, privateWrite } from './release-local-process.mjs';

export function desktopBuildEnvironment({ directory, cargoHome, home }) {
  return { CARGO_BUILD_JOBS: '2', CI_TEST_WORKERS: '2', BEELINE_LOCAL_RELEASE: 'true', CARGO_HOME: cargoHome,
    RUSTUP_HOME: join(directory, 'tools/rustup'), NPM_CONFIG_USERCONFIG: join(home, '.npmrc') };
}

export function macSigningTools(directory, commands = { security: '/usr/bin/security', codesign: '/usr/bin/codesign' }) {
  for (const [name, command] of Object.entries(commands)) {
    const path = join(directory, name);
    // Apple Security.framework resolves identities through the operator's HOME.
    // Only these OS tools receive it; the build and npm keep their private HOME.
    privateWrite(path, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst result=spawnSync(${JSON.stringify(command)},process.argv.slice(2),{env:{...process.env,HOME:process.env.BEELINE_OPERATOR_HOME},stdio:'inherit'});\nif(result.error){console.error(result.error.message);process.exit(1);}\nprocess.exit(result.status??1);\n`);
    chmodSync(path, 0o700);
  }
  return directory;
}

export function desktopSigningStep(step) {
  if (step.name !== 'Materialize the macOS signing credentials') return step;
  return { ...step, run: step.run
    .replace('keychain_path="$RUNNER_TEMP/build.keychain"', 'keychain_path="$RUNNER_TEMP/build.keychain-db"')
    .replace('security list-keychains -d user -s "$keychain_path" login.keychain',
      'security list-keychains -d user -s "$keychain_path" "$BEELINE_OPERATOR_HOME/Library/Keychains/login.keychain-db" /Library/Keychains/System.keychain') };
}

async function desktopWorker(spec) {
  const secrets = spec.secrets, processes = new Processes(secrets);
  const baseEnv = { ...process.env };
  if (process.platform === 'win32') {
    baseEnv.HOME = process.env.USERPROFILE;
    baseEnv.PATH = `C:\\Program Files\\Git\\bin;${baseEnv.CARGO_HOME || join(baseEnv.HOME, '.cargo')}\\bin;${process.env.PATH}`;
  }
  const hooks = {
    job: async ({ context }) => {
      Object.assign(context.env, desktopBuildEnvironment({ directory: spec.directory,
        cargoHome: baseEnv.CARGO_HOME || join(baseEnv.HOME, '.cargo'), home: context.env.HOME }));
      context.env.BEELINE_OPERATOR_HOME = baseEnv.HOME;
      if (process.platform === 'darwin') {
        const tools = macSigningTools(join(spec.directory, 'signing-tools'));
        context.env.PATH = `${tools}:${context.env.PATH}`;
      }
    },
    step: async ({ step, context, env }) => {
      if (process.platform === 'darwin') Object.assign(step, desktopSigningStep(step));
      if (step.uses?.startsWith('actions/checkout@')) {
        if (readFileSync(join(spec.root, '.release-source-sha'), 'utf8').trim() !== spec.context.github.sha) throw new Error('Desktop source identity mismatch');
        return true;
      }
      if (step.run?.startsWith('sudo apt-get')) {
        await processes.run('bash', ['-c', 'pkg-config --exists webkit2gtk-4.1 gtk+-3.0 ayatana-appindicator3-0.1 librsvg-2.0 openssl; command -v patchelf; command -v file'], { env });
        return true;
      }
      if (step.uses?.startsWith('dtolnay/rust-toolchain@')) {
        await processes.run('rustup', ['toolchain', 'install', 'stable', '--profile', 'minimal', '--no-self-update'], { env });
        await processes.run('rustup', ['target', 'add', '--toolchain', 'stable', ...context.matrix['rust-targets'].split(',')], { env });
        context.env.RUSTUP_TOOLCHAIN = 'stable';
        return true;
      }
    },
  };
  const engine = new LocalActions({ root: spec.root, directory: spec.directory, secrets, processes, hooks, baseEnv });
  let keychains;
  if (process.platform === 'darwin') keychains = await processes.run('security', ['list-keychains', '-d', 'user'], { env: process.env, quiet: true });
  let job;
  try {
    job = await engine.job(spec.job, { ...spec.context, secrets }, spec.context.matrix.label, { VARIANT: 'production' });
  } finally {
    if (keychains) {
      await processes.run('security', ['list-keychains', '-d', 'user', '-s', ...[...keychains.matchAll(/"([^"]+)"/g)].map(m => m[1])], { env: process.env, quiet: true });
      const keychain = join(spec.directory, 'jobs', spec.context.matrix.label, 'build.keychain-db');
      if (existsSync(keychain)) await processes.run('security', ['delete-keychain', keychain], { env: process.env, quiet: true });
    }
    // Only this worker's disposable signing inputs are removed.
    rmSync(join(spec.directory, 'jobs', spec.context.matrix.label, 'certificate.p12'), { force: true });
    const temp = join(spec.directory, 'jobs', spec.context.matrix.label);
    if (secrets.EXPO_ASC_KEY_ID) rmSync(join(temp, `AuthKey_${secrets.EXPO_ASC_KEY_ID}.p8`), { force: true });
  }
  privateWrite(join(spec.directory, 'result.json'), JSON.stringify({ job, artifacts: [...engine.artifacts] }));
  if (job.result !== 'success') throw new Error(`Desktop ${spec.context.matrix.label} failed; see ${spec.directory}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  const file = process.argv[2];
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  // Secrets are in memory during the build, never retained in its spec.
  rmSync(file);
  desktopWorker(spec).catch(error => { console.error(error.message); process.exitCode = 1; });
}
