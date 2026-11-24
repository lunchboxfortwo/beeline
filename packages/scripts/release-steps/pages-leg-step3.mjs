// Shared by the hosted composite and the local release runner.
import { stagePages } from '../deploy-pages.mjs';

export async function run({ context }) {
  await stagePages({ directory: `${process.env.RUNNER_TEMP}/usebeeline-pages`, sha: context.sha,
    token: process.env.CLOUDFLARE_PAGES_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    branch: process.env.PAGES_BRANCH, output: process.env.PAGES_DEPLOYMENT_JSON });
}
