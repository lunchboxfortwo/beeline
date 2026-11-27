import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, type Stats } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** A bounded endpoint, independent of home/install paths and macOS TMPDIR. */
export function privateSocketPath(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 32);
  // /var/tmp remains visible to Room clients whose /tmp is a private namespace.
  return `/var/tmp/beeline-${process.getuid!()}-${hash}/control.sock`;
}

export async function preparePrivateSocketDirectory(path: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  assertPrivateSocketDirectory(directory, await lstat(directory));
}

export function preparePrivateSocketDirectorySync(path: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivateSocketDirectory(directory, lstatSync(directory));
}

function assertPrivateSocketDirectory(directory: string, entry: Stats): void {
  if (!entry.isDirectory() || entry.uid !== process.getuid!() || (entry.mode & 0o077) !== 0)
    throw new Error(`expected a private helper control directory: ${directory}`);
}
