import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { MachineControl, machineControlPath } from './machine-control.js';
import { helperStatusPath } from './helper-status.js';
import { observeHelper } from '../../../packages/scripts/helper-proof/observe-helper.mjs';

it('observes status writes during the initial request and each subsequent request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-observer-'));
  let requests = 0;
  const control = new MachineControl(machineControlPath(root), async () => {
    const processState = ++requests < 3 ? 'starting' as const : 'serving' as const;
    await writeFile(helperStatusPath(root), String(requests));
    return { pid: process.pid, generation: 'proof', processState, updatedAt: '', agents: {} };
  });
  try {
    await control.start();
    const status = await observeHelper(root, value => value.processState === 'serving', 2000);
    expect(status.processState).toBe('serving');
    expect(requests).toBe(3);
  } finally { await control.stop(); await rm(root, { recursive: true, force: true }); }
});
