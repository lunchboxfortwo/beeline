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
      'SELECT attachments FROM messages WHERE id=$1', [posted.messageId],
    )).rows[0]!;
    const attachment = message.attachments[0]!;
    expect(attachment).toMatchObject({ mimeType, name });
    expect(artifactFormat(attachment.mimeType)).toBe('image');
    expect((await scope.db.query('SELECT mime,title FROM objects WHERE id=$1', [attachment.url.split('/').at(-1)])).rows)
      .toEqual([{ mime: mimeType, title: name }]);
    const room = await scope.phone.readRoom(ROOM, USER);
    expect(room?.messages.find(message => message.id === posted.messageId)?.attachments?.[0])
      .toMatchObject({ mimeType, name, kind: 'artifact' });
  });

  it('keeps the existing optional mime argument for content without a binary signature', async () => {
    const { client } = await scope.connected();
    const posted = await tools.ok(client, 'post_artifact', {
      address: ROOM, title: 'notes.txt', mime: 'text/plain', bytes: Buffer.from('Notes').toString('base64'),
    });
    expect((await scope.db.query('SELECT attachments FROM messages WHERE id=$1', [posted.messageId])).rows[0])
      .toMatchObject({ attachments: [{ mimeType: 'text/plain', name: 'notes.txt' }] });
  });

  /** Post a file, then read its message and open the attachment it lists. */
  async function openPosted(args: Record<string, unknown>) {
    const { client } = await scope.connected();
    const posted = await tools.ok(client, 'post_artifact', { address: ROOM, ...args });
    const message = await tools.ok(client, 'read', { facet: 'message', address: ROOM, messageId: posted.messageId });
    const attachmentId = message.attachments[0].attachmentId;
    expect(posted).toMatchObject({objectId:attachmentId,queued:false,published:true});
    expect(posted).not.toHaveProperty('id');
    const opened = await client.callTool({ name: 'read', arguments: {
      facet: 'attachment', address: ROOM, messageId: posted.messageId, attachmentId,
    } }) as { isError?: boolean; content: Record<string, any>[] };
    expect(opened.isError, JSON.stringify(opened.content)).toBeFalsy();
    return { attachmentId, messageId:posted.messageId, content: opened.content };
  }

  it('returns an attached image as an image block with its bytes', async () => {
    const bytes = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#556677' } }).png().toBuffer();
    const { attachmentId, messageId, content } = await openPosted({ title: 'Shot', bytes: bytes.toString('base64') });
    expect(JSON.parse(content[0]!.text).data).toEqual({ attachmentId, messageId, name: 'Shot.png', mimeType: 'image/png', size: bytes.length });
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
  it('refuses malformed attachment IDs and uses null for a brief-only source', async () => {
    const {client,member} = await scope.connected();
    const corner = await tools.reportCorner(member);
    const brief = await tools.ok(client,'post_artifact',{
      address:corner,title:'proof.txt',mime:'text/plain',bytes:Buffer.from('Brief proof').toString('base64'),
    });
    await scope.db.query('DELETE FROM messages WHERE id=$1',[brief.messageId]);
    await scope.db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,spec,objective,author_id,source_room_id,attachments)
      VALUES($1,(SELECT COALESCE(max(revision),0)+1 FROM corner_brief_revisions WHERE corner_id=$1),'Brief evidence','Verify proof',$2,$3,$4::jsonb)`,
      [corner,member,ROOM,JSON.stringify([{objectId:brief.objectId,title:'proof.txt',mime:'text/plain',size:11}])]);
    const result = await client.callTool({name:'read', arguments:{facet:'attachment',address:corner,attachmentId:brief.objectId}});
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as {text:string}[])[0]!.text).data)
      .toMatchObject({attachmentId:brief.objectId,messageId:null});
    expect(await tools.call(client,'read',{facet:'attachment',address:corner,attachmentId:'malformed'}))
      .toEqual({error:true,text:'Request refused: no attachment with this id is visible from this address.'});
  });

});
