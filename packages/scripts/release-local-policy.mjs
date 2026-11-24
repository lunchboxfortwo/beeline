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

export function localWorkflow(workflow, { channel = 'next', skipFullChecks } = {}) {
  const local = structuredClone(workflow);
  if (channel === 'latest') return { ...local, jobs: { promote: local.jobs.promote } };
  delete local.jobs.promote;
  delete local.jobs.nightly_checks;
  // Android still waits for every live leg. Local finalization reads those
  // same completion outputs directly; hosted scheduling keeps its job.
  const delivery = local.jobs.delivery_result;
  local.jobs.mobile_native_android.needs = [...new Set([...local.jobs.mobile_native_android.needs, ...delivery.needs])];
  delete local.jobs.delivery_result;
  for (const id of ['helper', 'mobile_native_android', 'release_result'])
    local.jobs[id].needs = local.jobs[id].needs.filter(job => job !== 'delivery_result');
  for (const id of ['helper_linux', 'helper_macos', 'desktop_installers']) {
    const job = local.jobs[id];
    job.needs = job.needs.filter(id => id !== 'release_validation');
    job.if = job.if.replace("needs.release_validation.result == 'success' && ", '');
  }
  const validation = local.jobs.release_validation;
  if (skipFullChecks) {
    delete local.jobs.release_checks;
    validation.needs = ['initialize'];
    validation.steps = [];
  } else {
    validation.steps = [{ name: 'Require the quick release checks to pass',
      env: { CHECKS_RESULT: '${{ needs.release_checks.result }}' }, run: 'test "$CHECKS_RESULT" = success' }];
  }
  return local;
}

export function releasePlan(workflow, checks, options = {}) {
  const local = localWorkflow(workflow, options);
  const carryDesktop = (options['desktop-mode'] || options.desktopMode) === 'carry';
  const carryMac = (options['mac-helpers'] || options.macHelpers) === 'carry';
  return {
    targetSeconds: 1800,
    target: 'routine squire release; check budget ~5 min + concurrent delivery ~20 min + finalization',
    localCapacity: '3 jobs on existing 3-CPU/12-GiB slices, plus 1 capped Mac orchestration job; iOS store compilation runs remotely',
    checks: options.channel === 'latest' ? { retained: [], reusedFrom: 'successful same-SHA next release' }
      : { profile: 'quick', retained: localChecks, dropped: droppedChecks(checks) },
    jobs: Object.entries(local.jobs).map(([id, job]) => ({ id, needs: [job.needs ?? []].flat(), if: job.if ?? 'success()',
      placement: id === 'mobile_native_ios' ? 'remote Mac, separate queue' : id === 'helper_macos' && !carryMac ? 'GitHub-hosted macOS runners; one dispatched run for both architectures' : id === 'desktop_installers' ? 'native hosts through bounded delivery queues' : 'bounded local queue',
      policy: id === 'helper_macos' ? carryMac ? 'published Apple-silicon and Intel Mac helpers carried unchanged' : 'ARM and Intel helpers built natively on GitHub-hosted macos-15 and macos-15-intel; publication stays on squire'
        : id === 'desktop_installers' ? carryDesktop ? 'installer proof plan requests the published desktop set' : WINDOWS_DESKTOP === 'build' ? 'complete native signed updater set, including Windows, signed and staged on next' : 'macOS and Linux signed updater set staged on next; published Windows installers carried unchanged and omitted from the updater manifest' : undefined })),
    coverage: 'no release coverage map is fabricated; PR Checks remain unchanged',
    safety: 'dispatch attribution, exact SHA, quick Checks verdict or explicit recorded owner skip, migrations, canary/rollback, helper proofs and final result joins retained',
    measurement: 'dry plan is not an end-to-end deployment timing; explicit native store/device proofs can extend the routine target',
  };
}
