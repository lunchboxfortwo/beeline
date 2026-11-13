import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { authority, rootFixture, RUBY, WORKER, ROOM, DM, HUMAN } from '../test-support-commander-recovery.integration.test-support.js';

it('Reproduction files-15: an addressed post delivers the queued file once across replay', async () => {
  const media = randomUUID();
  await rootFixture.db.query(
    `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
     VALUES($1,$2,'artifact',$3,'text/plain','evidence.txt',2,$4,'ready',now()+interval '24 hours')`,
    [media, RUBY, 'artifact/' + media, randomBytes(32).toString('hex')],
  );
  const attachment = { url: 'http://test/v1/media/' + media, name: 'evidence.txt', mimeType: 'text/plain', size: 2 };
  await rootFixture.daemon.execute('postAgentAttachment', { ...authority(rootFixture.order), attachment }, RUBY);
  const input = { ...authority(rootFixture.order), cornerId: ROOM, text: 'evidence.txt attached' };
  const posted = await rootFixture.daemon.execute('postCornerMessage', input, RUBY);
  const read = await rootFixture.daemon.execute('getRoomMessage', { roomId: ROOM, messageId: posted.id }, WORKER);
  expect(read.attachments).toEqual([expect.objectContaining(attachment)]);
  await rootFixture.daemon.execute('postCornerMessage', input, RUBY);
  await rootFixture.daemon.execute('postRoomMessage', { ...authority(rootFixture.order), text: 'Delivery complete' }, RUBY);
  const target = (await rootFixture.phone.readRoom(ROOM, HUMAN))!.messages;
  const source = (await rootFixture.phone.readRoom(DM, HUMAN))!.messages;
  expect([...target, ...source].flatMap(message => message.attachments ?? []).filter(file => file.url === attachment.url)).toHaveLength(1);
  expect((await rootFixture.db.query('SELECT 1 FROM agent_pending_attachments WHERE request_id=$1', [rootFixture.order.turnRequestId])).rowCount).toBe(0);
});
