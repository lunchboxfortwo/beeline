import { dirname, join, resolve } from 'node:path';
import { privateSocketPath } from '../local-socket.js';

/** Keep old endpoints when they fit; reserve enough room for a staged PID too. */
export function bridgeSocketPath(dir: string, pid?: number): string {
  const directory = Buffer.byteLength(join(dir, 'bridge-2147483647.sock')) < 104
    ? dir
    : dirname(privateSocketPath(JSON.stringify(['session-bridge', resolve(dir)])));
  return join(directory, pid === undefined ? 'bridge.sock' : `bridge-${pid}.sock`);
}

/** The serving bridge holds this kernel lock until it exits, so its death is an explicit close. */
export function bridgeOwnerKey(dir: string): string {
  return `beeline-session-bridge-owner:${resolve(dir)}`;
}
