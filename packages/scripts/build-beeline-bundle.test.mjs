import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveAgentBinaries, verifyMacBinaries } from './build-beeline-bundle.mjs';

test('a PATH containing installed helper launchers still compiles pinned native binaries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-agent-resolution-'));
  const saved = { PATH: process.env.PATH, BUZZ_AGENT_BIN: process.env.BUZZ_AGENT_BIN, BUZZ_DEV_MCP_BIN: process.env.BUZZ_DEV_MCP_BIN };
  try {
    const bin = join(directory, 'bin'), tools = join(directory, 'tools'), calls = join(directory, 'calls');
    mkdirSync(bin);
    for (const name of ['buzz-agent', 'buzz-dev-mcp']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
    writeFileSync(join(bin, 'git'), `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
if [ "$1" = clone ]; then
  for last; do :; done
  mkdir -p "$last/.git"
fi
`, { mode: 0o755 });
    writeFileSync(join(bin, 'cargo'), `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
while [ "$#" -gt 0 ]; do
  if [ "$1" = --target-dir ]; then shift; target=$1; fi
  if [ "$1" = --target ]; then shift; triple=$1; fi
  shift
done
target="$target/\${triple:+$triple/}release"
mkdir -p "$target"
for binary in buzz-agent buzz-dev-mcp; do
  printf '\\177ELF' > "$target/$binary"
  chmod +x "$target/$binary"
done
`, { mode: 0o755 });
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    delete process.env.BUZZ_AGENT_BIN;
    delete process.env.BUZZ_DEV_MCP_BIN;
    const platform = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
    const binaries = await resolveAgentBinaries(platform, { toolsDirectory: tools });
    assert.equal(binaries.agent, join(tools, 'target', platform, 'release/buzz-agent'));
    assert.equal(binaries.mcp, join(tools, 'target', platform, 'release/buzz-dev-mcp'));
    const cross = await resolveAgentBinaries('darwin-arm64', { toolsDirectory: tools, host: 'darwin-x64' });
    assert.equal(cross.agent, join(tools, 'target/darwin-arm64/aarch64-apple-darwin/release/buzz-agent'));
    const commands = readFileSync(calls, 'utf8');
    assert.match(commands, /--target aarch64-apple-darwin/);
    assert.match(commands, /--release --locked --package buzz-agent --package buzz-dev-mcp/);
    assert.match(commands, /fetch origin [0-9a-f]{40}/);
    assert.doesNotMatch(commands, /--depth|--shallow/);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('explicit native cache outputs remain usable without a Cargo rebuild', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-agent-cache-'));
  const saved = { BUZZ_AGENT_BIN: process.env.BUZZ_AGENT_BIN, BUZZ_DEV_MCP_BIN: process.env.BUZZ_DEV_MCP_BIN };
  try {
    const agent = join(directory, 'buzz-agent'), mcp = join(directory, 'buzz-dev-mcp');
    for (const file of [agent, mcp]) writeFileSync(file, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });
    process.env.BUZZ_AGENT_BIN = agent;
    process.env.BUZZ_DEV_MCP_BIN = mcp;
    assert.deepEqual(await resolveAgentBinaries('linux-x64'), { agent, mcp });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Mac proof verifies every packaged Mach-O architecture and signature and propagates rejection', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mac-helper-proof-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'bin'));
  mkdirSync(join(directory, 'lib'));
  for (const path of ['bin/buzz-agent', 'bin/buzz-dev-mcp', 'lib/node', 'lib/parser.node', 'lib/script.mjs'])
    writeFileSync(join(directory, path), path);
  const calls = [], inspect = path => path.endsWith('.mjs') ? 'JavaScript source' : 'Mach-O 64-bit executable arm64';
  await verifyMacBinaries(directory, 'darwin-arm64', { inspect, execute: (...args) => calls.push(args) });
  assert.equal(calls.filter(([command]) => command === 'lipo').length, 4);
  assert.equal(calls.filter(([command, args]) => command === 'codesign' && args[0] === '--verify').length, 4);
  assert.ok(calls.filter(([command]) => command === 'lipo').every(([, args]) => args[1] === 'arm64'));
  for (const rejected of ['lipo', 'codesign']) await assert.rejects(verifyMacBinaries(directory, 'darwin-arm64', {
    inspect, execute: (command, args) => {
      if (command === rejected && (command === 'lipo' || args[0] === '--verify')) throw new Error('invalid binary');
    },
  }), /invalid binary/);
});
