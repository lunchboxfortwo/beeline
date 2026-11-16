import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture, resetWebFixture, viewer } from './web-fixtures.mjs';

test('a new object-store run cannot deduplicate an attachment against missing bytes', async () => {
  const digest = createHash('sha256').update('Local Beeline latency attachment\n').digest('hex');
  const objects = [
    { owner: viewer, sha: digest },
    { owner: 'another-viewer', sha: digest },
    { owner: viewer, sha: 'another-file' },
  ];
  const db = {
    query: async (sql, args) => {
      if (sql.startsWith('DELETE FROM objects ')) {
        const index = objects.findIndex((row) => row.owner === args[0] && row.sha === args[1]);
        if (index >= 0) objects.splice(index, 1);
      }
      return { rows: [] };
    },
  };
  await resetWebFixture(db, fixture('send-attachment'));
  assert.equal(objects.some((row) => row.owner === viewer && row.sha === digest), false,
    'the next upload must put real bytes rather than reuse stale metadata');
  assert.equal(objects.length, 2, 'other owners and file contents remain untouched');
});
