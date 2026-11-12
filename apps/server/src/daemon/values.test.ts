import { expect, it } from 'vitest';
import { committedGrantScriptContents, parseCommandGrantTarget } from '@beeline/api-contract/agent-grants';
import type { CornerPullRequestResult } from '@beeline/api-contract/daemon';
import { validateGrantScript } from './values.js';

it('SCRIPT-PR-8 accepts references only for a file in the current corner PR head', () => {
  const commit = 'a'.repeat(40);
  const blobSha = 'd'.repeat(40);
  const committed = { commit, blobSha, path: 'proof.sh', url: `https://github.com/example/repo/blob/${commit}/proof.sh` };
  const script = { path: 'proof.sh', sha256: 'b'.repeat(64), bytes: 21_775, committed, contents: '' };
  script.contents = committedGrantScriptContents(script);
  const pr = { status: 'ok', number: 1, headSha: commit, merged: false,
    url: 'https://github.com/example/repo/pull/1', files: [{ filename: 'proof.sh', status: 'added' }] } as CornerPullRequestResult;
  const rule = parseCommandGrantTarget('bash proof.sh');
  expect(validateGrantScript(rule, script, pr, blobSha)).toEqual(script);
  expect(() => validateGrantScript(rule, script)).toThrow('invalid');
  expect(() => validateGrantScript(rule, script, pr, 'e'.repeat(40))).toThrow('invalid');
  for (const change of [{ headSha: 'c'.repeat(40) }, { files: [] }, { merged: true }]) {
    expect(() => validateGrantScript(rule, script, { ...pr, ...change } as CornerPullRequestResult, blobSha)).toThrow('invalid');
  }
  expect(() => validateGrantScript(rule, { ...script, committed: { ...committed, url: 'https://example.com/other' } }, pr, blobSha)).toThrow('invalid');
  expect(() => validateGrantScript(rule, { ...script, committed: { ...committed, path: '../proof.sh' } }, pr, blobSha)).toThrow('invalid');
  expect(() => validateGrantScript(rule, { ...script, contents: 'unrelated' }, pr, blobSha)).toThrow('invalid');
  expect(() => validateGrantScript(parseCommandGrantTarget('bash -c "printf approved"'), { ...script, path: '<inline>' }, pr, blobSha)).toThrow();
});
