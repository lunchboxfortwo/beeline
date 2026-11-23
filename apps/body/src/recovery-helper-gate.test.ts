import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { askMachine, type MachineAnswer, type MachineRequest } from './machine-control.js';
import { convergeNativeHelper } from './native-helper.js';
import { convergeMachine } from './recovery.js';
import type { HelperStatusFile } from './helper-status.js';

vi.mock('./machine-control.js', async original => ({
  ...await original<typeof import('./machine-control.js')>(), askMachine: vi.fn(),
}));
vi.mock('./native-helper.js', async original => ({
  ...await original<typeof import('./native-helper.js')>(), convergeNativeHelper: vi.fn(async () => process.pid),
}));
afterEach(() => vi.clearAllMocks());

const snapshot = (release: string, generation = 'successor'): HelperStatusFile => ({
  pid: process.pid, generation, processState: 'serving', loadedRelease: release,
  updatedAt: '2026-11-22T17:00:00Z', agents: { sleepy: {
    state: 'starting', status: 'waiting for discovery', since: '2026-11-22T16:31:57Z', enabled: true,
  } },
});

async function gate(answers: (request: MachineRequest) => MachineAnswer) {
  const home = await mkdtemp(join(tmpdir(), 'beeline-helper-gate-'));
  const layout = { libDir: join(home, 'lib'), binDir: join(home, 'bin'), releasesRoot: join(home, 'releases') };
  await mkdir(join(layout.releasesRoot, 'target/lib/beeline'), { recursive: true });
  await writeFile(join(layout.releasesRoot, 'target/lib/beeline/bundle.json'), JSON.stringify({ version: 'v1.2.3', commit: 'target' }));
  vi.mocked(askMachine).mockImplementation(async (_root, request) => answers(request));
  const run = vi.fn(async () => ({ stdout: '' }));
  try {
    return { run, result: await convergeMachine({ layout, env: { ...process.env, HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state') },
      releaseId: 'target', reportAgentsOnly: true, run }) };
  } finally { await rm(home, { recursive: true, force: true }); }
}

it('accepts the target or a newer successor with starting agents, never waiting for them', async () => {
  const { result } = await gate(request => request.operation === 'status' ? snapshot('old', 'predecessor')
    : { ...snapshot('target'), outcome: 'current' as const });
  expect(result.loadedRelease).toBe('target');
  expect(result.agents.sleepy?.state).toBe('starting');
  expect(convergeNativeHelper).toHaveBeenCalledWith(expect.objectContaining({ restart: false }));
  const newer = await gate(request => request.operation === 'status' ? snapshot('old', 'predecessor')
    : { ...snapshot('newer'), loadedIdentity: { version: 'v1.2.4' }, outcome: 'current' as const });
  expect(newer.result.loadedRelease).toBe('newer');
});

it.each([
  ['the predecessor with only a desired release', { ...snapshot('old', 'predecessor'), desiredRelease: 'target' }],
  ['same-version different content', { ...snapshot('other'), loadedIdentity: { version: 'v1.2.3', commit: 'other' } }],
])('rejects %s from the one answer instead of waiting for it to change', async (_name, answer) => {
  await expect(gate(request => request.operation === 'status' ? snapshot('old', 'predecessor')
    : { ...answer, outcome: 'current' as const }))
    .rejects.toThrow('not target');
});

it('follows a handoff through the native start job to one status read of the successor', async () => {
  const { run, result } = await gate(request => request.operation === 'update'
    ? { ...snapshot('old', 'predecessor'), outcome: 'handoff' as const }
    : vi.mocked(askMachine).mock.calls.length > 2 ? snapshot('target') : snapshot('old', 'predecessor'));
  expect(run).toHaveBeenCalledWith(['start', 'beeline-helper.service']);
  expect(result).toMatchObject({ generation: 'successor', loadedRelease: 'target' });
  expect(vi.mocked(askMachine).mock.calls.map(([, request]) => request.operation)).toEqual(['status', 'update', 'status']);
});

it('follows a helper that predates one-answer control to its successor', async () => {
  // v0.1.244 answers an update with the snapshot it had, then hands off by itself.
  const { run, result } = await gate(request => request.operation === 'update' || vi.mocked(askMachine).mock.calls.length < 3
    ? snapshot('old', 'predecessor') : snapshot('target'));
  expect(run).toHaveBeenCalledWith(['start', 'beeline-helper.service']);
  expect(result.loadedRelease).toBe('target');
  // Already running the target: nothing to follow.
  const current = await gate(request => request.operation === 'status' ? snapshot('old', 'predecessor') : snapshot('target', 'predecessor'));
  expect(current.run).not.toHaveBeenCalledWith(['start', 'beeline-helper.service']);
});

it('never restarts a helper after a protocol failure', async () => {
  vi.mocked(askMachine).mockRejectedValue(new Error('invalid helper answer'));
  await expect(convergeMachine({ run: async () => ({ stdout: '' }) })).rejects.toThrow('invalid helper answer');
  expect(convergeNativeHelper).not.toHaveBeenCalled();
});
