import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { migratedDatabase, MemoryObjectStorage, type PgliteDatabase } from '../test-support.js';
import { ObjectService } from '../object-service.js';
import { backfillArtifactByteMetadata } from './artifact-byte-metadata.js';

const OWNER = 'a'.repeat(64), ROOM = '11111111-1111-4111-8111-111111111111';
let db: PgliteDatabase;
let memory: MemoryObjectStorage;
let objects: ObjectService;
beforeEach(async () => {
  db = await migratedDatabase();
  memory = new MemoryObjectStorage();
  objects = new ObjectService(db, memory.asStorage(), 'https://synthetic.test');
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Artist')`, [OWNER]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [ROOM]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$1,'Proof')`, [ROOM]);
});
afterEach(async () => { vi.restoreAllMocks(); await db.close(); });

it('repairs objects, ordered transcript attachments and pending files once without changing unrelated metadata or storage bytes', async () => {
  // Person upload seeds the exact legacy metadata without going through the
  // fixed artifact writer; the repair covers both durable upload kinds.
  const jpeg = await objects.uploadSharedFile(OWNER, Buffer.from('ffd8ffe0', 'hex'), 'application/octet-stream', 'Frame');
  const png = await objects.uploadSharedFile(OWNER, Buffer.from('89504e470d0a1a0a', 'hex'), 'application/octet-stream', 'Shot.png');
  const unknown = await objects.uploadSharedFile(OWNER, Buffer.from('unknown'), 'application/octet-stream', 'blob.bin');
  const missing = await objects.uploadSharedFile(OWNER, Buffer.from('missing'), 'application/octet-stream', 'gone');
  const missingKey = (await db.query<{ key: string }>('SELECT key FROM objects WHERE id=$1', [missing.objectId])).rows[0]!.key;
  await memory.asStorage().deleteObject(missingKey);
  const attachment = (file: typeof jpeg) => ({ url: file.url, mimeType: file.mimeType, name: file.title, size: file.size, author: 'Artist' });
  const explicit = { ...attachment(jpeg), mimeType: 'text/plain', name: 'explicit.txt' };
  const before = [attachment(unknown), attachment(jpeg), explicit, attachment(png), attachment(jpeg), attachment(missing)];
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES('proof',$1,$2,'Files',$3::jsonb)`, [ROOM, OWNER, JSON.stringify(before)]);
  await db.query(`INSERT INTO agent_pending_attachments(room_id,agent_id,url,name,mime_type,size)
    VALUES($1,$2,$3,'Frame','application/octet-stream',4)`, [ROOM, OWNER, jpeg.url]);
  const storage = memory.asStorage();
  const read = vi.spyOn(storage, 'getObject');
  await backfillArtifactByteMetadata(db, storage);
  expect((await db.query('SELECT mime,title FROM objects WHERE id=$1', [jpeg.objectId])).rows)
    .toEqual([{ mime: 'image/jpeg', title: 'Frame.jpg' }]);
  expect((await db.query('SELECT attachments FROM messages WHERE id=\'proof\'')).rows[0]!.attachments)
    .toEqual([before[0], { ...before[1], mimeType: 'image/jpeg' }, explicit,
      { ...before[3], mimeType: 'image/png' }, { ...before[4], mimeType: 'image/jpeg' }, before[5]]);
  expect((await db.query('SELECT mime_type,name FROM agent_pending_attachments WHERE url=$1', [jpeg.url])).rows)
    .toEqual([{ mime_type: 'image/jpeg', name: 'Frame' }]);
  const stored = [...memory.blobs.values()].find(blob => blob.bytes.equals(Buffer.from('ffd8ffe0', 'hex')))!;
  expect(stored.type).toBe('application/octet-stream');
  const calls = read.mock.calls.length;
  await backfillArtifactByteMetadata(db, storage);
  expect(read).toHaveBeenCalledTimes(calls);
  const redirect = vi.spyOn(storage, 'presignGet');
  await new ObjectService(db, storage, 'https://synthetic.test').readMediaObject(jpeg.objectId);
  expect(redirect).toHaveBeenCalledWith(expect.any(String), { expiresIn: 600, responseContentType: 'image/jpeg' });
});

it('keeps failed storage reads retryable and never records a completed backfill', async () => {
  await objects.uploadSharedFile(OWNER, Buffer.from('ffd8ffe0', 'hex'), 'application/octet-stream', 'Frame');
  const storage = memory.asStorage();
  const read = vi.spyOn(storage, 'getObject').mockRejectedValue(new Error('storage unavailable'));
  await expect(backfillArtifactByteMetadata(db, storage)).rejects.toThrow('storage unavailable');
  expect((await db.query(`SELECT 1 FROM workflow_backfills WHERE name='artifact-byte-metadata-v1'`)).rowCount).toBe(0);
  read.mockRestore();
  await backfillArtifactByteMetadata(db, memory.asStorage());
  expect((await db.query(`SELECT mime FROM objects`)).rows).toEqual([{ mime: 'image/jpeg' }]);
});
