import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBDatabase as Database, IDBObjectStore as ObjectStore } from 'fake-indexeddb';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-file-system/legacy', () => ({}));
import { createArtifactByteStore } from './artifact-byte-store';

let db: IDBDatabase;
const transactions: IDBTransaction[] = [];
const originalTransaction = Database.prototype.transaction;

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('beeline-immutable-bytes-v1', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('objects', { keyPath: 'key' });
      request.result.createObjectStore('metadata', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  transactions.length = 0;
  vi.spyOn(Database.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args) {
    const transaction = originalTransaction.apply(this, args);
    transactions.push(transaction);
    return transaction;
  });
  let clock = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
});
afterEach(() => {
  for (const transaction of transactions) transaction.db.close();
  db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function rows(store: 'objects' | 'metadata'): Promise<{ key: string; size: number; used: number; bytes?: ArrayBuffer }[]> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store);
    const request = transaction.objectStore(store).getAll();
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
  });
}

function interceptNextTransaction(inspect: (transaction: IDBTransaction) => void) {
  vi.mocked(Database.prototype.transaction).mockImplementationOnce(function (this: IDBDatabase, ...args) {
    const transaction = originalTransaction.apply(this, args);
    transactions.push(transaction); inspect(transaction); return transaction;
  });
}

describe('immutable web byte store with IndexedDB transactions', () => {
  it('round-trips offset views, copies bytes, updates metadata, and supports misses/remove/clear', async () => {
    const store = createArtifactByteStore();
    expect(await store.get('missing')).toBeNull();
    const source = new Uint8Array([99, 1, 2, 99]);
    await store.set('one', source.subarray(1, 3)); source.fill(8);
    const written = (await rows('metadata'))[0];
    const restored = await store.get('one');
    expect(restored).toEqual(new Uint8Array([1, 2])); restored!.fill(9);
    expect(await store.get('one')).toEqual(new Uint8Array([1, 2]));
    expect((await rows('metadata'))[0]).toMatchObject({ key: 'one', size: 2 });
    expect((await rows('metadata'))[0].used).toBeGreaterThan(written.used);
    await store.set('one', new Uint8Array([3]));
    expect(await rows('metadata')).toHaveLength(1);
    expect((await rows('metadata'))[0].size).toBe(1);
    expect(await store.get('one')).toEqual(new Uint8Array([3]));
    await store.set('two', new Uint8Array([4]));
    await store.remove('one'); await store.remove('missing');
    expect(await store.get('one')).toBeNull();
    expect((await rows('metadata')).map(row => row.key)).toEqual(['two']);
    expect((await rows('objects')).map(row => row.key)).toEqual(['two']);
    expect(await store.localUri('two')).toBeNull();
    await store.clear();
    expect(await rows('objects')).toEqual([]); expect(await rows('metadata')).toEqual([]);
  });

  it('evicts the least recently read entry at the entry limit and preserves the new entry', async () => {
    const store = createArtifactByteStore();
    for (let i = 0; i < 512; i++) await store.set(`key-${i}`, new Uint8Array([i % 256]));
    await store.get('key-0');
    await store.set('new', new Uint8Array([7]));
    expect(await store.get('key-1')).toBeNull();
    expect(await store.get('key-0')).toEqual(new Uint8Array([0]));
    expect(await store.get('new')).toEqual(new Uint8Array([7]));
    expect(await rows('metadata')).toHaveLength(512);
    expect(await rows('objects')).toHaveLength(512);
  });

  it('enforces object and disk limits, including same-key replacements', async () => {
    const store = createArtifactByteStore(); const bytes = new Uint8Array(25 * 1024 * 1024);
    for (let i = 0; i < 5; i++) await store.set(`key-${i}`, bytes);
    await store.set('key-0', bytes);
    await store.set('new', new Uint8Array(2 * 1024 * 1024));
    expect(await store.get('key-1')).toBeNull();
    expect((await store.get('key-0'))?.byteLength).toBe(bytes.byteLength);
    expect((await rows('metadata')).reduce((total, row) => total + row.size, 0)).toBe(102 * 1024 * 1024);
    await expect(store.set('key-0', new Uint8Array(bytes.byteLength + 1))).rejects.toThrow('budget');
    expect((await store.get('key-0'))?.byteLength).toBe(bytes.byteLength);
  });

  it('does not restore corrupted rows or refresh their metadata', async () => {
    const store = createArtifactByteStore();
    await store.set('bad', new Uint8Array([1]));
    const before = await rows('metadata');
    await new Promise<void>(resolve => {
      const transaction = db.transaction('objects', 'readwrite');
      transaction.objectStore('objects').put({ key: 'bad', bytes: new ArrayBuffer(1), size: 2, used: 1 });
      transaction.oncomplete = () => resolve();
    });
    expect(await store.get('bad')).toBeNull(); expect(await rows('metadata')).toEqual(before);
  });

  it.each(['get', 'set', 'remove', 'clear'] as const)('rejects %s on abort and leaves both stores unchanged', async method => {
    const store = createArtifactByteStore(); await store.set('held', new Uint8Array([1]));
    const before = await rows('metadata');
    interceptNextTransaction(transaction => queueMicrotask(() => transaction.abort()));
    const result = method === 'set' ? store.set('held', new Uint8Array([2]))
      : method === 'clear' ? store.clear() : store[method]('held');
    await expect(result).rejects.toBeNull();
    expect(await rows('metadata')).toEqual(before);
    expect(await store.get('held')).toEqual(new Uint8Array([1]));
  });

  it('keeps read bytes private until metadata commits, and rejects if that commit aborts', async () => {
    const store = createArtifactByteStore(); await store.set('held', new Uint8Array([1]));
    const before = await rows('metadata'); let settled = false; let checked = false;
    const originalPut = ObjectStore.prototype.put;
    vi.spyOn(ObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = originalPut.apply(this, args);
      if (this.name === 'metadata') request.addEventListener('success', () => {
        expect(settled).toBe(false); checked = true; this.transaction.abort();
      });
      return request;
    });
    const result = store.get('held'); result.then(() => { settled = true; }, () => { settled = true; });
    await expect(result).rejects.toBeNull(); expect(checked).toBe(true);
    expect(await rows('metadata')).toEqual(before);
  });

  it('rolls back a staged object if synchronous metadata setup fails', async () => {
    const store = createArtifactByteStore(); await store.set('held', new Uint8Array([1]));
    const before = await rows('metadata'); const failure = new Error('synthetic metadata setup failure');
    const originalPut = ObjectStore.prototype.put;
    vi.spyOn(ObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'metadata') throw failure;
      return originalPut.apply(this, args);
    });
    await expect(store.set('held', new Uint8Array([2]))).rejects.toBe(failure);
    vi.mocked(ObjectStore.prototype.put).mockRestore();
    expect(await rows('metadata')).toEqual(before);
    expect(await store.get('held')).toEqual(new Uint8Array([1]));
  });

  it('propagates a real request error and rolls back the transaction', async () => {
    const store = createArtifactByteStore(); await store.set('held', new Uint8Array([1]));
    const before = await rows('metadata');
    let requestError: DOMException | null = null;
    interceptNextTransaction(transaction => {
      const request = transaction.objectStore('metadata').add({ key: 'held', size: 9, used: 9 });
      request.addEventListener('error', () => { requestError = request.error; });
    });
    // The bubbled error precedes transaction.error being set on abort.
    await expect(store.set('held', new Uint8Array([2]))).rejects.toBeNull();
    expect(requestError).toMatchObject({ name: 'ConstraintError' });
    expect(await rows('metadata')).toEqual(before);
    expect(await store.get('held')).toEqual(new Uint8Array([1]));
  });
});
