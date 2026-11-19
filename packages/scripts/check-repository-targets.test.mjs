import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyRepositoryReferences } from './check-repository-targets.mjs';

test('refuses old repository reads, writes, docs, prompts and billing destinations', () => {
  for (const [file, source] of [
    ['packages/scripts/release.mjs', "const repository = 'Beeline-Work/beeline-insights';"],
    ['packages/scripts/read.mjs', "fetch('https://github.com/Beeline-Work/beeline/issues/42')"],
    ['docs/development.md', 'git clone https://github.com/Beeline-Work/beeline.git'],
    ['docs/prompts/room.md', 'The repository is beeline-work/beeline'],
    ['apps/auth/README.md', 'gh api repos/Beeline-Work/beeline/actions/secrets'],
    ['apps/server/src/services.ts', 'https://github.com/organizations/Beeline-Work/settings/billing'],
    ['docs/approval-matrix.md', 'Read https://github.com/Beeline-Work/beeline/blob/main/README.md'],
    ['docs/ci-baseline-new/live.md', 'Beeline-Work/beeline'],
    ['docs/new-procedure.md', 'Read https://github.com/Beeline-Work/beeline/issues/42'],
    ['docs/architecture/invariants.json', '"owner": "Beeline-Work/beeline"'],
  ]) assert.equal(legacyRepositoryReferences(file, source).length, 1, file);
  assert.deepEqual(legacyRepositoryReferences('docs/live.md', '\nBeeline-Work/beeline'),
    ['docs/live.md:2: live repository references must use lunchboxfortwo/']);
  assert.deepEqual(legacyRepositoryReferences('docs/live.md', 'lunchboxfortwo/beeline-insights'), []);
});

test('preserves historical evidence and inert fixtures without exempting adjacent live references', () => {
  for (const file of ['docs/ci-baseline-data.json', 'apps/mobile/evidence/proof.json',
    'docs/prompts/cases/history.json', 'apps/server/src/example.test.ts',
    'apps/server/src/test-fixtures/history.json']) {
    assert.deepEqual(legacyRepositoryReferences(file, 'Beeline-Work/beeline'), [], file);
  }
  for (const file of ['docs/approval-matrix.md', 'docs/architecture/invariants.json', 'docs/computer-share-lifetime-proof.md']) {
    for (const suffix of ['pull/42', 'issues/42', 'actions/runs/42', 'commit/1234abc']) {
      const evidence = `"drop": "https://github.com/Beeline-Work/beeline/${suffix}"`;
      assert.deepEqual(legacyRepositoryReferences(file, evidence), []);
      assert.equal(legacyRepositoryReferences(file, `${evidence} Beeline-Work/beeline`).length, 1);
    }
  }
  const file = 'apps/mobile/modules/voice-background-audio/ios/VoiceBackgroundAudio.podspec';
  assert.deepEqual(legacyRepositoryReferences(file,
    "  s.source         = { :git => 'https://github.com/Beeline-Work/beeline.git', :tag => s.version.to_s }"), []);
  assert.equal(legacyRepositoryReferences(file, "s.homepage = 'https://github.com/Beeline-Work/beeline'").length, 1);
});
