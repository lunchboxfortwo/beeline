import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpServerWire } from './acp.js';

// Adapters may serialize the entire MCP declaration into harness argv. Keep
// values in private files and restore them only in the MCP child's environment.
// POSIX quoting keeps descriptor contents literal, including newlines and shell
// metacharacters. The private script replaces its shell with the server.
function shellWord(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }

/** Files live in the session home so the existing sandbox can read them. */
export class McpLaunchFiles {
  private directory?: string;
  private sequence = 0;

  prepare(servers: McpServerWire[], home?: string): McpServerWire[] {
    return servers.map(server => {
      if (!server.env?.length) return server;
      if (!this.directory) {
        const root = home ?? tmpdir();
        mkdirSync(root, { recursive: true });
        this.directory = mkdtempSync(join(root, '.beeline-mcp-'));
      }
      const path = join(this.directory, `${this.sequence++}.sh`);
      const exports = server.env.map(({ name, value }) => {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error('Invalid MCP environment name');
        return `export ${name}=${shellWord(value)}`;
      });
      writeFileSync(path, [...exports,
        `exec ${[server.command, ...(server.args ?? [])].map(shellWord).join(' ')}`, ''].join('\n'),
      { mode: 0o600, flag: 'wx' });
      return { name: server.name, command: '/bin/sh', args: [path], env: [] };
    });
  }

  clear(): void {
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
    this.directory = undefined;
  }
}
