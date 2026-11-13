// Download the newest usable map, using its embedded commit rather than the
// dispatch workflow's head SHA (a latest promotion can validate an older SHA).
// Trust comes from one list of recent workflow_dispatch runs. Artifact pages
// join to that list, so a lookup does not fetch each workflow run.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { staleMapReason } from './test-selection.mjs';

export function trustedMapRun(run, { base, head }) {
  if (run.event !== 'workflow_dispatch') return false;
  if (run.path === '.github/workflows/unified-release.yml') return run.head_branch === 'main';
  return run.path === '.github/workflows/checks.yml' && run.conclusion === 'success'
    && [base, head].filter(Boolean).includes(run.head_branch);
}

export function indexRuns(runs) {
  return new Map((runs ?? []).map(run => [String(run.id), run]));
}

// Two list reads, then one zip for the chosen artifact. Not one read per artifact.
export function coverageMapReads(page = 1) {
  return [
    'actions/runs?event=workflow_dispatch&per_page=100',
    `actions/artifacts?name=server-coverage-map&per_page=100&page=${page}`,
  ];
}

export async function newestCoverageMap({ artifacts, runs, run, download, usable, base, head }) {
  const preloaded = runs !== undefined;
  const known = runs instanceof Map ? runs : indexRuns(runs);
  let releaseUnusable = false;
  for (const artifact of [...artifacts].filter(a => !a.expired && a.workflow_run)
    .sort((a, b) => b.id - a.id)) {
    const id = String(artifact.workflow_run.id);
    let source = known.get(id);
    if (!source && !preloaded && run) {
      source = await run(artifact.workflow_run.id);
      if (source) known.set(id, source);
    }
    if (!source || !trustedMapRun(source, { base, head })) continue;
    const releaseRun = source.path === '.github/workflows/unified-release.yml';
    // An older release commit is further from HEAD than a newer one that
    // already failed the ancestor, age, or distance check. A checks map on
    // this pull request can still sit behind that release.
    if (releaseRun && releaseUnusable) continue;
    const map = await download(artifact);
    if (releaseRun && (map.provenance?.kind !== 'release' || String(map.provenance.runId) !== String(source.id)
      || map.provenance.commit !== map.commit)) continue;
    if (usable(map)) return { artifact, map };
    if (releaseRun) releaseUnusable = true;
  }
  return releaseUnusable ? { stop: true } : undefined;
}

// GitHub's artifact zip stores sizes in the central directory (local header
// flag bit 3). One deflate member named server-coverage-map.json.
export function zipText(buffer, name) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('coverage map zip has no directory');
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('coverage map zip directory is truncated');
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extra = buffer.readUInt16LE(offset + 30);
    const comment = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const entry = buffer.subarray(offset + 46, offset + 46 + nameLen).toString();
    if (entry === name) {
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + compressed);
      if (method === 0) return data.toString('utf8');
      if (method === 8) return inflateRawSync(data).toString('utf8');
      throw new Error(`coverage map zip method ${method}`);
    }
    offset += 46 + nameLen + extra + comment;
  }
  throw new Error(`coverage map zip missing ${name}`);
}

async function main() {
  const directory = process.argv[process.argv.indexOf('--out') + 1];
  if (!process.argv.includes('--out') || !directory) throw new Error('Expected --out directory');
  const repository = process.env.GITHUB_REPOSITORY;
  let apiCalls = 0;
  const api = endpoint => {
    apiCalls += 1;
    return JSON.parse(execFileSync('gh', ['api', `repos/${repository}/${endpoint}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
  };
  const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  mkdirSync(directory, { recursive: true });
  const output = join(directory, 'server-coverage-map.json');
  rmSync(output, { force: true });
  const runs = indexRuns(api(coverageMapReads()[0]).workflow_runs);
  let selected;
  // Artifact pages are newest first. The run list is already loaded, so a
  // later page does not fetch workflow runs. PR artifacts cannot displace
  // release provenance.
  for (let page = 1; !selected; page++) {
    const { artifacts } = api(coverageMapReads(page)[1]);
    selected = await newestCoverageMap({ artifacts, runs,
      base: process.env.GITHUB_BASE_REF, head: process.env.GITHUB_HEAD_REF,
      download: artifact => {
        apiCalls += 1;
        const zip = execFileSync('gh', ['api', `repos/${repository}/actions/artifacts/${artifact.id}/zip`], { maxBuffer: 16 * 1024 * 1024 });
        return JSON.parse(zipText(zip, 'server-coverage-map.json'));
      },
      usable: map => !staleMapReason(map, {
        isAncestor: commit => { try { git(['merge-base', '--is-ancestor', commit, 'HEAD']); return true; } catch { return false; } },
        distance: commit => Number(git(['rev-list', '--count', `${commit}..HEAD`])),
      }),
    });
    if (selected?.stop || artifacts.length < 100) break;
  }
  if (selected?.map) {
    writeFileSync(output, JSON.stringify(selected.map));
    console.log(`Coverage map: ${selected.map.commit}, artifact ${selected.artifact.id} (${apiCalls} API calls)`);
  } else {
    rmSync(output, { force: true });
    console.log(`No usable coverage map; run every server test. (${apiCalls} API calls)`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
