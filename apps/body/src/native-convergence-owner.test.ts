import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';

it('retains native ownership and serialization after the CLI observer process exits', async () => {
  const home = await mkdtemp(join(tmpdir(), 'beeline-native-owner-'));
  const bin = join(home, 'bin');
  const events = join(home, 'events');
  const release = join(home, 'release');
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
if(process.argv[2]==='native-converge-worker') console.log(JSON.stringify({pid:await m.runNativeConvergenceWorker()}));
else try {console.log(await m.convergeNativeHelper({observationMs:Number(process.argv[2])}));} catch(e){console.error(e.message);process.exitCode=1;}
`);
  await writeFile(join(bin, 'systemctl'), `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2).filter(a=>a!=='--user');
fs.appendFileSync(${JSON.stringify(events)},args[0]+'\\n');
if(args[0]==='daemon-reload'&&!fs.existsSync(${JSON.stringify(release)})){
const tick=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(tick);}},20);
}else if(args[0]==='show') console.log('MainPID=4321');
`, { mode: 0o700 });
  const env = { ...process.env, VITEST: '', NODE_ENV: 'native-owner-fixture', HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'), XDG_RUNTIME_DIR: join(home, 'run'),
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + join(home, 'no-bus'),
    BEELINE_LIB_DIR: '', BEELINE_INSTALL_DIR: '', BEELINE_INSTALL_LIB_DIR: '',
    BEELINE_RECOVERY_ENTRY: entry, PATH: bin + ':' + process.env.PATH };
  const execute = promisify(execFile);
  let second: Promise<{ stdout: string; stderr: string }> | undefined;
  try {
    const first = execute(process.execPath, [entry, '1000'], { env })
      .then(value => ({ value }), error => ({ error }));
    await vi.waitFor(async () => expect(await readFile(events, 'utf8')).toBe('daemon-reload\n'), { timeout: 5000 });
    const outcome = await first;
    expect(outcome).toMatchObject({ error: { stderr: expect.stringContaining('owner pid') } });
    if (process.env.BEELINE_OWNER_PROOF === '1' && 'error' in outcome)
      process.stderr.write(outcome.error.stderr);
    const following = execute(process.execPath, [entry, '15000'], { env });
    second = following;
    let waitingForOwner = false;
    following.child.stderr?.on('data', chunk => {
      if (String(chunk).includes('waiting for installer')) waitingForOwner = true;
    });
    await vi.waitFor(() => expect(waitingForOwner).toBe(true), { timeout: 5000 });
    expect(await readFile(events, 'utf8')).toBe('daemon-reload\n');
    await writeFile(release, 'continue');
    const completed = await second;
    expect(completed.stdout.trim()).toBe('4321');
    if (process.env.BEELINE_OWNER_PROOF === '1') {
      process.stderr.write(completed.stderr);
      process.stderr.write('SUCCESS: native owner outlived its CLI; waiting successor completed after lock release\n');
    }
    expect((await readFile(events, 'utf8')).split('\n').filter(line => line === 'start')).toHaveLength(2);
  } finally {
    await writeFile(release, 'continue');
    await second?.catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
}, 25000);
