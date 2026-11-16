import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { grandfatherRegistry, scanUiSource } from './mobile-ui-policy.mjs';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanConnectionUi, checkConnectionUiTree, CONNECTION_BANNER } from './connection-ui-policy.mjs';

const scan = source => scanConnectionUi(source, 'components/SneakyRoom.tsx');
it('has zero connectivity/load-failure UI outside the existing app banner', () => {
  assert.deepEqual(checkConnectionUiTree(fileURLToPath(new URL('../..', import.meta.url))), []);
});
it('rejects a planted backdoor including copy hidden behind a shared row', () => {
  const source = readFileSync(new URL('./fixtures/connection-ui-backdoor.tsx.fixture', import.meta.url), 'utf8');
  const errors = scan(source);
  assert.ok(errors.some(error => error.message.includes('copy belongs only')));
  assert.ok(errors.some(error => error.message.includes('Retry affordance')));
  assert.ok(errors.every(error => error.rule === 'single-connection-banner'));
});
it('blocks plain text, constants, templates and shared ErrorBanner retries for failed reads', () => {
  for (const source of [
    `const Screen = () => <Text>Couldn't load earlier messages · tap to retry</Text>`,
    `const message = 'Could not load this Room.'; const Screen = () => <IndexRow title={message} />`,
    'const message = `Could not load ${name}`; const Screen = () => <Text>{message}</Text>',
    `const Screen = () => error ? <ErrorBanner title={error} onRetry={reload} /> : null`,
    `const Screen = () => failed && <IndexRow title={reason} action="Retry" onPress={() => refresh()} />`,
    `const Screen = () => <Text>Could not connect to Beeline</Text>`,
    `const Screen = () => <Text>Network is not available right now.</Text>`,
    `const Screen = () => <Text>{'Could not ' + 'load Rooms.'}</Text>`,
    `const Screen = () => <IndexRow action={'Retry'} title={error} onPress={reload} />`,
    `const Screen = () => error ? <Text onPress={reload}>Try again</Text> : null`,
    `const Screen = () => <AgentApprovalCard footerNote="Could not load this Room." />`,
    `const Screen = () => <IndexRow title="Could not load app Rooms." />`,
    `const Screen = () => React.createElement(IndexRow, {title: error, action: 'Retry', onPress: reload})`,
    `const Screen = () => React.createElement(Text, {onPress: reload}, 'Retry')`,
    `const Screen = () => <IndexRow title="Corner details unavailable" />`,
    `const Screen = () => <IndexRow description="The file could not be loaded. Try again." />`,
  ]) assert.ok(scan(source).length, source);
});
it('preserves provider/model errors, local runtime recovery and message delivery actions', () => {
  for (const source of [
    `const Screen = () => <IndexRow title="Could not load effort choices for this model." />`,
    `const Screen = () => <ErrorBanner title="Could not connect GitHub" onRetry={reconnectGitHub} />`,
    `const Screen = () => <Message onRetry={outbox.retry} />`,
    `const Screen = () => <IndexRow title="Could not stop this schedule." action="Retry" onPress={stop} />`,
    `const Screen = () => <Text>Loading earlier messages…</Text>`,
  ]) assert.deepEqual(scan(source), [], source);
  assert.deepEqual(scanConnectionUi(`<IndexRow title="Beeline isn’t connected" action="Reconnect" />`, CONNECTION_BANNER), []);
});
it('CI runs the guard with no registry allowance', () => {
  const checker = readFileSync(new URL('./check-mobile-ui-components.mjs', import.meta.url), 'utf8');
  assert.match(checker, /\.\.\.checkConnectionUiTree\(root\)/);
  const ci = readFileSync(new URL('./ci-workspace-tasks.sh', import.meta.url), 'utf8');
  assert.match(ci, /node packages\/scripts\/check-mobile-ui-components\.mjs/);
  assert.match(ci, /scripts\/connection-ui-policy\.test\.mjs/);
});

it('the real CI checker exits nonzero for the planted backdoor even when its shared row is registered', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const proofRoot = path.join(root, '.beeline-proof');
  mkdirSync(proofRoot, { recursive: true });
  const sandbox = mkdtempSync(path.join(proofRoot, 'connection-ui-policy-'));
  const file = 'components/SneakyRoom.tsx';
  const sourcePath = path.join(sandbox, 'apps/mobile/sources', file);
  const registryPath = path.join(sandbox, 'apps/mobile/design/ui-component-registry.json');
  try {
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    mkdirSync(path.dirname(registryPath), { recursive: true });
    function check(source) {
      writeFileSync(sourcePath, source);
      writeFileSync(registryPath, JSON.stringify(grandfatherRegistry([scanUiSource(source, file)])));
      return spawnSync(process.execPath, ['packages/scripts/check-mobile-ui-components.mjs', '--root', sandbox], { cwd: root, encoding: 'utf8' });
    }
    const clean = check('export function SneakyRoom() { return <IndexRow title="Rooms" />; }');
    assert.equal(clean.status, 0, clean.stderr);
    const backdoor = check(readFileSync(new URL('./fixtures/connection-ui-backdoor.tsx.fixture', import.meta.url), 'utf8'));
    assert.equal(backdoor.status, 1, backdoor.stdout + backdoor.stderr);
    assert.match(backdoor.stderr, /\[single-connection-banner\]/);
    assert.doesNotMatch(backdoor.stderr, /\[(?:component-file|grandfather-growth)\]/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
