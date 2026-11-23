import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

it.each(['SIGTERM', 'SIGKILL'] as const)('leaves no native owner behind when the CLI receives %s', async signal => {
  // Audit: observers left at 600 s while the detached owner kept the native lock; the next
  // command then waited up to 600 s behind it.
  const home = await mkdtemp(join(tmpdir(), 'beeline-native-owner-'));
  const bin = join(home, 'bin');
  const events = join(home, 'events');
  const entry = join(home, 'entry.mjs');
  await mkdir(bin);
  await mkdir(join(home, '.local/lib'), { recursive: true });
  await writeFile(join(home, '.local/lib/beeline-bootstrap.mjs'), 'fixture');
  await writeFile(events, '');
  const source = fileURLToPath(new URL('./native-helper.ts', import.meta.url));
  const register = createRequire(import.meta.url).resolve('tsx/esm/api');
  await writeFile(entry, `import { register } from ${JSON.stringify(register)};
register();
const m=await import(${JSON.stringify(source)});
if(process.argv[2]==='native-converge-worker') {
  const { exitWithOwner }=await import(${JSON.stringify(fileURLToPath(new URL('./owner-link.ts', import.meta.url)))});
  exitWithOwner();
  console.log(JSON.stringify({pid:await m.runNativeConvergenceWorker()}));
}
else try {console.log(await m.convergeNativeHelper({}));} catch(e){console.error(e.message);process.exitCode=1;}
`);
  // A wedged user manager: daemon-reload never returns.
  await writeFile(join(bin, 'systemctl'), `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2).filter(a=>a!=='--user');
fs.appendFileSync(${JSON.stringify(events)},args[0]+' '+process.pid+'\\n');
if(args[0]==='daemon-reload') setInterval(()=>{},1000);
`, { mode: 0o700 });
  const env = { ...process.env, VITEST: '', NODE_ENV: 'native-owner-fixture', HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'), XDG_RUNTIME_DIR: join(home, 'run'),
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + join(home, 'no-bus'),
    BEELINE_LIB_DIR: '', BEELINE_INSTALL_DIR: '', BEELINE_INSTALL_LIB_DIR: '',
    BEELINE_RECOVERY_ENTRY: entry, PATH: bin + ':' + process.env.PATH };
  const execute = promisify(execFile);
  const running = execute(process.execPath, [entry], { env });
  const first = running.then(value => ({ value }), error => ({ error }));
  try {
    await vi.waitFor(async () => expect(await readFile(events, 'utf8')).toMatch(/^daemon-reload \d+\n$/), { timeout: 10_000 });
    const wedged = Number((await readFile(events, 'utf8')).trim().split(' ')[1]);
    const second = await execute(process.execPath, [entry], { env }).then(value => ({ value }), error => ({ error }));
    expect(second).toMatchObject({ error: { stderr: expect.stringContaining('native service convergence already running as pid') } });
    // The CLI leaves (Ctrl-C/TERM): its owned worker and the wedged systemctl die with it.
    running.child.kill(signal);
    expect(await first).toMatchObject({ error: { signal } });
    await vi.waitFor(() => expect(alive(wedged)).toBe(false), { timeout: 10_000 });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
