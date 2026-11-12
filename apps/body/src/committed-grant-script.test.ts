import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { requestGrant } from './read-only-mcp-agent-grant-deps.js';
import { GrantCommandRunner } from './grant-runner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('SCRIPT-PR-8 approves a committed 20 KB script by file and hash, runs it, and refuses changed bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'script-pr-')); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  const contents = '# reviewed proof\n'.repeat(1280) + 'printf approved';
  expect(Buffer.byteLength(contents)).toBeGreaterThan(20_000);
  writeFileSync(join(root, 'proof.sh'), contents);
  git('add', 'proof.sh');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'Reviewed proof');
  const headSha = git('rev-parse', 'HEAD');
  const pr = { status: 'ok', headSha, merged: false, url: 'https://github.com/example/repo/pull/1',
    files: [{ filename: 'proof.sh', status: 'added' }] };
  let asked: Record<string, unknown> | undefined;
  const deps = { roomId: 'corner', scriptRoots: [root], scriptEnv: { PATH: '/usr/bin:/bin' },
    execute: async (op: string, input: Record<string, unknown>) => {
      if (op === 'readCornerPullRequest') return pr;
      expect(op).toBe('requestAgentGrant'); asked = input;
      return { grantId: 'reviewed', status: 'pending', auto: false };
    } };
  const ask = () => requestGrant({ kind: 'command', target: 'bash proof.sh', reason: 'Run reviewed proof', purpose: 'Prove the user path' }, deps);
  await expect(ask()).resolves.toContain('pending');
  expect(asked?.script).toEqual({ path: 'proof.sh', bytes: Buffer.byteLength(contents),
    sha256: createHash('sha256').update(contents).digest('hex'),
    committed: { commit: headSha, path: 'proof.sh', blobSha: git('rev-parse', 'HEAD:proof.sh'), url: `https://github.com/example/repo/blob/${headSha}/proof.sh` },
    contents: expect.not.stringContaining('# reviewed proof') });
  const grant = { ...asked, grantId: 'reviewed', status: 'approved', workspaceId: 'workspace', requestedBy: 'owner' };
  const runner = new GrantCommandRunner({ agentId: 'agent', env: { PATH: '/usr/bin:/bin', HOME: root },
    api: { execute: async (op: string) => op === 'listTurnAgentGrants' ? { grants: [grant] } : {} } as never });
  runner.register('corner', { workspaceId: 'workspace', cwd: root,
    turn: () => ({ requestId: 'request', generationId: 'generation' }), writePolicy: () => ({ surface: 'corner' }) });
  expect(await runner.run({ roomId: 'corner', argv: ['bash', 'proof.sh'] })).toMatchObject({ exitCode: 0, output: 'approved' });
  const bound = asked!.script as { committed: { blobSha: string } };
  const blobSha = bound.committed.blobSha;
  bound.committed.blobSha = 'f'.repeat(40);
  await expect(runner.run({ roomId: 'corner', argv: ['bash', 'proof.sh'] })).rejects.toThrow('script hash does not match');
  bound.committed.blobSha = blobSha;
  writeFileSync(join(root, 'proof.sh'), contents + '\nprintf changed');
  await expect(runner.run({ roomId: 'corner', argv: ['bash', 'proof.sh'] })).rejects.toThrow('script hash does not match');
  await expect(ask()).rejects.toThrow('too long');
  writeFileSync(join(root, 'proof.sh'), contents);
  pr.files = [];
  await expect(ask()).rejects.toThrow('too long');
});
