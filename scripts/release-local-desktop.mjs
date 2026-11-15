// Desktop workflow adapter: native builds on the three authorized hosts, no publication.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { privateWrite } from './release-local-process.mjs';
import { WindowsGuest } from './release-local-windows.mjs';
import { linuxDesktop } from './release-local-desktop-linux.mjs';
import { createDesktopUpdateManifest, nextDesktopVersion } from './desktop-update.mjs';

const DESKTOP_MAC = 'dani@macbook-pro-7';
const root = resolve(import.meta.dirname, '..');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const runtimeFiles = ['release-local-desktop-worker.mjs', 'release-local-actions.mjs', 'release-local-expressions.mjs', 'release-local-process.mjs', 'release-local-java.mjs'];

function updaterCredentials(secrets, directory = secrets.BEELINE_DESKTOP_KEY_DIRECTORY || '/home/lunchbox/firstmate2/data/buzzy-desktop') {
  const value = (name, file) => secrets[name] || readFileSync(join(directory, file), 'utf8').trim();
  return {
    TAURI_UPDATER_PRIVATE_KEY: value('TAURI_UPDATER_PRIVATE_KEY', 'updater.key'),
    TAURI_UPDATER_PRIVATE_KEY_PASSWORD: value('TAURI_UPDATER_PRIVATE_KEY_PASSWORD', 'updater-key.password'),
    TAURI_UPDATER_PUBLIC_KEY: value('TAURI_UPDATER_PUBLIC_KEY', 'updater.key.pub'),
  };
}

export function verifyUpdaterFile(file, publicKey) {
  const lines = text => Buffer.from(text.trim(), 'base64').toString('utf8').trim().split('\n');
  const key = Buffer.from(lines(publicKey)[1], 'base64');
  const signatureLines = lines(readFileSync(`${file}.sig`, 'utf8'));
  const packet = Buffer.from(signatureLines[1], 'base64');
  if (key.length !== 42 || packet.length !== 74 || !key.subarray(2, 10).equals(packet.subarray(2, 10))) throw new Error(`Updater key mismatch: ${basename(file)}`);
  const algorithm = packet.subarray(0, 2).toString();
  if (!['Ed', 'ED'].includes(algorithm)) throw new Error('Unsupported updater signature algorithm');
  const payload = readFileSync(file);
  const digest = algorithm === 'ED' ? createHash('blake2b512').update(payload).digest() : payload;
  const cryptoKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  if (!verify(null, digest, cryptoKey, packet.subarray(10))) throw new Error(`Invalid updater signature: ${basename(file)}`);
  const comment = signatureLines[2]?.replace(/^trusted comment: /, '');
  if (!comment || !verify(null, Buffer.concat([packet.subarray(10), Buffer.from(comment)]), cryptoKey, Buffer.from(signatureLines[3] || '', 'base64'))) throw new Error(`Invalid updater trusted comment: ${basename(file)}`);
  return true;
}

export function stageDesktopSet({ directories, directory, version, releaseVersion, sha, publicKey }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const path of directories) for (const name of readdirSync(path)) cpSync(join(path, name), join(directory, name));
  const required = ['Beeline-universal.dmg', 'Beeline-universal.app.tar.gz', 'Beeline-x86_64.AppImage', 'Beeline-x86_64.deb', 'Beeline-x86_64.rpm', 'Beeline-x86_64-setup.exe', 'Beeline-x86_64.msi'];
  for (const name of required) if (!existsSync(join(directory, name))) throw new Error(`Incomplete desktop set: ${name}`);
  for (const name of ['Beeline-universal.app.tar.gz', 'Beeline-x86_64.AppImage', 'Beeline-x86_64-setup.exe']) verifyUpdaterFile(join(directory, name), publicKey);
  const manifest = createDesktopUpdateManifest({ directory, version, releaseTag: releaseVersion, repository: 'Beeline-Work/beeline', publishedAt: new Date().toISOString() });
  privateWrite(join(directory, 'Beeline-latest.json'), JSON.stringify(manifest, null, 2) + '\n');
  privateWrite(join(directory, 'desktop-stage.json'), JSON.stringify({ sha, desktopVersion: version, releaseVersion, directory,
    files: required.map(name => ({ name, sha256: createHash('sha256').update(readFileSync(join(directory, name))).digest('hex') })), updaterSignaturesVerified: true }, null, 2));
  return manifest;
}

