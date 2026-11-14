import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpLaunchFiles } from './mcp-launch-files.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
it('execs the target at the launcher PID with literal private environment and arguments', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-launch-test-'));
  const files = new McpLaunchFiles();
  cleanup.push(() => { files.clear(); rmSync(home, { recursive: true, force: true }); });
  const secret = "private '$HOME `id` $(id)\nsecond line\\end";
  const arg = "argument '$HOME `id` $(id)\nend";
  const [launch] = files.prepare([{ name: 'proof', command: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify({pid:process.pid,secret:process.env.MCP_SECRET,arg:process.argv[1]}));process.stdin.resume()', arg],
    env: [{ name: 'MCP_SECRET', value: secret }] }], home);
  expect(JSON.stringify(launch)).not.toContain(secret);
  expect(statSync(launch!.args![0]!).mode & 0o777).toBe(0o600);
  expect(readFileSync(launch!.args![0]!, 'utf8')).toContain('exec ');
  const child = spawn(launch!.command, launch!.args!);
  cleanup.push(() => { child.kill(); });
  const data = await new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', chunk => resolve(String(chunk)));
    child.once('exit', code => reject(new Error(`server exited early: ${code}`)));
  });
  expect(JSON.parse(data)).toEqual({ pid: child.pid, secret, arg });
  child.kill('SIGTERM');
  const exit = await new Promise(resolve => child.once('exit', (_code, signal) => resolve(signal)));
  expect(exit).toBe('SIGTERM');
});
