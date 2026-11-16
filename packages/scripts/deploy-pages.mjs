import { setTimeout as sleep } from 'node:timers/promises';

// Keep the Pages API protocol in one place so an empty successful HTTP response
// cannot consume the deployment's entire ten-minute timeout.
export async function deployPages({ github, repo, artifactId, sha, idToken, wait = sleep, now = Date.now, log = console.log }) {
  const request = (method, suffix, body = {}) => github.request(`${method} /repos/{owner}/{repo}/pages/deployments${suffix}`, {
    ...repo, ...body, request: { timeout: 30000 },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: deployment } = await request('POST', '', {
      artifact_id: artifactId, pages_build_version: sha, oidc_token: idToken,
    });
    const id = deployment?.id || deployment?.status_url?.split('/').pop();
    if (!id) throw new Error('Pages returned no deployment identity');
    log(`Pages deployment ${id} created for ${sha}, artifact ${artifactId}`);
    const start = now();
    let lastStatus = '<not received>';
    let emptyRetried = false;
    let errors = 0;
    let activeSince;
    let stalled = false;
    try {
      while (now() - start < 600000) {
        let data;
        try {
          ({ data } = await request('GET', `/${id}`));
        } catch (error) {
          // Match deploy-pages' bounded tolerance for temporary API failures.
          if (++errors >= 10) throw error;
          await wait(5000);
          continue;
        }
        lastStatus = typeof data?.status === 'string' ? JSON.stringify(data.status) : '<missing>';
        log(`Pages deployment ${id}: status=${lastStatus}`);
        if (typeof data?.status !== 'string' || !data.status.trim()) {
          if (emptyRetried) throw new Error('Pages returned an empty status after one retry');
          emptyRetried = true;
          continue;
        }
        if (data.status === 'succeed') return deployment;
        if (['in_progress', 'deploying'].includes(data.status)) {
          activeSince ??= now();
          // Eight minutes is well beyond the healthy 3.5-minute deployment.
          if (now() - activeSince >= 480000) {
            stalled = true;
            throw new Error('Pages deployment stalled');
          }
        } else activeSince = undefined;
        if (['deployment_failed', 'deployment_perms_error', 'deployment_content_failed', 'deployment_cancelled', 'deployment_lost'].includes(data.status)) {
          throw new Error(`Pages deployment failed: ${data.status}`);
        }
        await wait(5000);
      }
      throw new Error('Pages deployment timed out');
    } catch (error) {
      const context = `Pages deployment ${id}: last status=${lastStatus}, elapsed=${now() - start}ms, API errors=${errors}`;
      log(context);
      // A redeploy requires confirmed cancellation of this specific deployment.
      try {
        await request('POST', `/${id}/cancel`);
      } catch (cancelError) {
        throw new Error(`${error.message}; ${context}; cancellation failed: ${cancelError.message}`, { cause: cancelError });
      }
      if (stalled && attempt === 0) {
        log(`Redeploying artifact ${artifactId} after stalled Pages deployment ${id}`);
        continue;
      }
      throw new Error(`${error.message}; ${context}`, { cause: error });
    }
  }
}