export class DesktopBuild {
  constructor(engine) { this.engine = engine; this.processes = engine.processes; }
  async command(command, args, options = {}) { return this.processes.run(command, args, { env: this.engine.desktopToolEnv || process.env, quiet: true, ...options }); }
  async prepare(context) {
    const directory = join(this.engine.directory, 'desktop-input', context.matrix.label);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const sha = context.inputs.release_sha;
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Desktop build requires immutable release_sha');
    await this.command('git', ['archive', '--format=tar.gz', `--output=${join(directory, 'source.tar.gz')}`, sha], { cwd: this.engine.root });
    const runtime = join(directory, 'runtime');
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    for (const name of runtimeFiles) cpSync(join(root, 'scripts', name), join(runtime, name));
    for (const name of ['yaml', '@actions/expressions']) {
      const target = join(runtime, 'node_modules', name);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(root, 'node_modules', name), target, { recursive: true, dereference: true });
    }
    await this.command('tar', ['-czf', join(directory, 'runtime.tar.gz'), '-C', directory, 'runtime']);
    return directory;
  }
  async appleSecrets(directory, provided) {
    const result = Object.fromEntries(['EXPO_ASC_KEY_ID', 'EXPO_ASC_ISSUER_ID', 'EXPO_ASC_API_KEY_P8', 'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY'].map(name => [name, provided[name] || '']));
    if (!result.APPLE_CERTIFICATE) {
      const password = randomBytes(24).toString('hex');
      this.processes.mask(password);
      // Re-export the already existing Developer ID key; never generate a key.
      const body = `set -euo pipefail\numask 077\nmkdir -p ${quote(directory)}\nopenssl pkcs12 -export -inkey /Users/dani/beeline-devid/devid.key -in /Users/dani/beeline-devid/devid.pem -certfile /Users/dani/beeline-devid/chain.pem -out ${quote(directory + '/signing.p12')} -passout stdin >/dev/null 2>&1\nprintf 'BEELINE_CERTIFICATE='\nbase64 < ${quote(directory + '/signing.p12')} | tr -d '\\n'\nprintf '\\n'\nrm -f ${quote(directory + '/signing.p12')}\n`;
      // Password is stdin data to openssl, never a process argument or log value.
      const encodedBody = Buffer.from(body).toString('base64');
      const command = `/bin/bash -c "$(printf %s ${quote(encodedBody)} | base64 -D)"`;
      const output = await this.command('ssh', ['-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', DESKTOP_MAC, command], { input: password + '\n' });
      result.APPLE_CERTIFICATE = /^BEELINE_CERTIFICATE=([A-Za-z0-9+/=]+)\r?$/m.exec(output)?.[1];
      if (!result.APPLE_CERTIFICATE) throw new Error('Mac did not return a temporary Developer ID export');
      this.processes.mask(result.APPLE_CERTIFICATE);
      result.APPLE_CERTIFICATE_PASSWORD = password;
      result.APPLE_SIGNING_IDENTITY = 'Developer ID Application: Moon Rice Limited (89KT3SWYAF)';
    }
    const missing = Object.keys(result).filter(name => !result[name]);
    if (missing.length) throw new Error(`Missing macOS desktop signing inputs: ${missing.join(', ')}`);
    return result;
  }
  async row(job, context, _label, workflowEnv) {
    const input = await this.prepare(context), matrix = context.matrix;
    const id = createHash('sha256').update(this.engine.directory + matrix.label + context.inputs.release_sha + context.inputs.desktop_version).digest('hex').slice(0, 16);
    const local = join(this.engine.directory, `desktop-${matrix.label}`);
    mkdirSync(local, { recursive: true, mode: 0o700 });
    const remote = matrix.label === 'windows-x86_64' ? `C:/beeline-release-${id}` : matrix.label === 'macos-universal' ? `/tmp/beeline-desktop-${id}` : local;
    let secrets = updaterCredentials(this.engine.secrets);
    for (const value of Object.values(secrets)) this.processes.mask(value);
    if (matrix.label === 'macos-universal') secrets = { ...secrets, ...await this.appleSecrets(remote, this.engine.secrets) };
    // This transport needs no GitHub, R2, npm publication or deployment tokens.
    const spec = { root: remote + '/source', directory: remote + '/state', job,
      secrets, context: { ...context, env: {}, secrets: {}, github: { ...context.github, token: '' } } };
    const specFile = join(local, 'job.json');
    privateWrite(specFile, JSON.stringify(spec));
    const sourceSha = context.inputs.release_sha;
    try {
      if (matrix.label === 'windows-x86_64') await this.windows(input, local, remote, sourceSha);
      else if (matrix.label === 'macos-universal') await this.mac(input, local, remote, sourceSha);
      else {
        mkdirSync(spec.root, { recursive: true });
        await this.command('tar', ['-xzf', join(input, 'source.tar.gz'), '-C', spec.root]);
        await this.command('tar', ['-xzf', join(input, 'runtime.tar.gz'), '-C', local]);
        privateWrite(join(spec.root, '.release-source-sha'), sourceSha);
        await linuxDesktop({ local, spec, specFile, command: (...args) => this.command(...args) });
      }
    } finally {
      // The worker removes its spec on startup; remove it on transport failures too.
      const { rmSync } = await import('node:fs');
      rmSync(specFile, { force: true });
    }
    const result = JSON.parse(readFileSync(join(local, 'state/result.json'), 'utf8'));
    if (result.job.result !== 'success') throw new Error(`Desktop ${matrix.label} failed`);
    const artifact = result.artifacts.find(([name]) => name.startsWith('beeline-desktop-release-'));
    if (!artifact) throw new Error(`Desktop ${matrix.label} returned no installer artifact`);
    const path = join(local, 'state/artifacts', artifact[0]);
    for (const name of ['Beeline-universal.app.tar.gz', 'Beeline-x86_64.AppImage', 'Beeline-x86_64-setup.exe']) if (existsSync(join(path, name))) verifyUpdaterFile(join(path, name), secrets.TAURI_UPDATER_PUBLIC_KEY);
    this.engine.artifacts.set(artifact[0], path);
    if (matrix.label === 'macos-universal') {
      try { await this.command('ssh', [DESKTOP_MAC, `rm -rf -- ${quote(remote)}`], { timeout: 120_000 }); }
      catch (error) { this.processes.log(`Mac installers verified locally; temporary workspace cleanup incomplete: ${error.message}`); }
    }
    return result.job;
  }
  async mac(input, local, remote, sha) {
    await this.command('ssh', [DESKTOP_MAC, `umask 077; mkdir -p ${quote(remote + '/source')}`]);
    await this.command('scp', ['-q', join(input, 'source.tar.gz'), join(input, 'runtime.tar.gz'), join(local, 'job.json'), `${DESKTOP_MAC}:${remote}/`]);
    const body = `set -euo pipefail
export PATH=/usr/local/bin:/opt/homebrew/bin:$HOME/.cargo/bin:$PATH
umask 077
trap 'rm -f "${remote}/job.json"' EXIT
tar -xzf '${remote}/source.tar.gz' -C '${remote}/source'
tar -xzf '${remote}/runtime.tar.gz' -C '${remote}'
printf '%s' '${sha}' > '${remote}/source/.release-source-sha'
if [ ! -x '${remote}/node/bin/node' ]; then
 curl -fsSL https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-x64.tar.gz -o '${remote}/node.tar.gz'
 curl -fsSL https://nodejs.org/dist/v22.23.2/SHASUMS256.txt -o '${remote}/SHASUMS256.txt'
 expected=$(awk '$2=="node-v22.23.2-darwin-x64.tar.gz" {print $1}' '${remote}/SHASUMS256.txt')
 actual=$(shasum -a 256 '${remote}/node.tar.gz' | awk '{print $1}')
 test -n "$expected" && test "$expected" = "$actual"
 mkdir -p '${remote}/node'
 tar -xzf '${remote}/node.tar.gz' -C '${remote}/node' --strip-components=1
fi
export PATH='${remote}/node/bin':$PATH
node '${remote}/runtime/release-local-desktop-worker.mjs' '${remote}/job.json'
`;
    let failure;
    try { await this.command('ssh', [DESKTOP_MAC, 'bash -s'], { input: body, quiet: false, timeout: 90 * 60_000 }); } catch (error) { failure = error; }
    mkdirSync(join(local, 'state'), { recursive: true, mode: 0o700 });
    try {
      await this.command('scp', ['-q', `${DESKTOP_MAC}:${remote}/state/result.json`, join(local, 'state/result.json')]);
      await this.command('scp', ['-q', '-r', `${DESKTOP_MAC}:${remote}/state/artifacts`, join(local, 'state')]);
      for (const name of ['output.log', 'dmg-notarization.json']) {
        try { await this.command('scp', ['-q', `${DESKTOP_MAC}:${remote}/state/jobs/macos-universal/${name}`, join(local, name)]); }
        catch { /* Failed builds may not have reached notarization. */ }
      }
    } catch (error) { if (!failure) throw error; }
    if (failure) throw failure;
  }
  async windows(input, local, remote, sha) {
    const vm = new WindowsGuest(this.processes, local);
    await vm.powershell(`$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force '${remote}/source' | Out-Null
$user=(Get-CimInstance Win32_ComputerSystem).UserName
if (!$user) { throw 'Windows build requires an already logged-in user' }
$acl=New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
foreach ($sid in @('S-1-5-18','S-1-5-32-544')) {
 $identity=New-Object System.Security.Principal.SecurityIdentifier($sid)
 $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
}
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($user,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
Set-Acl -Path '${remote}' -AclObject $acl
if (Test-Path '${remote}/complete') { Remove-Item '${remote}/complete' -Force }
exit 0`);
    for (const file of ['source.tar.gz', 'runtime.tar.gz']) {
      const expected = createHash('sha256').update(readFileSync(join(input, file))).digest('hex');
      const guestFile = file === 'source.tar.gz' ? 'source-input.tar.gz' : 'runtime-input.tar.gz';
      const digest = () => vm.powershell(`if (Test-Path '${remote}/${guestFile}') { [Console]::WriteLine((Get-FileHash '${remote}/${guestFile}' -Algorithm SHA256).Hash) }; exit 0`);
      if ((await digest()).toLowerCase() !== expected) await vm.transfer('upload', join(input, file), `${remote}/${guestFile}`);
      if ((await digest()).toLowerCase() !== expected) throw new Error(`Windows guest ${file} checksum mismatch`);
    }
    await vm.transfer('upload', join(local, 'job.json'), `${remote}/job.json`);
    const script = `$ErrorActionPreference='Stop'
try {
 New-Item -ItemType Directory -Force '${remote}/tools' | Out-Null
 $env:CARGO_HOME='${remote}/tools/cargo'
 $env:RUSTUP_HOME='${remote}/state/tools/rustup'
 if (!(Test-Path "$env:CARGO_HOME/bin/rustup.exe")) {
  [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
  $url='https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe'
  Invoke-WebRequest -UseBasicParsing $url -OutFile '${remote}/tools/rustup-init.exe'
  Invoke-WebRequest -UseBasicParsing "$url.sha256" -OutFile '${remote}/tools/rustup-init.sha256'
  $expected=([IO.File]::ReadAllText('${remote}/tools/rustup-init.sha256').Trim() -split '\\s+')[0]
  $actual=(Get-FileHash '${remote}/tools/rustup-init.exe' -Algorithm SHA256).Hash
  if ($expected -ne $actual) { throw 'rustup-init checksum mismatch' }
  $bootstrap=Start-Process -FilePath '${remote}/tools/rustup-init.exe' -ArgumentList @('-y','--no-modify-path','--default-toolchain','none') -RedirectStandardOutput '${remote}/bootstrap.log' -RedirectStandardError '${remote}/bootstrap-error.log' -NoNewWindow -PassThru
  [void]$bootstrap.Handle
  $bootstrap.WaitForExit()
  if ($bootstrap.ExitCode) { throw 'private rustup bootstrap failed' }
 }
 tar.exe -xzf '${remote}/source-input.tar.gz' -C '${remote}/source'
 if ($LASTEXITCODE) { throw 'source extraction failed' }
 tar.exe -xzf '${remote}/runtime-input.tar.gz' -C '${remote}'
 if ($LASTEXITCODE) { throw 'runtime extraction failed' }
 [IO.File]::WriteAllText('${remote}/source/.release-source-sha','${sha}')
 $process=Start-Process -FilePath 'C:/Program Files/nodejs/node.exe' -ArgumentList @('${remote}/runtime/release-local-desktop-worker.mjs','${remote}/job.json') -RedirectStandardOutput '${remote}/build.log' -RedirectStandardError '${remote}/build-error.log' -NoNewWindow -PassThru
 # Wait only for the worker: Start-Process -Wait can retain its console host.
 [void]$process.Handle
 $process.WaitForExit()
 $code=$process.ExitCode
 if ($code) { throw "Desktop worker failed: $code" }
 tar.exe -czf '${remote}/result.tar.gz' -C '${remote}' state/result.json state/artifacts state/jobs/windows-x86_64/output.log state/jobs/windows-x86_64/summary.md
 if ($LASTEXITCODE) { throw 'artifact packing failed' }
 [IO.File]::WriteAllText('${remote}/complete','success')
} catch { [IO.File]::WriteAllText('${remote}/complete',($_ | Out-String)); exit 1 }
finally { if (Test-Path '${remote}/job.json') { Remove-Item '${remote}/job.json' -Force } }
`;
    const scriptFile = join(local, 'build.ps1');
    privateWrite(scriptFile, script);
    await vm.transfer('upload', scriptFile, `${remote}/build.ps1`);
    await vm.interactive(`${remote}/build.ps1`, `BeelineDesktop-${basename(remote)}`);
    this.processes.log(`Windows native build started; private guest log: ${remote}/build.log`);
    const deadline = Date.now() + 90 * 60_000;
    let lastLogTime = 0, lastTail = '';
    while (Date.now() < deadline) {
      const result = await vm.powershell(`if (Test-Path '${remote}/complete') { Get-Content '${remote}/complete' -Raw }`);
      if (result) {
        for (const name of ['build.log', 'build-error.log', 'bootstrap.log', 'bootstrap-error.log']) {
          try { await vm.transfer('download', join(local, name), `${remote}/${name}`); }
          catch { /* A bootstrap failure may precede the worker's logs. */ }
        }
        if (result !== 'success') throw new Error(`Windows desktop failed: ${result}; see ${local}/build.log`);
        await vm.transfer('download', join(local, 'result.tar.gz'), `${remote}/result.tar.gz`);
        await this.command('tar', ['-xzf', join(local, 'result.tar.gz'), '-C', local]);
        return;
      }
      if (Date.now() - lastLogTime > 60_000) {
        const tail = await vm.powershell(`if (Test-Path '${remote}/build.log') { [Console]::WriteLine((Get-Content '${remote}/build.log' -Tail 8 | Out-String)) }`);
        if (tail && tail !== lastTail) this.processes.log(`Windows build:\n${tail}`);
        lastTail = tail; lastLogTime = Date.now();
      }
      await new Promise(resolve => setTimeout(resolve, 15_000));
    }
    throw new Error(`Windows desktop build timed out; see ${remote}/build.log`);
  }
}

