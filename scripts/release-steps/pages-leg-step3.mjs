// Shared by the hosted composite and the local release runner.
export async function run({ github, core, context }) {
const { deployPages } = await import(`${process.env.GITHUB_WORKSPACE}/scripts/deploy-pages.mjs`);
const artifactId = Number(process.env.PAGES_ARTIFACT_ID);
if (!Number.isSafeInteger(artifactId) || artifactId <= 0) throw new Error('Expected an uploaded Pages artifact ID');
await deployPages({ github, repo: context.repo, artifactId,
  sha: context.sha, idToken: await core.getIDToken() });
}
