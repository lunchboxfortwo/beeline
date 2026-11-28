import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installLaunchdTrustySquireBrokerService,
  LAUNCHD_BROKER_LABEL,
  launchdBrokerPlist,
  launchdBrokerPlistPath,
} from './launchd.js';
import {
  SQUIRE_BROKER_UNIT_MARKER_FILE,
  SQUIRE_COMPUTER_USE_MIN_VERSION,
  TRUSTY_SQUIRE_BROKER_UNIT_NAME,
  squireBrokerInstallEntry,
  squireBrokerInstalledVersion,
  squireHostPaths,
  trustySquireBrokerUnit,
  type SquireInstallRunner,
} from './squire-host.js';
import { installTrustySquireBrokerService, systemdBrokerUnitPath } from './systemd.js';

async function writeBrokerPackage(entry: string, version: string): Promise<void> {
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, '');
  await writeFile(join(dirname(entry), '..', 'package.json'), JSON.stringify({ version }));
}

const unit = TRUSTY_SQUIRE_BROKER_UNIT_NAME;
const domain = `gui/${process.getuid?.()}`;
const target = `${domain}/${LAUNCHD_BROKER_LABEL}`;

const installers = [
  {
    platform: 'systemd',
    install: installTrustySquireBrokerService,
    definitionPath: systemdBrokerUnitPath,
    definition: () => trustySquireBrokerUnit(),
    changed: () => [['daemon-reload'], ['enable', unit], ['restart', '--no-block', unit]],
    unchanged: [['daemon-reload'], ['enable', unit], ['start', unit]],
  },
  {
    platform: 'launchd',
    install: installLaunchdTrustySquireBrokerService,
    definitionPath: launchdBrokerPlistPath,
    definition: launchdBrokerPlist,
    changed: (path: string) => [
      ['print', target],
      ['bootout', target],
      ['enable', target],
      ['print', target],
      ['bootstrap', domain, path],
    ],
    unchanged: [['enable', target], ['print', target], ['kickstart', target]],
  },
];

describe.skipIf(process.platform === 'win32').each(installers)('$platform broker installation', (installer) => {
  const { install, definitionPath, definition, changed, unchanged } = installer;
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'squire-broker-service-'));
    env = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      BEELINE_LIB_DIR: join(home, '.local', 'lib', 'beeline'),
    };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function installerOptions(expectedVersion = SQUIRE_COMPUTER_USE_MIN_VERSION) {
    let loaded = true;
    const run = vi.fn(async (args: string[]) => {
      expect(squireBrokerInstalledVersion(home)).toBe(expectedVersion);
      if (args[0] === 'bootout') loaded = false;
      if (args[0] === 'print' && !loaded) throw new Error('job unloaded');
      return { stdout: 'state = running' };
    });
    return { env, run, invocationPath: join(env.BEELINE_LIB_DIR!, 'beeline.js') };
  }

  async function seedUnchangedDefinition() {
    const path = definitionPath(env);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, definition(env));
    await writeBrokerPackage(squireBrokerInstallEntry(home), SQUIRE_COMPUTER_USE_MIN_VERSION);
  }

  it('writes the profile marker before npm and restarts after a package change', async () => {
    await seedUnchangedDefinition();
    const nextVersion = '9.9.9';
    const options = installerOptions(nextVersion);
    const squireInstallRun = vi.fn<SquireInstallRunner>(async (_command, args, { cwd }) => {
      expect(options.run).not.toHaveBeenCalled();
      const paths = squireHostPaths(home);
      const markerPath = join(paths.dir, SQUIRE_BROKER_UNIT_MARKER_FILE);
      const marker = JSON.parse(await readFile(markerPath, 'utf8'));
      expect(marker).toMatchObject({ socket: paths.brokerSocket, accountBinding: null });
      if (args[0] === 'view') return { code: 0, stdout: nextVersion, stderr: '' };
      await writeBrokerPackage(join(cwd, 'node_modules/@trusty-squire/mcp/dist/bin.js'), nextVersion);
      return { code: 0, stderr: '' };
    });

    await install({ ...options, squireInstallRun, squireUpdateMode: 'latest' });

    expect(squireInstallRun.mock.calls.map(([, args]) => args[0])).toEqual(['view', 'install']);
    expect(options.run.mock.calls.map(([args]) => args)).toEqual(changed(definitionPath(env)));
  });

  it('keeps the existing job for an unchanged package and forwards minimum mode', async () => {
    await seedUnchangedDefinition();
    const options = installerOptions();
    const squireInstallRun = vi.fn<SquireInstallRunner>(async () => ({
      code: 0,
      stdout: SQUIRE_COMPUTER_USE_MIN_VERSION,
      stderr: '',
    }));

    await install({ ...options, squireInstallRun, squireUpdateMode: 'minimum' });
    expect(squireInstallRun).not.toHaveBeenCalled();
    expect(options.run.mock.calls.map(([args]) => args)).toEqual(unchanged);

    options.run.mockClear();
    await install({ ...options, squireInstallRun });
    expect(squireInstallRun.mock.calls.map(([, args]) => args[0])).toEqual(['view']);
    expect(options.run.mock.calls.map(([args]) => args)).toEqual(unchanged);
  });

  it('leaves the supervisor and its definition untouched when npm install fails', async () => {
    const options = installerOptions();
    const squireInstallRun: SquireInstallRunner = async (_command, args) =>
      args[0] === 'view'
        ? { code: 0, stdout: SQUIRE_COMPUTER_USE_MIN_VERSION, stderr: '' }
        : { code: 1, stderr: 'install refused' };

    await expect(install({ ...options, squireInstallRun })).rejects.toThrow(
      'Trusty Squire broker install failed: install refused',
    );
    expect(options.run).not.toHaveBeenCalled();
    await expect(readFile(definitionPath(env))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
