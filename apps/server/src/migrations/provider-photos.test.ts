import { afterEach, expect, it, vi } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from '../test-support.js';
import { migrateData } from '../database.js';
import { backfillProviderPhotos } from './provider-photos.js';
let db: PgliteDatabase;
afterEach(async () => { vi.restoreAllMocks(); await db?.close(); });
it('backfills missing verified-provider photos, counts people, and preserves existing pictures on repeat', async () => {
  db = await migratedDatabase();
  const ids = ['a','b','c','d'].map(value => value.repeat(64));
  await db.query(`INSERT INTO identities(id,kind,name,avatar) VALUES($1,'human','Missing GitHub',NULL),
    ($2,'human','Uploaded','https://beeline/v1/person-avatars/11111111-1111-4111-8111-111111111111'),
    ($3,'human','Missing Google',NULL),($4,'agent','Agent',NULL)`, ids);
  await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience) VALUES
    ('github','42',$1,'https://github.com','github'),('github','43',$2,'https://github.com','github'),
    ('google','google-sub',$3,'https://accounts.google.com','client'),('github','44',$4,'https://github.com','github')`, ids);
  await db.query(`CREATE TABLE beeline_bind_tickets(subject text,issuer text,audience text,provider_avatar text,consumed_at timestamptz,created_at timestamptz);
    INSERT INTO beeline_bind_tickets VALUES('google-sub','https://accounts.google.com','client','https://lh3.googleusercontent.com/a/photo',now(),now());`);
  const counts = vi.spyOn(console, 'info');
  await db.query("DELETE FROM workflow_backfills WHERE name='provider-photos-v1'");
  await migrateData(db);
  expect(counts).toHaveBeenCalledWith('Provider photo backfill: %d people updated', 2);
  expect((await db.query('SELECT id,avatar FROM identities WHERE id=ANY($1::text[]) ORDER BY id', [ids])).rows).toEqual([
    {id:ids[0],avatar:'https://avatars.githubusercontent.com/u/42'},
    {id:ids[1],avatar:'https://beeline/v1/person-avatars/11111111-1111-4111-8111-111111111111'},
    {id:ids[2],avatar:'https://lh3.googleusercontent.com/a/photo'},
    {id:ids[3],avatar:null},
  ]);
  expect(await backfillProviderPhotos(db)).toBe(0);
});