export async function desktopDryRun(engine, context) {
  const previous = await fetch('https://downloads.usebeeline.app/latest/Beeline-latest.json', { signal: AbortSignal.timeout(30_000) }).then(response => { if (!response.ok) throw new Error(`Desktop manifest HTTP ${response.status}`); return response.json(); });
  const version = nextDesktopVersion(previous.version);
  const releaseVersion = engine.variables.desktopReleaseVersion;
  if (!/^v\d+\.\d+\.\d+$/.test(releaseVersion || '')) throw new Error('Desktop proof requires --release-version vX.Y.Z');
  const inputs = { variant: 'production', release_sha: context.github.sha, release_version: releaseVersion, desktop_version: version };
  const workflow = parse(await engine.processes.run('git', ['show', `${context.github.sha}:.github/workflows/desktop.yml`], { cwd: engine.root, env: process.env, quiet: true }));
  const build = new DesktopBuild(engine), paths = [], failures = [];
  // Attempt every platform even when one host has an external blocker.
  for (const matrix of workflow.jobs.build.strategy.matrix.include) {
    try {
      await build.row(workflow.jobs.build, { ...context, inputs, matrix, needs: {}, steps: {}, job: { status: 'success' } });
      paths.push([...engine.artifacts.values()].at(-1));
    } catch (error) { failures.push(`${matrix.label}: ${error.message}`); engine.processes.log(error.message); }
  }
  if (failures.length) throw new Error(`Desktop set incomplete: ${failures.join('; ')}`);
  const directory = join(engine.directory, 'desktop-release');
  stageDesktopSet({ directories: paths, directory, version, releaseVersion, sha: context.github.sha, publicKey: updaterCredentials(engine.secrets).TAURI_UPDATER_PUBLIC_KEY });
  engine.processes.log(`Desktop ${version} staged at ${directory}; no uploads or publication performed.`);
}
