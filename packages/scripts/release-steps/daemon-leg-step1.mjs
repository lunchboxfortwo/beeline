// Shared by the hosted composite and the local release runner.
export async function run({ github, core, context }) {
const { publishPagesChannel } = await import(`${process.env.GITHUB_WORKSPACE}/packages/scripts/pages-channel.mjs`);
await publishPagesChannel({ github, repo: context.repo, directory: process.env.BUNDLE_DIR,
  channel: process.env.CHANNEL, expectedSha: process.env.RELEASE_SHA, expectedVersion: process.env.RELEASE_VERSION });
}
