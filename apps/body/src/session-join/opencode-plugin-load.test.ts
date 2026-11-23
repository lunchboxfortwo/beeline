import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { fill, OPENCODE_PLUGIN, ownedCommandSource } from './templates.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' });

/**
 * The plugin as setup installs it: its owned module as a file beside it, a
 * hook stand-in that answers a poll only once a delivery is ready, and a
 * driver that reports an idle session, then writes a durable delivery.
 */
function installed(): { dir: string; driver: string } {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-plugin-'));
  folders.push(dir);
  const owned = join(dir, 'beeline-opencode-owned.mjs');
  writeFileSync(owned, ownedCommandSource());
  const hook = join(dir, 'hook.mjs');
  writeFileSync(
    hook,
    `import { existsSync } from 'node:fs';
     process.stdin.resume();
     process.stdin.on('end', () => {
       if (process.argv.includes('poll') && existsSync(${JSON.stringify(join(dir, 'ready'))}))
         process.stdout.write('delivered\\n');
     });`,
  );
  const plugin = join(dir, 'beeline.ts');
  writeFileSync(plugin, fill(OPENCODE_PLUGIN, process.execPath, hook, owned));
  const driver = join(dir, 'driver.mjs');
  writeFileSync(
    driver,
    `import { mkdirSync, writeFileSync } from 'node:fs';
     const plugin = (await import(${JSON.stringify(plugin)})).default;
     const prompts = [];
     let prompted;
     const next = () => new Promise((done) => { prompted = done; });
     const hooks = await plugin.server({ client: { session: { promptAsync: async (input) => {
       prompts.push(input.body.parts[0].text); prompted?.();
     } } }, directory: ${JSON.stringify(dir)} });
     await hooks.event({ event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } } });
     // Nothing waited yet. A delivery written now must reach the idle session with no further host hook.
     const arrived = next();
     writeFileSync(${JSON.stringify(join(dir, 'ready'))}, '');
     mkdirSync(${JSON.stringify(join(dir, 'beeline-sessions', 'deliveries', 'k'))}, { recursive: true });
     writeFileSync(${JSON.stringify(join(dir, 'beeline-sessions', 'deliveries', 'k', 'd.pending'))}, '{}');
     await arrived;
     await hooks.dispose();
     console.log(JSON.stringify(prompts));`,
  );
  mkdirSync(join(dir, 'beeline-sessions'), { recursive: true });
  return { dir, driver };
}

it('delivers to an idle opencode session on a durable delivery, with no further host hook', () => {
  const { dir, driver } = installed();
  const result = spawnSync(process.execPath, ['--import', 'tsx', driver], {
    encoding: 'utf8',
    env: { ...process.env, XDG_STATE_HOME: dir },
    timeout: 20_000,
  });
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual(['delivered']);
});

// opencode runs its plugins under Bun, which cannot import the owned module as a data URL.
it.runIf(!bun.error && bun.status === 0)('loads and delivers under Bun', () => {
  const { dir, driver } = installed();
  const result = spawnSync('bun', [driver], {
    encoding: 'utf8',
    env: { ...process.env, XDG_STATE_HOME: dir },
    timeout: 20_000,
  });
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual(['delivered']);
});
