// Invoked by the queue in a private CI unit or bounded Body user scope.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalActions } from './release-local-actions.mjs';
import { Processes, privateWrite } from './release-local-process.mjs';
import { localGithub } from './release-local-github.mjs';
import { localHooks } from './release-local.mjs';

const spec = JSON.parse(readFileSync(process.argv[2] || '/state/spec.json', 'utf8'));
const root = spec.root || '/source', directory = spec.directory || '/state';
const processes = new Processes({ token: spec.context.github.token });
const hooks = localHooks(directory, processes);
const originalJob = hooks.job, originalStep = hooks.step;
hooks.job = async args => {
  const result = await originalJob(args);
  const index = Number(args.context.env.GIT_CONFIG_COUNT || 0);
  Object.assign(args.context.env, {
    GIT_CONFIG_COUNT: String(index + 1), [`GIT_CONFIG_KEY_${index}`]: 'safe.directory', [`GIT_CONFIG_VALUE_${index}`]: root,
    ...(directory === '/state' && process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
  });
  if (spec.temporary) args.context.env.TMPDIR = spec.temporary;
  return result;
};
hooks.step = async args => {
  if (!spec.preparation && args.step.uses === './.github/actions/ci-workspace') {
    processes.log('Using the workspace installed, built and provenance-verified once before this queue.');
    return true;
  }
  // A rootless Docker daemon cannot see this unit's private /source mount.
  // Copy the workflows and Git metadata needed for project discovery into
  // its own container instead. The source clone contains no credentials.
  if (args.step.name === 'Lint GitHub Actions workflows') {
    const container = `beeline-actionlint-${spec.context.github.run_id}-${spec.context.github.job}`;
    try {
      await processes.run('docker', ['create', '--name', container, '--workdir', '/repo', 'ghcr.io/beeline-work/ci-actionlint:1.7.7@sha256:887a259a5a534f3c4f36cb02dca341673c6089431057242cdc931e9f133147e9', '-config-file', '.github/actionlint.yaml'], { env: args.env });
      await processes.run('docker', ['cp', '/source/.github', `${container}:/repo/.github`], { env: args.env });
      await processes.run('docker', ['cp', '/source/.git', `${container}:/repo/.git`], { env: args.env });
      await processes.run('docker', ['start', '--attach', container], { env: args.env });
      const status = (await processes.run('docker', ['inspect', '--format', '{{.State.ExitCode}}', container], { env: args.env, quiet: true })).trim();
      if (status !== '0') throw new Error(`Actionlint failed (${status})`);
    } finally { await processes.run('docker', ['rm', '--force', container], { env: args.env, quiet: true }); }
    return true;
  }
  return originalStep(args);
};
const engine = new LocalActions({ root, directory, secrets: { GITHUB_TOKEN: spec.context.github.token }, variables: spec.variables, processes, github: localGithub, hooks, isolateTemporary: true });
spec.context.secrets = engine.secrets;
const cancel = () => { engine.cancelled = true; engine.abortController.abort(); processes.cancel(); };
process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
const logFile = join(directory, 'output.log');
privateWrite(logFile, '');
try {
  const job = await processes.withLogFile(logFile, () => engine.runJob(spec.job, spec.context, spec.label, spec.workflowEnv, directory, new Date().toISOString(), logFile));
  privateWrite(join(directory, 'result.json'), JSON.stringify({ job, records: [...engine.records.values()], artifacts: [...engine.artifacts] }));
  if (job.result !== 'success') process.exitCode = 1;
} finally { process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel); }
