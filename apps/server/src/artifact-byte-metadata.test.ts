import { describe, expect, it } from 'vitest';
import { artifactByteMetadata, artifactByteMime } from './artifact-byte-metadata.js';

describe('binary artifact signatures', () => {
  it.each([
    ['ffd8ffe0', 'image/jpeg', '.jpg'],
    ['89504e470d0a1a0a', 'image/png', '.png'],
    ['474946383761', 'image/gif', '.gif'],
    ['474946383961', 'image/gif', '.gif'],
    ['524946460000000057454250', 'image/webp', '.webp'],
    ['255044462d312e37', 'application/pdf', '.pdf'],
  ])('detects %s and keeps its extension inside the title limit', (hex, mimeType, extension) => {
    const bytes = Buffer.from(hex!, 'hex');
    expect(artifactByteMime(bytes)).toBe(mimeType);
    expect(artifactByteMetadata(bytes, 'application/octet-stream', 'Frame'))
      .toEqual({ mimeType, title: `Frame${extension}` });
    const long = artifactByteMetadata(bytes, 'application/octet-stream', 'a'.repeat(200));
    expect(long.title).toHaveLength(200);
    expect(long.title.endsWith(extension!)).toBe(true);
  });

  it.each(['', 'ffd8', '89504e47', '47494638', '474946383061', '52494646000000004e4f5045'])
    ('leaves unknown or truncated %s bytes generic', hex => {
      expect(artifactByteMime(Buffer.from(hex, 'hex'))).toBeUndefined();
    });

  it('preserves an existing JPEG extension and a specific caller MIME', () => {
    const bytes = Buffer.from('ffd8ffe0', 'hex');
    expect(artifactByteMetadata(bytes, 'application/octet-stream', 'Frame.JPEG'))
      .toEqual({ mimeType: 'image/jpeg', title: 'Frame.JPEG' });
    expect(artifactByteMetadata(bytes, 'text/plain', 'signature.txt'))
      .toEqual({ mimeType: 'text/plain', title: 'signature.txt' });
    expect(artifactByteMetadata(Buffer.from('<html>unknown bytes</html>'), 'application/octet-stream', 'file'))
      .toEqual({ mimeType: 'application/octet-stream', title: 'file' });
  });
});
