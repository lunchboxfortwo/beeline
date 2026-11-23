import { runOwnedFile } from './wait.js';
import { access,appendFile,mkdir,readFile } from 'node:fs/promises';
import { dirname,isAbsolute,resolve } from 'node:path';
import type { McpServerWire } from './acp.js';
import type { BodyConfig } from './config.js';

const execFileAsync = runOwnedFile;

const CODEGRAPH_INDEX_PATH = '.codegraph/codegraph.db';

/** Release-owned, repository-scoped CodeGraph MCP server. */
export function codegraphMcpServer(config: BodyConfig, cwd: string, options: { readonly: boolean }): McpServerWire | undefined {
  if (!config.codegraphCommand) return undefined;
  return {
    name: 'codegraph',
    command: config.codegraphCommand,
    args: ['serve', '--mcp', '--path', resolve(cwd), ...(options.readonly ? ['--no-watch'] : [])],
    // One MCP child per harness session is easier to contain than a daemon
    // that can outlive the place whose index and permissions it used.
    env: [{ name: 'CODEGRAPH_TELEMETRY', value: '0' }, { name: 'CODEGRAPH_NO_DAEMON', value: '1' }],
  };
}

async function isGitWorktree(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
    });
    return resolve(stdout.trim()) === resolve(cwd);
  } catch {
    return false;
  }
}

/** Keep CodeGraph's generated local index out of arbitrary repository changes. */
async function excludeIndexFromGitStatus(cwd: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd,
    });
    const gitPath = stdout.trim();
    if (!gitPath) return;
    const path = isAbsolute(gitPath) ? gitPath : resolve(cwd, gitPath);
    await mkdir(dirname(path), { recursive: true });
    const existing = await readFile(path, 'utf8').catch(() => '');
    if (existing.split('\n').includes('.codegraph/')) return;
    await appendFile(path, `${existing && !existing.endsWith('\n') ? '\n' : ''}.codegraph/\n`);
  } catch {
    // Index hygiene is best-effort and must never block a Room or corner.
  }
}

/**
 * Build or refresh the index before exposing CodeGraph tools. Repository-less
 * surfaces skip this quietly; failures leave the ordinary Beeline read tools
 * available and never prevent session startup.
 */
export async function prepareCodegraphIndex(config: BodyConfig, cwd: string): Promise<boolean> {
  const command = config.codegraphCommand;
  if (!command || !(await isGitWorktree(cwd))) return false;
  await excludeIndexFromGitStatus(cwd);
  const indexPath = resolve(cwd, CODEGRAPH_INDEX_PATH);
  const indexed = await access(indexPath).then(
    () => true,
    () => false,
  );
  const args = indexed ? ['sync', '--quiet', cwd] : ['init', '--yes', cwd];
  try {
    await execFileAsync(command, args, {
      cwd,
      env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_DAEMON: '1' },
      maxBuffer: 4 * 1024 * 1024,
    });
    return true;
  } catch (error) {
    console.warn(
      `[body] CodeGraph ${args[0]} failed for ${cwd}; continuing with Beeline read tools:`,
      error,
    );
    return false;
  }
}
