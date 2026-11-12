import { describe, expect, it } from 'vitest';
import type { AttachmentReference } from '@beeline/buzz-client';
import { messageArtifactGroup } from './artifact-group';

const file = (name: string, mimeType: string, extra: Partial<AttachmentReference> = {}): AttachmentReference =>
  ({ url: `/v1/media/${name}`, name, mimeType, size: 10, kind: 'artifact', ...extra });

describe('one stacked card per message', () => {
  it('keeps the single card for one file', () => {
    expect(messageArtifactGroup([file('a.png', 'image/png')])).toBeUndefined();
    expect(messageArtifactGroup(undefined)).toBeUndefined();
  });
  it('stacks two files in message order', () => {
    const files = [file('a.png', 'image/png'), file('b.png', 'image/png')];
    expect(messageArtifactGroup(files)).toEqual(files);
  });
  it('stacks mixed types together, photos included', () => {
    const files = [file('shot.png', 'image/png'), file('mock.html', 'text/html'), file('spec.pdf', 'application/pdf'), file('data.zip', 'application/zip')];
    expect(messageArtifactGroup(files)).toEqual(files);
  });
  it('leaves an expired file out of the stack', () => {
    const live = [file('a.png', 'image/png'), file('b.html', 'text/html')];
    const expired = file('old.pdf', 'application/pdf', { expired: true });
    expect(messageArtifactGroup([live[0]!, expired, live[1]!])).toEqual(live);
    expect(messageArtifactGroup([live[0]!, expired])).toBeUndefined();
  });
  it('leaves out non-artifact uploads and files the message shows another way', () => {
    const viewed = file('viewed.png', 'image/png');
    const upload = file('note.txt', 'text/plain', { kind: undefined });
    const rest = [file('a.png', 'image/png'), file('b.html', 'text/html')];
    expect(messageArtifactGroup([viewed, upload, ...rest], (_file, index) => index === 0)).toEqual(rest);
    expect(messageArtifactGroup([viewed, rest[0]!], (_file, index) => index === 0)).toBeUndefined();
  });
});
