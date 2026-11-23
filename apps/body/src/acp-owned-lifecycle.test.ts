import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';

const source = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  return process.platform === 'linux' && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
};

it.each(['SIGTERM', 'SIGKILL'] as const)(
  'ends a candidate adapter when its update owner receives %s',
  async (signal) => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-acp-owner-'));
    const adapter = join(root, 'adapter.cjs');
    await writeFile(
      adapter,
      `#!${process.execPath}
console.error('adapter pid '+process.pid);
require('node:net').createServer().listen(0,'127.0.0.1');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);if(r.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{protocolVersion:1,agentCapabilities:{}}})+'\\n');
});`,
      { mode: 0o700 },
    );
    const worker = `import { exitWithOwner } from ${JSON.stringify(source('./owner-link.ts'))};
import { checkAdapterSession } from ${JSON.stringify(source('./adapter-session-check.ts'))};
exitWithOwner();
await checkAdapterSession({command:${JSON.stringify(adapter)},env:{PATH:process.env.PATH,HOME:${JSON.stringify(root)}},
 onStderr:chunk=>console.log(chunk.trim()),onStage:stage=>console.log('stage '+stage)});`;
    const owner = `import { runOwned } from ${JSON.stringify(source('./wait.ts'))};
await runOwned({step:'converge-dependencies',file:process.execPath,ownerLink:true,
 args:['--import','tsx','--input-type=module','-e',${JSON.stringify(worker)}],onLine:line=>console.log(line)});`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', owner], {
      detached: true,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, HOME: root },
    });
    const ended = once(child, 'exit');
    let text = '',
      pid = 0;
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout!.setEncoding('utf8').on('data', (chunk) => {
        text += chunk;
        pid = Number(/adapter pid (\d+)/.exec(text)?.[1] ?? 0);
        if (pid && text.includes('stage session/new')) resolve();
      });
      child.once('exit', () => reject(new Error(`owner exited before candidate startup: ${text}`)));
    });
    try {
      await ready;
      expect(gone(pid)).toBe(false);
      child.kill(signal);
      await ended;
      await vi.waitFor(() => expect(gone(pid)).toBe(true));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await ended;
      if (pid && !gone(pid)) process.kill(pid, 'SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  },
);
