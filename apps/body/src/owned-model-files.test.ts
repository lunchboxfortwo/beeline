import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeOwnedModelReceipt } from '@beeline/api-contract/helper-model-receipt';
import { OwnedModelFiles, OwnedModelFileRefusal, OWNED_MODEL_FILE_MAX_BYTES,
  type OwnedModelFileBinding, type OwnedModelFileCredential } from './owned-model-files.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const token = 'bfmc_v1.' + 'a'.repeat(32) + '.' + 'b'.repeat(64);
const binding: OwnedModelFileBinding = { agentId: 'synthetic-agent', itemId: 'generation-1',
  provider: 'beeline', model: 'pinned-model', baseUrl: 'https://fixture.invalid/v1/free-agents/model' };
const credential = (): OwnedModelFileCredential => ({ v: 1, token, expiresAt: Math.floor(Date.now() / 1000) + 600 });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'owned-model-files-')); roots.push(root);
  const granted = credential();
  return { root, granted, owner: OwnedModelFiles.create({ root, binding, credential: granted }) };
}
const journal = (owner: OwnedModelFiles) => JSON.parse(readFileSync(owner.paths().journal, 'utf8')) as {
  active: string | null; requests: { id: string; state: string }[] };

it.each([false, true])('recreates a queued invocation after suppressed-answer cleanup (interrupted: %s)', interrupted => {
  const { root, owner, granted } = fixture();
  const request = owner.prepareHeaders();
  const directory = owner.paths().directory;
  const savedCredential = readFileSync(owner.paths().credential, 'utf8');
  owner.revoke();
  if (interrupted) writeFileSync(owner.paths().credential, savedCredential, { mode: 0o600 });
  expect(() => OwnedModelFiles.open(directory)).toThrow();
  expect(() => owner.prepareHeaders()).toThrow(OwnedModelFileRefusal);

  // Suppressed trailing text leaves this same server-owned queue item owed.
  // Its next execution receives the credential again, including after restart.
  const resumed = OwnedModelFiles.create({ root, binding, credential: granted });
  expect(resumed.paths().directory).toBe(directory);
  expect(resumed.snapshot()).toEqual({ state: 'unknown', requests: [request.requestId] });
  const next = OwnedModelFiles.open(directory).prepareHeaders();
  expect(next.authorization).toBe('Bearer ' + token);
  expect(next.requestId).not.toBe(request.requestId);
  expect(resumed.snapshot()).toEqual({ state: 'unknown', requests: [next.requestId] });
});

describe('owned model request journal capacity',()=>{
  it('compacts successful history through more than 128 provider requests and sends after an UNKNOWN', () => {
    const {root, owner, granted}=fixture();let oldReceipt='';
    for(let index=0;index<256;index++){
      const request=owner.prepareHeaders();
      const signed=encodeOwnedModelReceipt(token,{requestId:request.requestId,state:'succeeded',evidence:{kind:'usage',tokens:1,usd:0}});
      if(oldReceipt)expect(owner.confirmReceipt(oldReceipt)).toBe(false);
      expect(owner.confirmReceipt(signed)).toBe(true);oldReceipt=signed;
      expect(journal(owner).requests.length).toBeLessThanOrEqual(1);
    }
    const request=owner.prepareHeaders();const restarted=OwnedModelFiles.create({root,binding,credential:granted});
    expect(restarted.snapshot()).toEqual({state:'unknown',requests:[request.requestId]});
    const next=restarted.prepareHeaders();
    expect(next.requestId).not.toBe(request.requestId);
    expect(restarted.snapshot()).toEqual({state:'unknown',requests:[next.requestId]});
    expect(lstatSync(owner.paths().journal).size).toBeLessThan(OWNED_MODEL_FILE_MAX_BYTES);
  });

});
