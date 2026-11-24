import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { reclaimHelperStorage, storageOperation, STORAGE_ITEM_UNUSED_MS } from './helper-storage.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof fs>();
  return { ...original, readdir: vi.fn(original.readdir) };
});

// A readable empty /proc is deterministic and does not inspect the test host.
afterEach(() => vi.restoreAllMocks());
it('shares one in-flight host inventory across nested roots, even after the old refresh interval', async () => {
  let release!: (pids: []) => void;
  const read = vi.mocked(fs.readdir).mockImplementation((async () =>
    await new Promise<[]>(resolve => { release = resolve; })) as typeof fs.readdir);
  const operation = storageOperation({});
  const first = operation.inUse('/one');
  const nested = storageOperation({ ...operation });
  const second = nested.inUse('/two');
  expect(read).toHaveBeenCalledOnce();
  release([]);
  expect(await Promise.all([first, second])).toEqual([false, false]);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_000);
  expect(await nested.inUse('/three')).toBe(false);
  expect(read).toHaveBeenCalledOnce();
  read.mockResolvedValue([] as never);
  expect(await storageOperation({}).inUse('/next-operation')).toBe(false);
  expect(read).toHaveBeenCalledTimes(2);
});
it('retains caller supplied active-use evidence across related operations', async () => {
  const inUse = vi.fn(async (path: string) => path.startsWith('/busy'));
  const operation = storageOperation({ inUse });
  expect(await operation.inUse('/busy/root')).toBe(true);
  expect(await storageOperation(operation).inUse('/idle')).toBe(false);
  expect(operation.inUse).toBe(inUse);
});

it('logs one summary for all files cleared from a Room', async () => {
  const runtimeDir = await fs.mkdtemp(resolve(process.env.XDG_STATE_HOME!, 'reclaim-summary-'));
  try {
    const room = resolve(runtimeDir, 'rooms/room');
    await fs.mkdir(room, { recursive: true });
    const old = new Date(Date.now() - 2 * STORAGE_ITEM_UNUSED_MS);
    for (const name of ['old.sql', 'old.log', 'recent']) {
      const path = resolve(room, name);
      await fs.writeFile(path, name);
      if (name !== 'recent') await fs.utimes(path, old, old);
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const options: Parameters<typeof reclaimHelperStorage>[0] = {
      runtimeDir,
      readStates: async () => [{ roomId: 'room', archived: false }],
      withIdleRoom: async (_, task) => { await task(); return true; },
      inUse: async () => false,
    };

    await reclaimHelperStorage({ ...options, dryRun: true });
    expect(log).not.toHaveBeenCalled();
    const entries = await reclaimHelperStorage(options);
    const bytes = entries.reduce((total, entry) => total + entry.freedBytes, 0);
    expect(await fs.readdir(room)).toEqual(['recent']);
    expect(log.mock.calls).toEqual([[`[helper] storage cleared ${room}; deleted 2 files; freed ${bytes} bytes`]]);

    await reclaimHelperStorage(options);
    expect(log).toHaveBeenCalledOnce();
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});
