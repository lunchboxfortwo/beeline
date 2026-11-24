import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const packageSpec = 'wrangler@4.165.0';
const projectName = 'usebeeline';

// Direct Upload works from Actions and the local release runner. Production is
// selected explicitly: a detached release checkout must not become a preview.
export async function deployPages({ directory, sha, token, accountId, execute = executeFile }) {
  if (!directory) throw new Error('Expected a built Pages directory');
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Expected an exact release commit');
  pagesApi({ token, accountId });
  const { stdout, stderr } = await execute('npx', [
    '--yes', `--package=${packageSpec}`, '--', 'wrangler', 'pages', 'deploy', directory,
    '--project-name=usebeeline', '--branch=main', `--commit-hash=${sha}`, '--commit-dirty=true',
  ], {
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId,
      WRANGLER_SEND_METRICS: 'false', CI: 'true' },
    // Wrangler writes .wrangler/tmp under its working directory; the local
    // release runs from /, which is not writable, so work beside the build.
    cwd: dirname(resolve(directory)),
    timeout: 600000, maxBuffer: 8 * 1024 * 1024,
  });
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
}

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
  await writeFile(output, JSON.stringify({ id: deployment.id, sourceSha: sha, branch, manifest, files }) + '\n');
  console.log(`Staged Pages preview ${deployment.url}`);
}

export async function preparePagesPromotion({ staged, version, sourceSha, token, accountId, fetchImpl }) {
  const api = pagesApi({ token, accountId, fetchImpl });
  if (staged?.sourceSha !== sourceSha || staged.branch !== `next-${version}` || !/^[a-f0-9-]+$/.test(staged.id ?? '') ||
      !staged.manifest || !Object.keys(staged.manifest).length) throw new Error('Missing Pages manifest for the selected candidate');
  const [project, preview] = await Promise.all([api(), api(`/deployments/${staged.id}`)]);
  if (preview.environment !== 'preview' || preview.latest_stage?.status !== 'success' ||
      preview.deployment_trigger?.metadata?.commit_hash !== sourceSha || preview.deployment_trigger?.metadata?.branch !== staged.branch)
    throw new Error('Pages preview differs from the selected candidate');
  const message = `Promote ${version}`;
  const metadata = project.canonical_deployment?.deployment_trigger?.metadata;
  return async () => {
    if (metadata?.commit_hash === sourceSha && metadata.commit_message === message &&
      project.canonical_deployment.latest_stage?.status === 'success') return;
    const body = new FormData();
    body.set('branch', project.production_branch);
    body.set('commit_hash', sourceSha);
    body.set('commit_dirty', 'true');
    body.set('commit_message', message);
    body.set('manifest', JSON.stringify(staged.manifest));
    for (const name of ['_headers', '_redirects']) {
      if (staged.files?.[name]) body.set(name, new File([staged.files[name]], name));
    }
    const deployment = await api('/deployments', body);
    await awaitPagesDeployment(api, deployment.id);
  };
}
