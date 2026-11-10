import { dirname, join, resolve } from 'node:path';
import { privateSocketPath } from '../local-socket.js';

/** Keep old endpoints when they fit; reserve enough room for a staged PID too. */
export function bridgeSocketPath(dir: string, pid?: number): string {
  const directory = Buffer.byteLength(join(dir, 'bridge-2147483647.sock')) < 104
    ? dir
    : dirname(privateSocketPath(JSON.stringify(['session-bridge', resolve(dir)])));
  return join(directory, pid === undefined ? 'bridge.sock' : `bridge-${pid}.sock`);
}
