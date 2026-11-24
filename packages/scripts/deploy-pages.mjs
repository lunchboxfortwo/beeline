import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const packageSpec = 'wrangler@4.165.0';
const projectName = 'usebeeline';

function pagesApi({ token, accountId, fetchImpl = fetch }) {
  if (!token) throw new Error('CLOUDFLARE_PAGES_TOKEN is required for website publication');
  if (!/^[a-f0-9]{32}$/.test(accountId ?? '')) throw new Error('CLOUDFLARE_ACCOUNT_ID is required for website publication');
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`;
  return async (path = '', body) => {
    const response = await fetchImpl(url + path, {
      method: body ? 'POST' : 'GET', body, headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(`Pages ${body ? 'deployment' : 'read'} failed: HTTP ${response.status} ${result.errors?.map(error => error.message).join(', ') ?? ''}`);
    return result.result;
  };
}

async function awaitPagesDeployment(api, id) {
  if (!/^[a-f0-9-]+$/.test(id ?? '')) throw new Error('Pages returned an invalid deployment ID');
  for (let i = 0; i < 20; i++) {
    const deployment = await api(`/deployments/${id}`);
    const stage = deployment.latest_stage;
    if (stage?.name === 'deploy' && stage.status === 'success') return deployment;
    if (['failure', 'canceled'].includes(stage?.status)) throw new Error(`Pages deployment ${id} failed`);
    await delay(3000);
  }
  throw new Error(`Pages deployment ${id} did not finish`);
}

export async function stagePages({ directory, sha, branch, token, accountId, output }) {
  const api = pagesApi({ token, accountId });
  const project = await api();
  if (project.production_branch === branch) throw new Error('The Pages candidate branch must be a preview');
  const workspace = dirname(directory);
  const tools = join(workspace, 'pages-tools');
  await executeFile('npm', ['install', '--prefix', tools, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', packageSpec],
    { cwd: workspace, timeout: 120_000 });
  process.env.CLOUDFLARE_API_TOKEN = token;
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
  process.env.WRANGLER_SEND_METRICS = 'false';
  const originalCwd = process.cwd();
  let submission;
  try {
    // Wrangler creates .wrangler/tmp under its working directory.
    process.chdir(workspace);
    const { unstable_pages } = createRequire(join(tools, 'package.json'))('wrangler');
    submission = await unstable_pages.deploy({
      directory, accountId, projectName, branch, commitHash: sha, commitDirty: true,
      bundle: false, sourceMaps: false, args: {},
    });
  } finally {
    process.chdir(originalCwd);
  }
  const { deploymentResponse, formData } = submission;
  const files = {};
  const manifest = JSON.parse(formData.get('manifest'));
  for (const [name, value] of formData) {
    if (['_headers', '_redirects'].includes(name)) files[name] = await value.text();
    else if (!['manifest', 'branch', 'commit_hash', 'commit_dirty'].includes(name))
      throw new Error(`Unexpected Pages deployment input ${name}`);
  }
  const deployment = await awaitPagesDeployment(api, deploymentResponse.id);
  await writeFile(output, JSON.stringify({ manifest, files }) + '\n');
  console.log(`Staged Pages preview ${deployment.url}`);
}

export async function publishPages(staged, sha, env, fetchImpl) {
  const api = pagesApi({ token: env.CLOUDFLARE_PAGES_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID, fetchImpl });
  const body = new FormData();
  body.set('branch', 'main');
  body.set('commit_hash', sha);
  body.set('manifest', JSON.stringify(staged.manifest));
  for (const [name, contents] of Object.entries(staged.files)) body.set(name, new File([contents], name));
  const deployment = await api('/deployments', body);
  await awaitPagesDeployment(api, deployment.id);
}
