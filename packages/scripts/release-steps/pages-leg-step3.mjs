// Shared by the hosted composite and the local release runner.
export async function run({ context }) {
  const { deployPages, stagePages } = await import(`${process.env.GITHUB_WORKSPACE}/packages/scripts/deploy-pages.mjs`);
  const options = { directory: `${process.env.RUNNER_TEMP}/usebeeline-pages`,
    sha: context.sha, token: process.env.CLOUDFLARE_PAGES_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID };
  const output = process.env.PAGES_DEPLOYMENT_JSON;
  if (output) await stagePages({ ...options, branch: process.env.PAGES_BRANCH, output });
  else await deployPages(options);
}
