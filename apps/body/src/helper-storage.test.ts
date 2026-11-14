import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { storageOperation } from './helper-storage.js';

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
