import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { relative } from 'node:path';
import { createHash } from 'node:crypto';
import { committedGrantScriptContents, type CommandGrantScript } from '@beeline/api-contract/agent-grants';

const exec = promisify(execFile);

export class OversizedGrantScriptError extends Error {
  constructor(readonly path: string, readonly resolved: string, readonly bytes: Buffer, message: string) {
    super(message);
  }
}

/** Resolve only the bytes committed at this corner PR's current head. */
export async function committedGrantScript(
  script: OversizedGrantScriptError,
  root: string,
  pr: Record<string, unknown>,
): Promise<CommandGrantScript> {
  if (pr.status !== 'ok' || pr.merged || typeof pr.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(pr.headSha) ||
      typeof pr.url !== 'string' || !Array.isArray(pr.files)) throw script;
  const { stdout: top } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: root });
  const repository = await realpath(top.trim());
  const path = relative(repository, await realpath(script.resolved));
  if (!pr.files.some(file => file.filename === path && file.status !== 'removed')) throw script;
  const { stdout: bytes } = await exec('git', ['show', `${pr.headSha}:${path}`], { cwd: repository, encoding: 'buffer', maxBuffer: Infinity });
  if (!bytes.equals(script.bytes)) throw script;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const committed = { commit: pr.headSha, path,
    blobSha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    url: `${pr.url.replace(/\/pull\/\d+$/, '')}/blob/${pr.headSha}/${path.split('/').map(encodeURIComponent).join('/')}` };
  return { path: script.path, sha256, bytes: bytes.length, committed,
    contents: committedGrantScriptContents({ sha256, committed }) };
}
