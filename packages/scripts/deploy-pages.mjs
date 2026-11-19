import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

// Direct Upload works from Actions and the local release runner. Production is
// selected explicitly: a detached release checkout must not become a preview.
export async function deployPages({ directory, sha, token, accountId, execute = executeFile }) {
  if (!directory) throw new Error('Expected a built Pages directory');
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Expected an exact release commit');
  if (!token) throw new Error('CLOUDFLARE_PAGES_TOKEN is required for website publication');
  if (!/^[a-f0-9]{32}$/.test(accountId ?? '')) throw new Error('CLOUDFLARE_ACCOUNT_ID is required for website publication');
  const { stdout, stderr } = await execute('npx', [
    '--yes', '--package=wrangler@4.165.0', '--', 'wrangler', 'pages', 'deploy', directory,
    '--project-name=usebeeline', '--branch=main', `--commit-hash=${sha}`, '--commit-dirty=true',
  ], {
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId,
      WRANGLER_SEND_METRICS: 'false', CI: 'true' },
    timeout: 600000, maxBuffer: 8 * 1024 * 1024,
  });
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
}
