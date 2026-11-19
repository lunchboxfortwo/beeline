#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exceptions are evidence or inert fixtures, never destinations for live work.
const historicalFiles = [
  /^docs\/ci-baseline[^/]*$/,
  /(?:^|\/)evidence\//,
  /^docs\/prompts\/cases\//,
  /\.(?:test|spec|test-support)\.[^/]+$/,
  /(?:^|\/)test-fixtures\//,
];
const historicalLines = new Map([
  ['docs/ci-checks-consolidation.md', /^Collected on 2026-10-22 from the GitHub Actions jobs API \(`GET \/repos\/Beeline-Work\/beeline\/actions\/runs\/\{run_id\}\/jobs\?per_page=100`\)/],
  ['docs/incident-gap-coverage.md', /^- `Beeline-Work\/beeline-insights` .* were read through the owner's sealed GitHub read credential\./],
]);
const historicalUrlFiles = new Set([
  'docs/approval-matrix.md',
  'docs/ci-checks-consolidation.md',
  'docs/ci-runner-capacity.md',
  'docs/computer-share-lifetime-proof.md',
  'docs/corner-adb-and-system-wording-proof.md',
  'docs/invite-join-reproduction.md',
  'docs/prompts/nightly-proof.md',
  'docs/session-persistence-proof.md',
  'docs/voice-mode-proof/filler-and-loader/README.md',
  'packages/scripts/latency-rig/README.md',
  'apps/mobile/scripts/capture-lifecycle-rows-a.py',
  'apps/mobile/scripts/transcript-event-room-snapshot.json',
  'apps/server/scripts/ci-test-timings.json',
]);
const retiredOwner = ['Beeline', 'Work'].join('-');
const podspec = 'apps/mobile/modules/voice-background-audio/ios/VoiceBackgroundAudio.podspec';

export function legacyRepositoryReferences(file, source) {
  if (historicalFiles.some(pattern => pattern.test(file))) return [];
  return source.split('\n').flatMap((line, index) => {
    // Preserve the exact iOS source line: changing it changes the native fingerprint.
    if (file === podspec && line === `  s.source         = { :git => 'https://github.com/${retiredOwner}/beeline.git', :tag => s.version.to_s }`) return [];
    const historical = line.replace(historicalLines.get(file) ?? /$^/, '');
    // Immutable PR/issue/run/commit evidence, including approval-matrix history
    // and architecture invariant drop notes. A live repo name on the same line
    // still fails; blob/main, API, clone and billing URLs are never evidence.
    const evidence = historicalUrlFiles.has(file)
      || (file === 'docs/architecture/invariants.json' && /^\s*"drop":/.test(line));
    const live = evidence ? historical.replace(/https:\/\/github\.com\/Beeline-Work\/[^/\s]+\/(?:pull|issues|actions\/runs)\/\d+|https:\/\/github\.com\/Beeline-Work\/[^/\s]+\/commit\/[a-f\d]{7,40}/gi, '') : historical;
    return /Beeline-Work\//i.test(live)
      ? [`${file}:${index + 1}: live repository references must use lunchboxfortwo/`] : [];
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const errors = files.flatMap(file => {
    const source = readFileSync(resolve(root, file), 'utf8');
    return source.includes('\0') ? [] : legacyRepositoryReferences(file, source);
  });
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
  else console.log('Live repository targets use the current GitHub account.');
}
