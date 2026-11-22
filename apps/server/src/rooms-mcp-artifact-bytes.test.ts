import { artifactFormat } from '../../mobile/sources/buzz/artifact.js';
import {
  describe, expect, fixtureScope1, fixtureScope3, it, OTHER, PRIVATE, randomUUID, ROOM, sharp, USER,
} from './test-support-rooms-mcp.test-support.js';

describe('MCP byte artifact metadata', () => {
  const scope = fixtureScope1();
  const tools = fixtureScope3(scope);

  it.each(['jpeg', 'png'] as const)('posts %s bytes with image metadata through the local MCP server', async format => {
    const { client } = await scope.connected();
    const bytes = await sharp({ create: {
      width: 4, height: 3, channels: 3, background: '#334455',
    } }).toFormat(format).toBuffer();
    const mimeType = `image/${format}`;
    const name = `Frame.${format === 'jpeg' ? 'jpg' : format}`;
    const posted = await tools.ok(client, 'post_artifact', {
      address: ROOM, title: 'Frame', bytes: bytes.toString('base64'),
    });
    const message = (await scope.db.query<{ attachments: { url: string; mimeType: string; name: string }[] }>(
      'SELECT attachments FROM messages WHERE id=$1', [posted.id],
    )).rows[0]!;
    const attachment = message.attachments[0]!;
    expect(attachment).toMatchObject({ mimeType, name });
    expect(artifactFormat(attachment.mimeType)).toBe('image');
    expect((await scope.db.query('SELECT mime,title FROM objects WHERE id=$1', [attachment.url.split('/').at(-1)])).rows)
      .toEqual([{ mime: mimeType, title: name }]);
    const room = await scope.phone.readRoom(ROOM, USER);
    expect(room?.messages.find(message => message.id === posted.id)?.attachments?.[0])
      .toMatchObject({ mimeType, name, kind: 'artifact' });
  });

  it('keeps the existing optional mime argument for content without a binary signature', async () => {
    const { client } = await scope.connected();
    const posted = await tools.ok(client, 'post_artifact', {
      address: ROOM, title: 'notes.txt', mime: 'text/plain', bytes: Buffer.from('Notes').toString('base64'),
    });
    expect((await scope.db.query('SELECT attachments FROM messages WHERE id=$1', [posted.id])).rows[0])
      .toMatchObject({ attachments: [{ mimeType: 'text/plain', name: 'notes.txt' }] });
  });

  /** Post a file, then read its message and open the attachment it lists. */
  async function openPosted(args: Record<string, unknown>) {
    const { client } = await scope.connected();
    const posted = await tools.ok(client, 'post_artifact', { address: ROOM, ...args });
    const message = await tools.ok(client, 'read', { facet: 'message', address: ROOM, messageId: posted.id });
    const attachmentId = String(message.attachments[0].url).split('/').at(-1);
    const opened = await client.callTool({ name: 'read', arguments: {
      facet: 'attachment', address: ROOM, messageId: posted.id, attachmentId,
    } }) as { isError?: boolean; content: Record<string, any>[] };
    expect(opened.isError, JSON.stringify(opened.content)).toBeFalsy();
    return { attachmentId, content: opened.content };
  }

  it('returns an attached image as an image block with its bytes', async () => {
    const bytes = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#556677' } }).png().toBuffer();
    const { attachmentId, content } = await openPosted({ title: 'Shot', bytes: bytes.toString('base64') });
    expect(JSON.parse(content[0]!.text).data).toEqual({ attachmentId, name: 'Shot.png', mimeType: 'image/png', size: bytes.length });
    expect(content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') });
  });

  it('returns any other attached file as a resource blob with its bytes', async () => {
    const bytes = Buffer.from('Release notes');
    const { content } = await openPosted({ title: 'notes.txt', mime: 'text/plain', bytes: bytes.toString('base64') });
    expect(content[1]).toMatchObject({ type: 'resource', resource: { mimeType: 'text/plain', blob: bytes.toString('base64') } });
  });

  it('refuses an attachment the member cannot see', async () => {
    const { client } = await scope.connected();
    const hidden = randomUUID();
    await scope.db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES($1,$2,$3,'hidden',$4)`,
      ['e'.repeat(64), PRIVATE, OTHER, JSON.stringify([{ url: `/v1/media/${hidden}`, name: 'secret.png', mimeType: 'image/png' }])]);
    const refused = await tools.call(client, 'read', { facet: 'attachment', address: ROOM, attachmentId: hidden });
    expect(refused).toEqual({ error: true, text: 'Request refused: no attachment with this id is visible from this address.' });
  });
});
