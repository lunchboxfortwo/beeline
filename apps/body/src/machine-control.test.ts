import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { HelperStatusFile } from './helper-status.js';
import { askMachine, MachineControl, machineControlPath } from './machine-control.js';
import { PeerRefusal } from './wait.js';

const status: HelperStatusFile = {
  pid: process.pid,
  generation: 'g1',
  processState: 'serving',
  updatedAt: 'now',
  agents: {},
};

async function helper(onRequest: ConstructorParameters<typeof MachineControl>[1]) {
  const root = await mkdtemp(join(tmpdir(), 'beeline-control-'));
  const control = new MachineControl(machineControlPath(root), onRequest);
  await control.start();
  return {
    root,
    control,
    close: async () => {
      await control.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it('answers a refused update instead of leaving the requester to an observer timer', async () => {
  // Audit: a refusal or failure only set lastError, so the client waited out its 600 s observer.
  const live = await helper(async () => {
    throw new Error('helper generation g1 is not the requested source g0');
  });
  try {
    const error = await askMachine(live.root, {
      operation: 'update',
      releaseId: 'r',
      sourceGeneration: 'g0',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PeerRefusal);
    expect(String(error)).toContain('not the requested source');
  } finally {
    await live.close();
  }
});

it('answers a held update once its transaction fails or hands off', async () => {
  let held!: () => void;
  let isHeld = new Promise<void>((done) => {
    held = done;
  });
  const live = await helper(async (_request, hold) => {
    const answer = hold();
    held();
    return answer;
  });
  try {
    const failing = askMachine(live.root, { operation: 'update', releaseId: 'r' }).catch(
      (e: unknown) => e,
    );
    await isHeld;
    isHeld = new Promise<void>((done) => {
      held = done;
    });
    await live.control.settleHeld({ error: 'published helper v1 is below required v2' });
    expect(String(await failing)).toContain('below required v2');
    const handing = askMachine(live.root, { operation: 'update', releaseId: 'r' });
    await isHeld;
    await live.control.settleHeld({ ...status, outcome: 'handoff' });
    expect(await handing).toMatchObject({ generation: 'g1', outcome: 'handoff' });
  } finally {
    await live.close();
  }
});

it('answers a held update with an explicit refusal when the control owner stops', async () => {
  let held!: () => void;
  const holding = new Promise<void>((done) => {
    held = done;
  });
  const live = await helper(async (_request, hold) => {
    const answer = hold();
    held();
    return answer;
  });
  const answer = askMachine(live.root, { operation: 'update', releaseId: 'next' }).catch(
    (error) => error,
  );
  try {
    await holding;
    await live.control.stop();
    expect(await answer).toBeInstanceOf(PeerRefusal);
    expect(String(await answer)).toContain('helper stopped before answering the update');
  } finally {
    await live.close();
  }
});
