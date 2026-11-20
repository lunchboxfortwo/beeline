// Both Mac helpers build on GitHub-hosted macOS runners (macos-15 for ARM,
// macos-15-intel for Intel). One squire release leg dispatches mac-helpers.yml
// once, waits for it and downloads both artifacts for the existing helper join.
// The run builds only; publication stays on squire.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const MAC_HELPERS_WORKFLOW = 'mac-helpers.yml';
const MAC_PLATFORMS = ['darwin-arm64', 'darwin-x64'];
const jobName = (platform) => `HELPER BUILD (${platform})`;
const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Mac helper build cancelled'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Mac helper build cancelled'));
      },
      { once: true },
    );
  });

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
  sleep = wait,
}) {
  const env = { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token };
  const gh = async (args) => processes.run('gh', args, { env, quiet: true, timeout: 5 * 60_000 });
  const api = async (path) => JSON.parse(await gh(['api', path]));
  const requestId = randomUUID(),
    started = new Date(now()).toISOString(),
    deadline = now() + timeoutMinutes * 60_000;
  await gh([
    'workflow',
    'run',
    MAC_HELPERS_WORKFLOW,
    '-R',
    repository,
    '--ref',
    ref,
    '-f',
    `release_sha=${sha}`,
    '-f',
    `release_version=${version}`,
    '-f',
    `request_id=${requestId}`,
  ]);
  let run;
  try {
    while (true) {
      if (now() > deadline)
        throw new Error(
          `Mac helper build did not finish within ${timeoutMinutes} minutes${run ? `: ${run.html_url}` : ''}`,
        );
      if (!run) {
        const runs = await api(
          `repos/${repository}/actions/workflows/${MAC_HELPERS_WORKFLOW}/runs?event=workflow_dispatch&per_page=30`,
        );
        run = runs.workflow_runs.find((candidate) =>
          candidate.display_title?.endsWith(`· ${requestId}`),
        );
        if (run) processes.log(`Mac helpers building on GitHub: ${run.html_url}`);
      }
      if (run) {
        run = await api(`repos/${repository}/actions/runs/${run.id}`);
        if (run.status === 'completed') break;
      }
      await sleep(poll, signal);
    }
  } finally {
    if (run && run.status !== 'completed')
      await gh(['run', 'cancel', String(run.id), '-R', repository]).catch(() => {});
  }
  const { jobs } = await api(`repos/${repository}/actions/runs/${run.id}/jobs?per_page=10`);
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
