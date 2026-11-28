import { expect, it, vi } from 'vitest';
import { GitHubAppClient } from './github.js';

const HEAD_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const BOOTSTRAP_MESSAGE = 'Initial commit (Beeline repository bootstrap)';

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
    message: BOOTSTRAP_MESSAGE,
    content: Buffer.from('# wargame\n').toString('base64'),
  });
  expect(put?.body).not.toHaveProperty('branch');
});

it('resumes target-branch creation on retry after README succeeds and the first ref request fails', async () => {
  const app = makeApp();
  let defaultCreated = false;
  let targetCreated = false;
  let putCalls = 0;
  let refAttempts = 0;
  vi.spyOn(app, 'request').mockImplementation(async (url, init) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? 'GET';
    if (method === 'GET' && parsed.pathname === '/repos/acme/wargame/branches/develop') {
      return targetCreated
        ? Response.json({ name: 'develop', commit: { sha: HEAD_SHA } })
        : Response.json({ message: 'Branch not found' }, { status: 404 });
    }
    if (method === 'GET' && parsed.pathname === '/repos/acme/wargame/branches') {
      return Response.json(
        defaultCreated ? [{ name: 'main', commit: { sha: HEAD_SHA } }] : [],
      );
    }
    if (method === 'GET' && parsed.pathname === '/repos/acme/wargame')
      return Response.json({ name: 'wargame', default_branch: 'main' });
    if (method === 'PUT' && parsed.pathname === '/repos/acme/wargame/contents/README.md') {
      putCalls += 1;
      defaultCreated = true;
      return Response.json({ commit: { sha: HEAD_SHA } }, { status: 201 });
    }
    if (method === 'GET' && parsed.pathname === `/repos/acme/wargame/commits/${HEAD_SHA}`) {
      return Response.json({
        sha: HEAD_SHA,
        parents: [],
        commit: { message: BOOTSTRAP_MESSAGE },
        files: [{ filename: 'README.md', status: 'added' }],
      });
    }
    if (method === 'POST' && parsed.pathname === '/repos/acme/wargame/git/refs') {
      refAttempts += 1;
      if (refAttempts === 1)
        return Response.json({ message: 'Bad Gateway' }, { status: 502 });
      const body = JSON.parse(String(init?.body)) as { ref: string; sha: string };
      expect(body).toEqual({ ref: 'refs/heads/develop', sha: HEAD_SHA });
      targetCreated = true;
      return Response.json({ ref: body.ref, object: { sha: body.sha } }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${method} ${parsed.pathname}`);
  });

  await expect(app.bootstrapEmptyRepository('token', 'acme/wargame', 'develop')).rejects.toThrow(
    /GitHub branch bootstrap failed: HTTP 502/,
  );
  expect(defaultCreated).toBe(true);
  expect(targetCreated).toBe(false);

  const retried = await app.bootstrapEmptyRepository('token', 'acme/wargame', 'develop');
  expect(retried).toEqual({ status: 'bootstrapped', headSha: HEAD_SHA });
  expect(putCalls).toBe(1);
  expect(refAttempts).toBe(2);
  expect(targetCreated).toBe(true);
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

it('leaves a non-empty repository untouched when the sole default-branch commit is not a Beeline bootstrap commit', async () => {
  const app = makeApp();
  const methods: string[] = [];
  vi.spyOn(app, 'request').mockImplementation(async (url, init) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? 'GET';
    methods.push(method);
    if (parsed.pathname === '/repos/acme/wargame/branches/develop')
      return Response.json({ message: 'Branch not found' }, { status: 404 });
    if (parsed.pathname === '/repos/acme/wargame/branches')
      return Response.json([{ name: 'main', commit: { sha: OTHER_SHA } }]);
    if (parsed.pathname === '/repos/acme/wargame')
      return Response.json({ name: 'wargame', default_branch: 'main' });
    if (parsed.pathname === `/repos/acme/wargame/commits/${OTHER_SHA}`)
      return Response.json({
        sha: OTHER_SHA,
        parents: [],
        commit: { message: 'User initial commit' },
        files: [{ filename: 'README.md', status: 'added' }],
      });
    throw new Error(`Unexpected request: ${method} ${parsed.pathname}`);
  });

  const result = await app.bootstrapEmptyRepository('token', 'acme/wargame', 'develop');
  expect(result).toEqual({ status: 'missing-branch' });
  expect(methods).toEqual(['GET', 'GET', 'GET', 'GET']);
});

it('leaves a repository with multiple branches untouched without reading commits', async () => {
  const app = makeApp();
  const methods: string[] = [];
  vi.spyOn(app, 'request').mockImplementation(async (url, init) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? 'GET';
    methods.push(method);
    if (parsed.pathname === '/repos/acme/wargame/branches/develop')
      return Response.json({ message: 'Branch not found' }, { status: 404 });
    if (parsed.pathname === '/repos/acme/wargame/branches')
      return Response.json([
        { name: 'main', commit: { sha: HEAD_SHA } },
        { name: 'release', commit: { sha: OTHER_SHA } },
      ]);
    throw new Error(`Unexpected request: ${method} ${parsed.pathname}`);
  });

  const result = await app.bootstrapEmptyRepository('token', 'acme/wargame', 'develop');
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
