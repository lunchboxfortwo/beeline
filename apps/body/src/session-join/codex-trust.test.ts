import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { trustCodexHook } from './codex-trust.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A stand-in `codex app-server --stdio` that answers each JSON-RPC id per `answers`, recording its pid. */
async function fakeCodex(
  answers: string,
): Promise<{ bin: string; pid: () => Promise<number>; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codex-trust-'));
  roots.push(root);
  const bin = join(root, 'codex');
  const pidFile = join(root, 'pid');
  await writeFile(
    bin,
    `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const answers = ${answers};
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    const answer = answers[request.method];
    if (answer === 'exit') process.exit(2);
    if (answer === 'eof') { require('node:fs').closeSync(1); return; }
    if (answer !== undefined) process.stdout.write(JSON.stringify({ id: request.id, result: answer }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`,
  );
  await chmod(bin, 0o755);
  return { bin, root, pid: async () => Number(await readFile(pidFile, 'utf8')) };
}

const context = (root: string) => ({
  env: { ...process.env, CODEX_HOME: join(root, 'codex-home') },
  node: process.execPath,
  bundle: join(root, 'bundle.mjs'),
});

// Before: the transient app-server was never killed and outlived the join.
it('ends its codex app-server when trust is decided', async () => {
  const codex = await fakeCodex(`{ initialize: {}, 'hooks/list': { data: [] } }`);
  await expect(trustCodexHook(context(codex.root), codex.bin, codex.root)).resolves.toBe(false);
  const pid = await codex.pid();
  await vi.waitFor(() => expect(alive(pid)).toBe(false));
});

it('does not grant trust, or wait, when the app-server exits before answering', async () => {
  const codex = await fakeCodex(`{ initialize: {}, 'hooks/list': 'exit' }`);
  await expect(trustCodexHook(context(codex.root), codex.bin, codex.root)).resolves.toBe(false);
});

it.each(['initialize', 'hooks/list'])(
  'ends its app-server when stdout closes during %s',
  async (method) => {
    const codex = await fakeCodex(`{ initialize: {}, ${JSON.stringify(method)}: 'eof' }`);
    await expect(trustCodexHook(context(codex.root), codex.bin, codex.root)).resolves.toBe(false);
    const pid = await codex.pid();
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  },
);

it('does not grant trust when codex is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-trust-'));
  roots.push(root);
  await expect(trustCodexHook(context(root), join(root, 'missing-codex'), root)).resolves.toBe(
    false,
  );
});
