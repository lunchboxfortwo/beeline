import { setTimeout as sleep } from 'node:timers/promises';

// Keep the Pages API protocol in one place so an empty successful HTTP response
// cannot consume the deployment's entire ten-minute timeout.
export async function deployPages({ github, repo, artifactId, sha, idToken, wait = sleep, now = Date.now }) {
  const request = (method, suffix, body = {}) => github.request(`${method} /repos/{owner}/{repo}/pages/deployments${suffix}`, {
    ...repo, ...body, request: { timeout: 30000 },
  });
  const { data: deployment } = await request('POST', '', {
    artifact_id: artifactId, pages_build_version: sha, oidc_token: idToken,
  });
  const id = deployment?.id || deployment?.status_url?.split('/').pop();
  if (!id) throw new Error('Pages returned no deployment identity');
  const start = now();
  let emptyRetried = false;
  let errors = 0;
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
      if (typeof data?.status !== 'string' || !data.status.trim()) {
        if (emptyRetried) throw new Error('Pages returned an empty status after one retry');
        emptyRetried = true;
        continue;
      }
      if (data.status === 'succeed') return deployment;
      if (['deployment_failed', 'deployment_perms_error', 'deployment_content_failed', 'deployment_cancelled', 'deployment_lost'].includes(data.status)) {
        throw new Error(`Pages deployment failed: ${data.status}`);
      }
      await wait(5000);
    }
    throw new Error('Pages deployment timed out');
  } catch (error) {
    await request('POST', `/${id}/cancel`).catch(() => {});
    throw error;
  }
}
