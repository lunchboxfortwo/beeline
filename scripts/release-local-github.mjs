// The github-script steps use the same REST endpoints locally. No Actions
// artifact, workflow-run identity or OIDC authority is fabricated here.
export function localGithub(token, fetchImpl = fetch, signal) {
  const deadline = milliseconds => AbortSignal.any([AbortSignal.timeout(milliseconds), ...(signal ? [signal] : [])]);
  async function request(method, path, body, binary = false) {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: deadline(60_000),
    });
    if (!response.ok) {
      const error = new Error(`GitHub ${method} ${path.split('?')[0]} returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return { data: binary ? await response.arrayBuffer() : response.status === 204 ? null : await response.json() };
  }
  const repoPath = ({ owner, repo }) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return {
    rest: {
      repos: {
        getReleaseByTag: args => request('GET', `${repoPath(args)}/releases/tags/${encodeURIComponent(args.tag)}`),
        getReleaseAsset: args => request('GET', `${repoPath(args)}/releases/assets/${args.asset_id}`, undefined, true),
        deleteReleaseAsset: args => request('DELETE', `${repoPath(args)}/releases/assets/${args.asset_id}`),
        createRelease: ({ owner, repo, ...body }) => request('POST', `${repoPath({ owner, repo })}/releases`, body),
        uploadReleaseAsset: async ({ owner, repo, release_id, name, data, headers }) => {
          const response = await fetchImpl(`https://uploads.github.com${repoPath({ owner, repo })}/releases/${release_id}/assets?name=${encodeURIComponent(name)}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, ...headers }, body: data, signal: deadline(300_000),
          });
          if (!response.ok) throw new Error(`GitHub asset upload returned HTTP ${response.status}`);
          return { data: await response.json() };
        },
      },
    },
  };
}
