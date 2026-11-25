import { execFileSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export function githubRunNotFound(error) {
  return /^gh: [^\r\n]*\(HTTP 404\)\r?$/m.test(String(error.stderr ?? ''));
}

export async function watchReleaseRun(repository, id, env, run = execFileSync, pause = wait) {
  const path = `repos/${repository}/actions/runs/${id}`;
  const visibleBy = performance.now() + 60_000;
  let status;
  for (;;) {
    let result;
    try {
      result = JSON.parse(run('gh', ['api', path], {
        env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
      }));
    } catch (error) {
      // Dispatch can return the ID before the run is readable. Tolerate the
      // 404 during that gap. The jobs endpoint can lag independently.
      if (status || !githubRunNotFound(error) || performance.now() >= visibleBy) throw error;
    }
    if (result?.status === 'completed') {
      if (result.conclusion !== 'success') throw new Error(`GitHub run ${id} completed with ${result.conclusion}`);
      console.log(`GitHub run ${id} completed with success`);
      return;
    }
    if (result && result.status !== status) {
      status = result.status;
      console.log(`GitHub run ${id}: ${status}`);
    }
    // Keep the refresh interval used by gh run watch.
    await pause(3_000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  watchReleaseRun(process.argv[2], process.argv[3], process.env).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
