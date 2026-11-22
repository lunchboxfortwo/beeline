import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { refreshRuntimeHarnessAdapters } from './self-update-cli.js';
import { readAdapterState } from './adapter-store.js';
import { observe } from './update-progress.js';

// Accelerate only a legacy spawn kill deadline. The actual npm-shaped child,
// adapter lock, candidate installation and atomic promotion remain real.
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: (command: string, args: string[], options: import('node:child_process').SpawnOptions) =>
    actual.spawn(command, args, command === 'npm' && options.timeout
      ? { ...options, timeout: 40 } : options) };
});

it('keeps a progressing adapter installer alive through observer expiry and promotes its result', async () => {
  const home = await mkdtemp(join(tmpdir(), 'beeline-real-installer-'));
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'npm'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const prefix=process.argv[process.argv.indexOf('--prefix')+1];
let n=0; const tick=setInterval(()=>process.stderr.write('npm fixture progress '+(++n)+'\\n'),25);
setTimeout(()=>{clearInterval(tick);const dir=path.join(prefix,'node_modules/.bin');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'pi-acp'),'installed');},240);
`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: join(home, 'data'), PATH: bin + ':' + process.env.PATH };
  const log = vi.fn();
  const work = refreshRuntimeHarnessAdapters({ env, configPaths: ['fixture'],
    readRuntime: async () => ({ agentKind: 'pi' }),
    readRegistry: async () => ({ 'dist-tags': { latest: '1.0.0' }, time: { '1.0.0': '2000-01-01T00:00:00Z' } }),
    checkSession: async ({ command }) => {
      expect(await readFile(command, 'utf8')).toBe('installed');
      return { protocolVersion: 1, agentCapabilities: {} };
    }, log,
  });
  try {
    await expect(observe('adapter dependency convergence', work, { timeoutMs: 80, intervalMs: 30 }))
      .rejects.toThrow('observer stopped waiting');
    expect(readAdapterState('pi', env).active).toBeUndefined();
    await work;
    expect(readAdapterState('pi', env).active?.version).toBe('1.0.0');
    expect(log.mock.calls.flat().join('')).not.toContain('failed');
  } finally { await work; await rm(home, { recursive: true, force: true }); }
});
