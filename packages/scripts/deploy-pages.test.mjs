import assert from 'node:assert/strict';
import test from 'node:test';
import { publishPages } from './deploy-pages.mjs';

const deploymentId = 'a1-b2';
const missingDeployment = 'The deployment ID you have specified does not exist. Update the deployment ID and try again.';

function publishWithFakePages(readDeployment) {
  const requests = [];
  const waits = [];
  const publish = publishPages({ manifest: {}, files: {} }, 'a'.repeat(40), {
    CLOUDFLARE_PAGES_TOKEN: 'fixture',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  }, async (url, { method }) => {
    const path = new URL(url).pathname;
    requests.push(method);
    if (method === 'POST') {
      assert.ok(path.endsWith('/deployments'));
      return Response.json({ success: true, result: { id: deploymentId } });
    }
    assert.equal(method, 'GET');
    assert.ok(path.endsWith(`/deployments/${deploymentId}`));
    return readDeployment();
  }, async milliseconds => { waits.push(milliseconds); });
  return { publish, requests, waits };
}

function pagesError(status, message) {
  return Response.json({ success: false, errors: [{ message }] }, { status });
}

test('Pages publication retries a missing deployment and completes when it becomes visible', async () => {
  let reads = 0;
  const { publish, requests, waits } = publishWithFakePages(() => {
    if (++reads === 1) return pagesError(404, missingDeployment);
    return Response.json({ success: true, result: { latest_stage: { name: 'deploy', status: 'success' } } });
  });
  await publish;
  assert.deepEqual(requests, ['POST', 'GET', 'GET']);
  assert.deepEqual(waits, [3000]);
});

test('Pages publication reports the Cloudflare error when the deployment stays missing', async () => {
  const { publish, requests, waits } = publishWithFakePages(() => pagesError(404, missingDeployment));
  await assert.rejects(publish, { message: `Pages read failed: HTTP 404 ${missingDeployment}` });
  assert.deepEqual(requests, ['POST', ...Array(20).fill('GET')]);
  assert.deepEqual(waits, Array(19).fill(3000));
});

test('Pages publication also retries when a missing deployment response has no JSON body', async () => {
  let reads = 0;
  const { publish, requests, waits } = publishWithFakePages(() => {
    if (++reads < 20) return new Response(null, { status: 404 });
    return pagesError(404, missingDeployment);
  });
  await assert.rejects(publish, { message: `Pages read failed: HTTP 404 ${missingDeployment}` });
  assert.deepEqual(requests, ['POST', ...Array(20).fill('GET')]);
  assert.deepEqual(waits, Array(19).fill(3000));
});

for (const [status, message] of [[401, 'Unauthorized'], [503, 'Service unavailable']]) {
  test(`Pages publication fails immediately when the deployment read returns HTTP ${status}`, async () => {
    const { publish, requests, waits } = publishWithFakePages(() => pagesError(status, message));
    await assert.rejects(publish, { message: `Pages read failed: HTTP ${status} ${message}` });
    assert.deepEqual(requests, ['POST', 'GET']);
    assert.deepEqual(waits, []);
  });
}
