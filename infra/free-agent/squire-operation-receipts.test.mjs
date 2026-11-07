import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownedSquireCall } from './squire-operation-receipts.mjs';
const id = '11111111-1111-4111-8111-111111111111';
test('broker owner returns the accepted original start after a lost reply and never invokes another browser', async () => {
  let starts = 0,
    finish;
  const work = new Promise((resolve) => {
    finish = resolve;
  });
  const start = { params: { name: 'operate_start', _meta: { beelineOperationId: id } } };
  const original = ownedSquireCall('synthetic-agent', start, () => {
    starts++;
    return work;
  });
  const read = ownedSquireCall(
    'synthetic-agent',
    { params: { name: 'beeline_read_operation', arguments: { operationId: id } } },
    () => {
      throw Error('read must not dispatch');
    },
  );
  finish({ content: [{ type: 'text', text: 'original session' }] });
  await original;
  const receipt = JSON.parse((await read).content[0].text);
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.completed, true);
  assert.equal(starts, 1);
  assert.deepEqual(receipt.result, { content: [{ type: 'text', text: 'original session' }] });
  const foreign = await ownedSquireCall(
    'another-agent',
    { params: { name: 'beeline_read_operation', arguments: { operationId: id } } },
    () => {},
  );
  assert.equal(JSON.parse(foreign.content[0].text).outcome, 'unknown');
});
