// Shared by the hosted composite and the local release runner.
export async function run({ context }) {
  const { deployPages } = await import(`${process.env.GITHUB_WORKSPACE}/packages/scripts/deploy-pages.mjs`);
  await deployPages({ directory: `${process.env.RUNNER_TEMP}/usebeeline-pages`,
    sha: context.sha, token: process.env.CLOUDFLARE_PAGES_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID });
}
