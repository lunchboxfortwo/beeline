import { ask } from './wait.js';

function githubRepositoryPath(remote: string): { path: string; name: string } | undefined {
  const match = remote.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (!match?.[1] || !match[2]) return undefined;
  return {
    path: `${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`,
    name: match[2],
  };
}

function githubHeaders(token: string, json = false): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'beeline-body',
    'x-github-api-version': '2022-11-28',
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

async function readErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const parsed = (await response.json()) as { message?: unknown };
    return typeof parsed.message === 'string' && parsed.message ? parsed.message : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Seed an empty GitHub repository with an initial README.md commit on its
 * default branch (and create `targetBranch` at that commit if it differs) so a
 * thread can branch off `origin/<targetBranch>` and open a pull request.
 *
 * Returns `true` when `targetBranch` exists on GitHub after this call (either
 * bootstrapped now or already created by a concurrent writer), and `false` when
 * the remote is not a GitHub repository or already contains other branches.
 */
export async function bootstrapEmptyGitHubRemote(input: {
  remote: string;
  targetBranch: string;
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const repo = githubRepositoryPath(input.remote);
  if (!repo || !input.token) return false;
  const base = (input.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const branch = input.targetBranch.trim() || 'main';
  const request = (pathname: string, init: RequestInit = {}) =>
    ask(
      { url: `${base}${pathname}`, ...(input.fetchImpl ? { fetch: input.fetchImpl } : {}) },
      init,
    );
  const branchExists = async (): Promise<boolean> => {
    const response = await request(
      `/repos/${repo.path}/branches/${encodeURIComponent(branch)}`,
      { headers: githubHeaders(input.token) },
    );
    if (response.status === 404) return false;
    if (!response.ok) {
      const reason = await readErrorMessage(response);
      throw new Error(
        `GitHub branch lookup failed: HTTP ${response.status}${reason ? `: ${reason}` : ''}`,
      );
    }
    return true;
  };
  if (await branchExists()) return true;

  const branchesResponse = await request(
    `/repos/${repo.path}/branches?per_page=1`,
    { headers: githubHeaders(input.token) },
  );
  if (!branchesResponse.ok) {
    const reason = await readErrorMessage(branchesResponse);
    throw new Error(
      `GitHub repository branches lookup failed: HTTP ${branchesResponse.status}${reason ? `: ${reason}` : ''}`,
    );
  }
  const branches: unknown = await branchesResponse.json();
  if (!Array.isArray(branches)) throw new Error('GitHub repository branches response is invalid');
  // Never invent an orphan commit when the repository already has other branches.
  if (branches.length > 0) return false;

  const repoResponse = await request(`/repos/${repo.path}`, {
    headers: githubHeaders(input.token),
  });
  if (!repoResponse.ok) {
    const reason = await readErrorMessage(repoResponse);
    throw new Error(
      `GitHub repository lookup failed: HTTP ${repoResponse.status}${reason ? `: ${reason}` : ''}`,
    );
  }
  const repoBody = (await repoResponse.json()) as { default_branch?: unknown; name?: unknown };
  const defaultBranch =
    typeof repoBody.default_branch === 'string' && repoBody.default_branch
      ? repoBody.default_branch
      : 'main';
  const repoName =
    typeof repoBody.name === 'string' && repoBody.name ? repoBody.name : repo.name;

  // Omit `branch` on an empty repository so GitHub creates its default branch atomically.
  const putResponse = await request(`/repos/${repo.path}/contents/README.md`, {
    method: 'PUT',
    headers: githubHeaders(input.token, true),
    body: JSON.stringify({
      message: 'Initial commit',
      content: Buffer.from(`# ${repoName}\n`).toString('base64'),
    }),
  });
  if (!putResponse.ok) {
    if ((putResponse.status === 409 || putResponse.status === 422) && (await branchExists()))
      return true;
    const reason = await readErrorMessage(putResponse);
    throw new Error(
      `GitHub empty repository bootstrap failed: HTTP ${putResponse.status}${reason ? `: ${reason}` : ''}`,
    );
  }
  const created = (await putResponse.json()) as { commit?: { sha?: unknown } };
  const headSha = created.commit?.sha;
  if (typeof headSha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(headSha))
    throw new Error('GitHub empty repository bootstrap returned no commit SHA');

  if (branch !== defaultBranch) {
    const refResponse = await request(`/repos/${repo.path}/git/refs`, {
      method: 'POST',
      headers: githubHeaders(input.token, true),
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: headSha }),
    });
    if (!refResponse.ok) {
      if (refResponse.status === 422 && (await branchExists())) return true;
      const reason = await readErrorMessage(refResponse);
      throw new Error(
        `GitHub branch bootstrap failed: HTTP ${refResponse.status}${reason ? `: ${reason}` : ''}`,
      );
    }
  }
  return true;
}
