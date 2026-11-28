import { expect, it, vi } from 'vitest';
import { GitHubAppClient } from './github.js';

const HEAD_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function makeApp() {
  return new GitHubAppClient({ appId: '1', slug: 'beeline-test', privateKey: 'unused' });
}

it('bootstraps an empty repository on its default branch without passing branch to contents PUT', async () => {
  const app = makeApp();
  const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  vi.spyOn(app, 'request').mockImplementation(async (url, init) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push({ method, path: `${parsed.pathname}${parsed.search}`, ...(body ? { body } : {}) });
    if (method === 'GET' && parsed.pathname === '/repos/acme/wargame/branches/main')
      return Response.json({ message: 'Branch not found' }, { status: 404 });
    if (method === 'GET' && parsed.pathname === '/repos/acme/wargame/branches')
      return Response.json([]);
    if (method === 'GET' && parsed.pathname === '/repos/acme/wargame')
      return Response.json({ name: 'wargame', default_branch: 'main' });
    if (method === 'PUT' && parsed.pathname === '/repos/acme/wargame/contents/README.md')
      return Response.json({ commit: { sha: HEAD_SHA } }, { status: 201 });
    throw new Error(`Unexpected request: ${method} ${parsed.pathname}`);
  });

  const result = await app.bootstrapEmptyRepository('token', 'acme/wargame', 'main');
  expect(result).toEqual({ status: 'bootstrapped', headSha: HEAD_SHA });
  const put = requests.find((entry) => entry.method === 'PUT');
  expect(put?.path).toBe('/repos/acme/wargame/contents/README.md');
  expect(put?.body).toEqual({
    message: 'Initial commit',
    content: Buffer.from('# wargame\n').toString('base64'),
  });
  expect(put?.body).not.toHaveProperty('branch');
});

it('creates targetBranch ref when an empty repository targets a branch other than default_branch', async () => {
  const app = makeApp();
  const createdRefs: Array<Record<string, unknown>> = [];
  vi.spyOn(app, 'request').mockImplementation(async (url, init) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? 'GET';
    if (method === 'GET' && parsed.pathname === '/repos/acme/wargame/branches/develop')
      return Response.json({ message: 'Branch not found' }, { status: 404 });
    if (method === 'GET' && parsed.pathname === '/repos/acme/wargame/branches')
      return Response.json([]);
    if (method === 'GET' && parsed.pathname === '/repos/acme/wargame')
      return Response.json({ name: 'wargame', default_branch: 'main' });
    if (method === 'PUT' && parsed.pathname === '/repos/acme/wargame/contents/README.md')
      return Response.json({ commit: { sha: HEAD_SHA } }, { status: 201 });
    if (method === 'POST' && parsed.pathname === '/repos/acme/wargame/git/refs') {
      createdRefs.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ref: 'refs/heads/develop', object: { sha: HEAD_SHA } }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${method} ${parsed.pathname}`);
  });

  const result = await app.bootstrapEmptyRepository('token', 'acme/wargame', 'develop');
  expect(result).toEqual({ status: 'bootstrapped', headSha: HEAD_SHA });
  expect(createdRefs).toEqual([{ ref: 'refs/heads/develop', sha: HEAD_SHA }]);
});

it('skips writes when targetBranch already exists', async () => {
  const app = makeApp();
  const request = vi.spyOn(app, 'request').mockResolvedValue(
    Response.json({ name: 'main', commit: { sha: HEAD_SHA } }),
  );
  const result = await app.bootstrapEmptyRepository('token', 'acme/wargame', 'main');
  expect(result).toEqual({ status: 'already-initialized', headSha: HEAD_SHA });
  expect(request).toHaveBeenCalledTimes(1);
});

it('leaves a non-empty repository untouched when only targetBranch is missing', async () => {
  const app = makeApp();
  const methods: string[] = [];
  vi.spyOn(app, 'request').mockImplementation(async (url, init) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? 'GET';
    methods.push(method);
    if (parsed.pathname === '/repos/acme/wargame/branches/main')
      return Response.json({ message: 'Branch not found' }, { status: 404 });
    if (parsed.pathname === '/repos/acme/wargame/branches')
      return Response.json([{ name: 'master', commit: { sha: OTHER_SHA } }]);
    throw new Error(`Unexpected request: ${method} ${parsed.pathname}`);
  });

  const result = await app.bootstrapEmptyRepository('token', 'acme/wargame', 'main');
  expect(result).toEqual({ status: 'missing-branch' });
  expect(methods).toEqual(['GET', 'GET']);
});

it('recovers cleanly when another writer initializes the empty repository concurrently', async () => {
  const app = makeApp();
  let branchChecks = 0;
  vi.spyOn(app, 'request').mockImplementation(async (url, init) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? 'GET';
    if (method === 'GET' && parsed.pathname === '/repos/acme/wargame/branches/main') {
      branchChecks += 1;
      return branchChecks === 1
        ? Response.json({ message: 'Branch not found' }, { status: 404 })
        : Response.json({ name: 'main', commit: { sha: OTHER_SHA } });
    }
    if (method === 'GET' && parsed.pathname === '/repos/acme/wargame/branches')
      return Response.json([]);
    if (method === 'GET' && parsed.pathname === '/repos/acme/wargame')
      return Response.json({ name: 'wargame', default_branch: 'main' });
    if (method === 'PUT' && parsed.pathname === '/repos/acme/wargame/contents/README.md')
      return Response.json({ message: 'Invalid request. "sha" wasn\'t supplied.' }, { status: 422 });
    throw new Error(`Unexpected request: ${method} ${parsed.pathname}`);
  });

  const result = await app.bootstrapEmptyRepository('token', 'acme/wargame', 'main');
  expect(result).toEqual({ status: 'already-initialized', headSha: OTHER_SHA });
});
