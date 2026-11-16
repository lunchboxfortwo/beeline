// Match desktop.yml's Ubuntu 22.04 runner rather than Squire's newer libc.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { privateWrite } from './release-local-process.mjs';

export async function linuxDesktop({ local, spec, specFile, command }) {
  const directory = join(local, 'container');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const install = spec.job.steps.find(step => step.name === 'Install the Linux webview toolchain').run.replaceAll('sudo ', '')
    .replace(/\\\r?\n/g, ' ').trim().split('\n').map(line => line.trim()).join(' && ');
  const dockerfile = `FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y ca-certificates curl build-essential git pkg-config libfuse2 rpm xdg-utils python3 && rm -rf /var/lib/apt/lists/*
RUN ${install}
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
RUN curl -fsSL https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz -o /tmp/node.tar.xz && \\
 curl -fsSL https://nodejs.org/dist/v22.23.2/SHASUMS256.txt -o /tmp/SHA && \\
 test "$(sha256sum /tmp/node.tar.xz | cut -d' ' -f1)" = "$(awk '$2==\"node-v22.23.2-linux-x64.tar.xz\" {print $1}' /tmp/SHA)" && \\
 tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && rm /tmp/node.tar.xz /tmp/SHA
RUN curl -fsSL https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init -o /tmp/rustup-init && \\
 curl -fsSL https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init.sha256 -o /tmp/SHA && \\
 test "$(sha256sum /tmp/rustup-init | cut -d' ' -f1)" = "$(cut -d' ' -f1 /tmp/SHA)" && chmod +x /tmp/rustup-init && \\
 CARGO_HOME=/opt/beeline-rust RUSTUP_HOME=/opt/beeline-rustup /tmp/rustup-init -y --no-modify-path --default-toolchain none && rm /tmp/rustup-init /tmp/SHA
ENV PATH=/opt/beeline-rust/bin:/usr/local/bin:/usr/bin:/bin
`;
  privateWrite(join(directory, 'Dockerfile'), dockerfile);
  const image = `beeline-desktop-linux:${createHash('sha256').update(dockerfile).digest('hex').slice(0, 16)}`;
  await command('docker', ['build', '--tag', image, directory], { quiet: false, timeout: 30 * 60_000 });
  const marker = join(local, 'ubuntu22-target');
  if (!existsSync(marker)) {
    // Only this task's source export; never reuse a newer-host libc build.
    rmSync(join(spec.root, 'apps/mobile/src-tauri/target'), { recursive: true, force: true });
    privateWrite(marker, 'Ubuntu 22.04\n');
  }
  const home = join(local, 'tools/home'), cargo = join(local, 'tools/cargo');
  mkdirSync(home, { recursive: true }); mkdirSync(cargo, { recursive: true });
  await command('docker', ['run', '--rm', '--user', `${process.getuid()}:${process.getgid()}`,
    '--volume', `${local}:${local}`, '--workdir', spec.root, '--env', `HOME=${home}`, '--env', `CARGO_HOME=${cargo}`,
    '--env', 'APPIMAGE_EXTRACT_AND_RUN=1', image, 'node', join(local, 'runtime/release-local-desktop-worker.mjs'), specFile],
  { quiet: false, timeout: 90 * 60_000 });
}
