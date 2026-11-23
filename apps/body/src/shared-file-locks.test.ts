import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { storeOperatorSecret } from './grant-runner.js';
import { withKernelLockWhenFree } from './kernel-lock.js';
import { readState, updateState, withLock } from './session-join/store.js';

const roots: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'beeline-shared-locks-'));
  roots.push(root);
  return root;
}
/** A pid that is certainly not running: a child that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((done) => child.once('exit', done));
  return child.pid!;
}
/** A live process the test owns, standing in for an older release holding its marker. */
function livePid(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child.pid!;
}

// Astra probe: 16 concurrent callers on one key gave 1 acquisition and 15 ECONNRESETs.
it('every concurrent caller of a short critical section gets its turn, one at a time', async () => {
  const key = `shared-lock-${process.pid}-${Math.random()}`;
  let inside = 0;
  let most = 0;
  const done: number[] = [];
  await Promise.all(
    Array.from({ length: 16 }, (_, index) =>
      withKernelLockWhenFree(key, async () => {
        inside++;
        most = Math.max(most, inside);
        await new Promise((resolve) => setImmediate(resolve));
        inside--;
        done.push(index);
      }),
    ),
  );
  expect(done.sort((a, b) => a - b)).toEqual([...Array(16).keys()]);
  expect(most).toBe(1);
});

it('concurrent session state updates keep every change', async () => {
  const dir = scratch();
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      updateState(dir, (state) => {
        state.sessions.push({ key: `k${index}` } as never);
      }),
    ),
  );
  expect(
    readState(dir)
      .sessions.map((session) => session.key)
      .sort(),
  ).toEqual(Array.from({ length: 12 }, (_, index) => `k${index}`).sort());
  // The legacy marker is released with the lock.
  expect(existsSync(join(dir, 'state.lock'))).toBe(false);
});

it('refuses an older release’s session state marker at once, however old, naming its path', async () => {
  const dir = scratch();
  // An older release holds the lock with an empty directory; age never makes it ours.
  mkdirSync(join(dir, 'state.lock'));
  const ran: string[] = [];
  await expect(withLock(dir, () => ran.push('ran'))).rejects.toThrow(join(dir, 'state.lock'));
  expect(ran).toEqual([]);
  expect(existsSync(join(dir, 'state.lock'))).toBe(true);
});

it('takes over only a session state marker this release left with a dead owner', async () => {
  const dir = scratch();
  mkdirSync(join(dir, 'state.lock'));
  writeFileSync(join(dir, 'state.lock', 'owner'), `${await deadPid()}:crashed`);
  await expect(withLock(dir, () => 'ran')).resolves.toBe('ran');
  expect(existsSync(join(dir, 'state.lock'))).toBe(false);
  mkdirSync(join(dir, 'state.lock'));
  writeFileSync(join(dir, 'state.lock', 'owner'), `${livePid()}:live`);
  await expect(withLock(dir, () => 'ran')).rejects.toThrow(join(dir, 'state.lock'));
});

it('removes an operator secret marker only when its owner pid is dead', async () => {
  const config = scratch();
  const env = { XDG_CONFIG_HOME: config, HOME: config };
  await storeOperatorSecret('FIRST', 'one', env);
  const store = readFileSync(join(config, 'beeline', 'secrets.json'), 'utf8');
  expect(JSON.parse(store)).toEqual({ FIRST: 'one' });
  const lock = join(config, 'beeline', 'secrets.json.lock');
  // A live older holder: refused at once, never taken over by age.
  mkdirSync(lock);
  writeFileSync(join(lock, `${livePid()}:older`), 'x');
  await expect(storeOperatorSecret('SECOND', 'two', env)).rejects.toThrow(lock);
  rmSync(lock, { recursive: true });
  // A marker with no readable owner is ambiguous: refused.
  mkdirSync(lock);
  await expect(storeOperatorSecret('SECOND', 'two', env)).rejects.toThrow(lock);
  rmSync(lock, { recursive: true });
  // A dead owner's marker is removed and the write proceeds.
  mkdirSync(lock);
  writeFileSync(join(lock, `${await deadPid()}:crashed`), 'x');
  await storeOperatorSecret('SECOND', 'two', env);
  expect(JSON.parse(readFileSync(join(config, 'beeline', 'secrets.json'), 'utf8'))).toEqual({
    FIRST: 'one',
    SECOND: 'two',
  });
  expect(existsSync(lock)).toBe(false);
});

it('concurrent operator secret writes keep every secret', async () => {
  const config = scratch();
  const env = { XDG_CONFIG_HOME: config, HOME: config };
  await Promise.all(
    Array.from({ length: 8 }, (_, index) => storeOperatorSecret(`S${index}`, `v${index}`, env)),
  );
  expect(
    Object.keys(JSON.parse(readFileSync(join(config, 'beeline', 'secrets.json'), 'utf8'))).sort(),
  ).toEqual(Array.from({ length: 8 }, (_, index) => `S${index}`).sort());
});
