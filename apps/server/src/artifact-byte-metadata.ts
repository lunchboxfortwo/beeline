import { ARTIFACT_EXTENSIONS_BY_MIME } from '@beeline/api-contract/daemon';

/** Only binary signatures: never promote unknown bytes into executable markup. */
export function artifactByteMime(bytes: Uint8Array):
  'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'application/pdf' | undefined {
  const starts = (signature: readonly number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0x47, 0x49, 0x46, 0x38]) &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  return undefined;
}

export function artifactByteMetadata(bytes: Uint8Array, mimeType: string, title: string): {
  mimeType: string; title: string;
} {
  const detected = mimeType === 'application/octet-stream' ? artifactByteMime(bytes) : undefined;
  if (!detected) return { mimeType, title: title.slice(0, 200) };
  const extensions = ARTIFACT_EXTENSIONS_BY_MIME[detected] as readonly string[];
  const name = title.trim();
  const existing = extensions.find(extension => name.toLowerCase().endsWith(extension));
  const suffix = existing ? name.slice(-existing.length) : extensions[0]!;
  const stem = existing ? name.slice(0, -existing.length) : name;
  return { mimeType: detected, title: `${stem.slice(0, 200 - suffix.length)}${suffix}` };
}
