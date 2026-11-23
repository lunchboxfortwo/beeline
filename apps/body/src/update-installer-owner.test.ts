import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { refreshRuntimeHarnessAdapters } from './self-update-cli.js';
import { readAdapterState } from './adapter-store.js';

// A fake npm on PATH answers `npm view` and installs into the candidate prefix,
// printing http-level progress the way `--loglevel=http` does.
const fakeNpm = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const argv=process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(argv)+'\\n');
if (argv[0]==='view') { process.stdout.write(JSON.stringify({'dist-tags':{latest:'1.0.0'},time:{'1.0.0':'2000-01-01T00:00:00Z'}})); process.exit(0); }
const prefix=argv[argv.indexOf('--prefix')+1];
process.stderr.write('npm http fetch GET 200 http://registry.invalid/pi-acp 12ms\\n');
const dir=path.join(prefix,'node_modules/.bin');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'pi-acp'),'installed');
process.stdout.write('added 1 package in 1s\\n');
`;

it('logs the real decision, streams npm with --loglevel=http and promotes; a current adapter installs nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'beeline-real-installer-'));
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'npm'), fakeNpm, { mode: 0o700 });
  const npmLog = join(home, 'npm.log');
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: join(home, 'data'),
    PATH: bin + ':' + process.env.PATH,
    FAKE_NPM_LOG: npmLog,
  };
  const lines: string[] = [];
  const refresh = () =>
    refreshRuntimeHarnessAdapters({
      env,
      configPaths: ['fixture'],
      readRuntime: async () => ({ agentKind: 'pi' }),
      checkSession: async ({ command }) => {
        expect(await readFile(command, 'utf8')).toBe('installed');
        return { protocolVersion: 1, agentCapabilities: {} };
      },
      log: (line) => lines.push(line),
    });
  try {
    await refresh();
    const active = readAdapterState('pi', env).active;
    expect(active?.version).toBe('1.0.0');
    const prefix = active!.command.replace(/\/node_modules\/\.bin\/pi-acp$/, '');
    expect(lines.join('\n')).not.toContain('npm install -g');
    expect(lines).toContain(
      `[beeline] installing pi adapter 1.0.0 (keeping the installed copy until it passes): npm install --prefix ${prefix} --no-save --no-audit --no-fund pi-acp@1.0.0 --omit=optional --loglevel=http --foreground-scripts`,
    );
    expect(lines).toContain('npm http fetch GET 200 http://registry.invalid/pi-acp 12ms');
    expect(lines).toContain('added 1 package in 1s');
    expect(lines).toContain('[beeline] pi adapter promoted to 1.0.0 (was none)');
    const installs = (await readFile(npmLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(installs.filter((argv) => argv[0] === 'install')).toHaveLength(1);

    lines.length = 0;
    await refresh();
    expect(lines).toEqual(['[beeline] pi adapter current at 1.0.0']);
    const after = (await readFile(npmLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(after.filter((argv) => argv[0] === 'install')).toHaveLength(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
