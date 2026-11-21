// Both Mac helpers build on GitHub-hosted macOS runners (macos-15 for ARM,
// macos-15-intel for Intel), and so do the macOS desktop installers
// (mac-desktop.yml, signed with the Developer ID secrets and notarized). One
// squire release leg dispatches each workflow once, waits for it and downloads
// its artifacts. The runs build only; publication stays on squire.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const MAC_HELPERS_WORKFLOW = 'mac-helpers.yml';
const MAC_DESKTOP_WORKFLOW = 'mac-desktop.yml';
const MAC_PLATFORMS = ['darwin-arm64', 'darwin-x64'];
const jobName = (platform) => `HELPER BUILD (${platform})`;
const DESKTOP_JOB = 'DESKTOP BUILD (macos-universal)';
// desktop.yml signs only when every Apple secret is present and otherwise
// builds unsigned; the release accepts only a run whose signed path ran.
const DESKTOP_SIGNED_STEPS = [
  'Notarize and staple the macOS disk image',
  'Verify the signed and notarized macOS download',
];
const wait = (what) => (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`${what} cancelled`));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error(`${what} cancelled`));
      },
      { once: true },
    );
  });

// Dispatches one workflow run, waits for it to complete (cancelling it if the
// wait ends early) and returns the finished run, its jobs and a gh runner.
async function githubRun({
  processes,
  token,
  repository,
  workflow,
  inputs,
  what,
  building,
  signal,
  ref,
  poll,
  timeoutMinutes,
  now,
  sleep,
}) {
  const env = { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token };
  const gh = async (args) => processes.run('gh', args, { env, quiet: true, timeout: 5 * 60_000 });
  const api = async (path) => JSON.parse(await gh(['api', path]));
  const requestId = randomUUID(),
    deadline = now() + timeoutMinutes * 60_000;
  await gh([
    'workflow',
    'run',
    workflow,
    '-R',
    repository,
    '--ref',
    ref,
    ...Object.entries({ ...inputs, request_id: requestId }).flatMap(([name, value]) => [
      '-f',
      `${name}=${value}`,
    ]),
  ]);
  let run;
  try {
    while (true) {
      if (now() > deadline)
        throw new Error(
          `${what} did not finish within ${timeoutMinutes} minutes${run ? `: ${run.html_url}` : ''}`,
        );
      if (!run) {
        const runs = await api(
          `repos/${repository}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=30`,
        );
        run = runs.workflow_runs.find((candidate) =>
          candidate.display_title?.endsWith(`· ${requestId}`),
        );
        if (run) processes.log(`${building} on GitHub: ${run.html_url}`);
      }
      if (run) {
        run = await api(`repos/${repository}/actions/runs/${run.id}`);
        if (run.status === 'completed') break;
      }
      await (sleep ?? wait(what))(poll, signal);
    }
  } finally {
    if (run && run.status !== 'completed')
      await gh(['run', 'cancel', String(run.id), '-R', repository]).catch(() => {});
  }
  const { jobs } = await api(`repos/${repository}/actions/runs/${run.id}/jobs?per_page=10`);
  return { run, jobs, gh };
}

// Resolves to { [platform]: { result, outputs } } once the run has finished and
// each successful build's artifact is in <directory>/artifacts/<name>.
export async function githubMacHelpers({
  processes,
  token,
  repository,
  sha,
  version,
  directory,
  artifacts,
  records,
  signal,
  ref = 'main',
  poll = 30_000,
  timeoutMinutes = 90,
  now = () => Date.now(),
  sleep,
}) {
  const started = new Date(now()).toISOString();
  const { run, jobs, gh } = await githubRun({
    processes,
    token,
    repository,
    workflow: MAC_HELPERS_WORKFLOW,
    inputs: { release_sha: sha, release_version: version },
    what: 'Mac helper build',
    building: 'Mac helpers building',
    signal,
    ref,
    poll,
    timeoutMinutes,
    now,
    sleep,
  });
  const results = {};
  for (const platform of MAC_PLATFORMS) {
    const job = jobs.find((candidate) => candidate.name === jobName(platform)),
      label = `helper_macos-${platform}`;
    let conclusion = job?.conclusion === 'success' ? 'success' : 'failure';
    if (conclusion === 'success') {
      const name = `daemon-${platform}-${version}-${sha}`,
        destination = join(directory, 'artifacts', name);
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      try {
        await gh([
          'run',
          'download',
          String(run.id),
          '-R',
          repository,
          '-n',
          name,
          '-D',
          destination,
        ]);
        artifacts.set(name, destination);
      } catch (error) {
        conclusion = 'failure';
        processes.log(`${label}: artifact download failed: ${error.message}`);
      }
    }
    processes.log(`${label}: ${conclusion} on GitHub (${job?.html_url ?? run.html_url})`);
    records?.set(label, {
      id: label,
      name: label,
      conclusion,
      started_at: job?.started_at ?? started,
      completed_at: job?.completed_at ?? new Date(now()).toISOString(),
      html_url: job?.html_url ?? run.html_url,
    });
    results[platform] = { result: conclusion, outputs: { shipped: 'false' } };
  }
  return results;
}

// Resolves to the downloaded installer artifact { name, path } once the
// macos-universal build has signed, notarized and verified its disk image.
export async function githubMacDesktop({
  processes,
  token,
  repository,
  sha,
  releaseVersion,
  desktopVersion,
  directory,
  signal,
  ref = 'main',
  poll = 30_000,
  timeoutMinutes = 90,
  now = () => Date.now(),
  sleep,
}) {
  const { run, jobs, gh } = await githubRun({
    processes,
    token,
    repository,
    workflow: MAC_DESKTOP_WORKFLOW,
    inputs: { release_sha: sha, release_version: releaseVersion, desktop_version: desktopVersion },
    what: 'Mac desktop build',
    building: 'Mac desktop building',
    signal,
    ref,
    poll,
    timeoutMinutes,
    now,
    sleep,
  });
  const job = jobs.find((candidate) => candidate.name === DESKTOP_JOB),
    url = job?.html_url ?? run.html_url;
  if (job?.conclusion !== 'success') throw new Error(`Mac desktop build failed on GitHub: ${url}`);
  for (const step of DESKTOP_SIGNED_STEPS)
    if (job.steps?.find((candidate) => candidate.name === step)?.conclusion !== 'success')
      throw new Error(
        `Mac desktop build is not Developer ID signed and notarized (${step} did not run): ${url}`,
      );
  const name = `beeline-desktop-release-${releaseVersion}-${sha}-macos-universal`,
    path = join(directory, name);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  await gh(['run', 'download', String(run.id), '-R', repository, '-n', name, '-D', path]);
  processes.log(`Mac desktop signed and notarized on GitHub: ${url}`);
  return { name, path };
}
