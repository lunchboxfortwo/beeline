// Reuse an exact local JDK, otherwise run the same setup-java action as CI.
import { existsSync, globSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { privateWrite, readOptional } from './release-local-process.mjs';

export async function setupJava({ action, inputs, env, directory, processes, token, timeout, fetchImpl = fetch }) {
  const version = inputs['java-version'];
  const distribution = inputs.distribution;
  if (!version || !distribution) throw new Error('Local setup-java requires java-version and distribution');
  // Only numeric version prefixes can be resolved locally. Let the official
  // action interpret ranges, early-access versions and other distributions.
  if (/^\d+(?:\.\d+)*$/.test(version) && distribution === 'temurin' &&
      (!inputs['java-package'] || inputs['java-package'] === 'jdk') &&
      (!inputs.architecture || inputs.architecture === process.arch) && inputs['check-latest'] !== 'true') {
    const candidates = [env.JAVA_HOME, ...globSync('/usr/lib/jvm/*'), ...globSync('/opt/java/*')].filter(Boolean);
    for (const home of candidates) {
      const release = readOptional(join(home, 'release'));
      const installed = /^JAVA_VERSION="([^"]+)"/m.exec(release)?.[1];
      const vendor = /^IMPLEMENTOR="([^"]+)"/m.exec(release)?.[1];
      if (!(installed === version || installed?.startsWith(`${version}.`)) ||
          vendor !== 'Eclipse Adoptium' ||
          !existsSync(join(home, 'bin/java')) || !existsSync(join(home, 'bin/javac'))) continue;
      await processes.run(join(home, 'bin/java'), ['-version'], { env, quiet: true, timeout });
      await processes.run(join(home, 'bin/javac'), ['-version'], { env, quiet: true, timeout });
      processes.log(`Local setup-java: ${distribution} ${installed} at ${home}`);
      privateWrite(env.GITHUB_ENV, `JAVA_HOME=${home}\n`);
      privateWrite(env.GITHUB_PATH, `${home}/bin\n`);
      privateWrite(env.GITHUB_OUTPUT, `distribution=${distribution}\nversion=${installed}\npath=${home}\n`);
      return;
    }
  }
  const ref = /^actions\/setup-java@(v\d+)$/.exec(action)?.[1];
  if (!ref) throw new Error(`Unsupported setup-java action: ${action}`);
  const target = join(directory, 'actions', `setup-java-${ref}`);
  const manifest = join(target, 'action.yml');
  if (!existsSync(manifest)) {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const response = await fetchImpl(`https://api.github.com/repos/actions/setup-java/tarball/${ref}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`Cannot download ${action} (HTTP ${response.status})`);
    const archive = join(target, 'action.tar.gz');
    privateWrite(archive, Buffer.from(await response.arrayBuffer()));
    await processes.run('tar', ['-xzf', archive, '-C', target, '--strip-components=1'], { env, quiet: true, timeout });
  }
  const definition = parse(readFileSync(manifest, 'utf8'));
  const defaults = Object.fromEntries(Object.entries(definition.inputs).map(([key, value]) => [key, value.default ?? '']));
  const values = { ...defaults, token: token || '', 'job-status': 'success', ...inputs };
  const toolCache = join(directory, 'tool-cache');
  mkdirSync(toolCache, { recursive: true, mode: 0o700 });
  processes.log(`Local setup-java: installing/selecting ${distribution} ${version} with ${action}`);
  await processes.run(process.execPath, [join(target, definition.runs.main)], {
    env: { ...env, RUNNER_TOOL_CACHE: toolCache,
      ...Object.fromEntries(Object.entries(values).map(([key, value]) => [`INPUT_${key.replaceAll(' ', '_').toUpperCase()}`, String(value)])),
    }, quiet: false, timeout,
  });
}
