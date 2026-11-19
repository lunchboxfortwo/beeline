// Squire's owner-commanded recovery policy. Hosted/PR workflows stay intact.
import { WINDOWS_DESKTOP } from './release-local-desktop.mjs';
export const localChecks = ['typecheck', 'dead-code', 'codecs'];

export function quickChecks(workflow) {
  const jobs = Object.fromEntries(['typecheck', 'dead-code'].map(id => [id, structuredClone(workflow.jobs[id])]));
  jobs.codecs = {
    name: 'NETWORK CODECS', 'timeout-minutes': 5,
    steps: [{ uses: 'actions/checkout@v4', with: { ref: '${{ inputs.release_sha }}' } },
      { uses: './.github/actions/ci-workspace' },
      { name: 'Verify committed network codecs', run: 'node packages/scripts/generate-network-codecs.mjs --check' }],
  };
  return { ...structuredClone(workflow), jobs };
}

export function droppedChecks(workflow) {
  return Object.keys(workflow.jobs).filter(id => !localChecks.includes(id));
}

export function localWorkflow(workflow, { channel = 'next', parallelChecks = false } = {}) {
  const local = structuredClone(workflow);
  // This edge reserved hosted capacity; helper publication consumes only its
  // two builds. All real inputs, validation and final publication joins stay.
  local.jobs.helper.needs = local.jobs.helper.needs.filter(id => id !== 'delivery_result');
  const validation = local.jobs.release_validation;
  validation.steps = [{ name: 'Require every quick release check to pass', env: { CHECKS_RESULT: '${{ needs.release_checks.result }}' }, run: [
    'echo "Squire release checks: $CHECKS_RESULT"',
    'echo "Retained: build, typecheck, dead-code, design grammar, network codecs." >> "$GITHUB_STEP_SUMMARY"',
    'echo "Full suites run on PRs; this release produces no runtime coverage map." >> "$GITHUB_STEP_SUMMARY"',
    'test "$CHECKS_RESULT" = success',
  ].join('\n') }];
  if (channel === 'latest' || parallelChecks) {
    // initialize already proves that this exact SHA completed next. Keep the
    // final result join, without invoking Checks or repeating quick checks.
    delete local.jobs.release_checks;
    for (const job of Object.values(local.jobs)) {
      if (job.needs) job.needs = [job.needs].flat().filter(id => id !== 'release_checks');
    }
    validation.steps = [{ name: 'Reuse the successful next verdict', run: 'echo "Promoting the successful next commit; no checks run."' }];
  }
  if (parallelChecks) {
    delete local.jobs.nightly_checks;
    // Pure build jobs can overlap Checks. Every promotion and finalization job
    // retains its existing release_validation dependency and verdict condition.
    for (const id of ['helper_linux', 'helper_macos', 'desktop_installers']) {
      const job = local.jobs[id];
      job.needs = job.needs.filter(id => id !== 'release_validation');
      job.if = job.if.replace("needs.release_validation.result == 'success' && ", '');
    }
    validation.steps = [];
  }
  return local;
}

export function releasePlan(workflow, checks, options = {}) {
  const local = localWorkflow(workflow, { ...options, parallelChecks: true });
  const carryDesktop = (options['desktop-mode'] || options.desktopMode) === 'carry';
  const carryMac = (options['mac-helpers'] || options.macHelpers) === 'carry';
  return {
    fullChecks: { suite: 'all', starts: 'alongside helper and desktop builds', gates: 'every promotion and release completion', resultsPath: 'full-checks/release-checks.json', skip: '--skip-full-checks <owner message id>; recorded in release.json' },
    targetSeconds: 1800,
    target: 'routine squire release; check budget ~5 min + concurrent delivery ~20 min + finalization',
    localCapacity: '3 jobs on existing 3-CPU/12-GiB slices, plus 1 capped Mac orchestration job; iOS store compilation runs remotely',
    checks: { retained: Object.keys(checks.jobs), dropped: [], reusedFrom: options.channel === 'latest' ? 'same-SHA full Checks verdict from next' : undefined },
    jobs: Object.entries(local.jobs).map(([id, job]) => ({ id, needs: [job.needs ?? []].flat(), if: job.if ?? 'success()',
      placement: id === 'mobile_native_ios' ? 'remote Mac, separate queue' : id === 'helper_macos' && !carryMac ? 'Intel Mac remote queue; both architectures' : id === 'desktop_installers' ? 'native hosts through bounded delivery queues' : 'bounded local queue',
      policy: id === 'helper_macos' ? carryMac ? 'published Apple-silicon and Intel Mac helpers carried unchanged' : 'Intel and ARM helpers built on MacBook; ARM cross-build verified with lipo and codesign'
        : id === 'desktop_installers' ? carryDesktop ? 'published signed updater set carried unchanged under the existing local recovery policy' : WINDOWS_DESKTOP === 'build' ? 'complete native signed updater set, including Windows, built from the promoted commit' : 'macOS and Linux signed updater set built from the promoted commit; published Windows installers carried unchanged and omitted from the updater manifest' : undefined })),
    coverage: 'no release coverage map is fabricated; PR Checks remain unchanged',
    safety: 'dispatch attribution, exact SHA, full-check verdict or explicit recorded owner skip, migrations, canary/rollback, helper proofs and final result joins retained',
    measurement: 'dry plan is not an end-to-end deployment timing; explicit native store/device proofs can extend the routine target',
  };
}
