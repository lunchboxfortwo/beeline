import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const scan = () =>
  JSON.parse(
    execFileSync(process.execPath, ['packages/scripts/provider-special-cases.mjs', '--json'], {
      cwd: root,
      encoding: 'utf8',
    }),
  );

it('keeps provider key literals and SQL values inside provider adapters', () => {
  const result = scan();
  expect(result.findings, JSON.stringify(result.findings, null, 2)).toEqual([]);
  expect(result.total).toBe(0);
});

it.each([
  ['template key', 'export const x = `linear`;', 'linear'],
  ['quoted SQL', `export const x = "SELECT * FROM workspace_apps WHERE app_key='slack'";`, 'slack'],
  ['quoted key', "export const x = 'linear';", 'linear'],
  [
    'template SQL',
    "export const x = `SELECT * FROM workspace_apps WHERE app_key='slack'`;",
    'slack',
  ],
])('rejects a shared provider special case in %s', (_name, source, key) => {
  const directory = mkdtempSync(join(root, 'apps/server/src/provider-scan-fixture-'));
  try {
    writeFileSync(join(directory, 'shared.ts'), source);
    const result = scan();
    expect(result.findings).toEqual([
      { file: `${directory.slice(root.length)}/shared.ts`, line: 1, key },
    ]);
    expect(result.total).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
