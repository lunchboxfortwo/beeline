import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { codegraphMcpServer, prepareCodegraphIndex } from './codegraph.js';
import type { BodyConfig } from './config.js';
import { resolveCodegraphCommand } from './config.js';

const exec = promisify(execFile);
const roots: string[] = [];
const children: ChildProcess[] = [];

async function unlockTree(dir: string): Promise<void> {
  const cgDir = join(dir, '.codegraph');
  const dbPath = join(cgDir, 'codegraph.db');
  await chmod(dir, 0o755).catch(() => undefined);
  await chmod(cgDir, 0o755).catch(() => undefined);
  await chmod(dbPath, 0o644).catch(() => undefined);
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  for (const root of roots.splice(0)) {
    await unlockTree(root);
    await rm(root, { recursive: true, force: true });
  }
});

function realCodegraphCommand(): string | undefined {
  const repoBin = resolve(process.cwd(), '../../node_modules/.bin/codegraph');
  return resolveCodegraphCommand({ ...process.env, BEELINE_CODEGRAPH_BIN: repoBin });
}

function startMcpClient(
  command: string,
  args: string[],
  cwd: string,
  envEntries: Array<{ name: string; value: string }>,
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const entry of envEntries) env[entry.name] = entry.value;
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let buffer = '';
  let stderr = '';
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed.id === 'number' && pending.has(parsed.id)) {
          pending.get(parsed.id)!(parsed);
          pending.delete(parsed.id);
        }
      } catch {
        // Ignore non-JSON lines.
      }
    }
  });
  let nextId = 1;
  return {
    send(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
      const id = nextId++;
      return new Promise((resolveReply, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`CodeGraph MCP ${method} timed out; stderr:\n${stderr}`)),
          10_000,
        );
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolveReply(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method: string, params: Record<string, unknown>): void {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    close(): void {
      child.stdin.end();
      child.kill();
    },
  };
}

const codegraphBin = realCodegraphCommand();

it.runIf(Boolean(codegraphBin) && process.platform !== 'win32')(
  'opens a read-only checkout index without side files and reopens it after a reindex',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beeline-codegraph-ro-'));
    roots.push(dir);
    await exec('git', ['init', '-q', dir]);
    await writeFile(
      join(dir, 'alpha.ts'),
      'export function alphaHelper() { return 1; }\nexport function callAlpha() { return alphaHelper(); }\n',
    );
    const config = { codegraphCommand: codegraphBin } as BodyConfig;

    // Build and verify in read-only mode.
    expect(await prepareCodegraphIndex(config, dir, { readonly: true })).toBe(true);

    // Lock down the directory and database to read-only so SQLite cannot create -wal/-shm side files.
    const cgDir = join(dir, '.codegraph');
    const dbPath = join(cgDir, 'codegraph.db');
    await chmod(dbPath, 0o444);
    await chmod(cgDir, 0o555);
    await chmod(dir, 0o555);

    // prepareCodegraphIndex on an already-indexed read-only directory verifies via a test query.
    expect(await prepareCodegraphIndex(config, dir, { readonly: true })).toBe(true);

    const server = codegraphMcpServer(config, dir, { readonly: true })!;
    const client = startMcpClient(server.command, server.args, dir, server.env ?? []);
    try {
      await client.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codegraph-test', version: '1.0.0' },
      });
      client.notify('notifications/initialized', {});

      const first = (await client.send('tools/call', {
        name: 'codegraph_explore',
        arguments: { query: 'alphaHelper', projectPath: dir },
      })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      expect(first.result?.isError).not.toBe(true);
      const firstText = (first.result?.content ?? []).map((entry) => entry.text ?? '').join('\n');
      expect(firstText).toContain('alphaHelper');
      expect(await readdir(cgDir)).toEqual(['.gitignore', 'codegraph.db']);

      // Simulate a host reindex while the read-only MCP session remains open.
      await unlockTree(dir);
      await writeFile(
        join(dir, 'beta.ts'),
        'export function betaReindexedSymbol() { return 2; }\n',
      );
      expect(await prepareCodegraphIndex(config, dir, { readonly: true })).toBe(true);
      await chmod(dbPath, 0o444);
      await chmod(cgDir, 0o555);
      await chmod(dir, 0o555);

      const second = (await client.send('tools/call', {
        name: 'codegraph_explore',
        arguments: { query: 'betaReindexedSymbol', projectPath: dir },
      })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      expect(second.result?.isError).not.toBe(true);
      const secondText = (second.result?.content ?? []).map((entry) => entry.text ?? '').join('\n');
      expect(secondText).toContain('betaReindexedSymbol');
      expect(await readdir(cgDir)).toEqual(['.gitignore', 'codegraph.db']);
    } finally {
      client.close();
    }
  },
  20_000,
);

it.runIf(Boolean(codegraphBin) && process.platform !== 'win32')(
  'does not report ready when the index cannot answer a test query',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beeline-codegraph-broken-'));
    roots.push(dir);
    await exec('git', ['init', '-q', dir]);
    await writeFile(join(dir, 'broken.ts'), 'export const value = 1;\n');
    const config = { codegraphCommand: codegraphBin } as BodyConfig;

    expect(await prepareCodegraphIndex(config, dir, { readonly: true })).toBe(true);

    // Corrupt the database and lock the directory read-only so sync cannot rewrite it.
    const cgDir = join(dir, '.codegraph');
    const dbPath = join(cgDir, 'codegraph.db');
    await writeFile(dbPath, 'corrupt sqlite header');
    await chmod(dbPath, 0o444);
    await chmod(cgDir, 0o555);
    await chmod(dir, 0o555);

    expect(await prepareCodegraphIndex(config, dir, { readonly: true })).toBe(false);
  },
  20_000,
);
