// Runs the committed Desktop job on a source archive, with local-only artifacts.
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LocalActions } from './release-local-actions.mjs';
import { Processes, privateWrite } from './release-local-process.mjs';

export function desktopBuildEnvironment({ directory, cargoHome, home }) {
  return { CARGO_BUILD_JOBS: '2', CI_TEST_WORKERS: '2', BEELINE_LOCAL_RELEASE: 'true', CARGO_HOME: cargoHome,
    RUSTUP_HOME: join(directory, 'tools/rustup'), NPM_CONFIG_USERCONFIG: join(home, '.npmrc') };
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
    },
    step: async ({ step, context, env }) => {
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
  const job = await engine.job(spec.job, { ...spec.context, secrets }, spec.context.matrix.label, { VARIANT: 'production' });
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
