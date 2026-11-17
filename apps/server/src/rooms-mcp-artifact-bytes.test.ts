import { artifactFormat } from '../../mobile/sources/buzz/artifact.js';
import {
  describe, expect, fixtureScope1, fixtureScope3, it, ROOM, sharp, USER,
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
});
