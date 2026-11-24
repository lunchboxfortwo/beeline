import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSystemRenders, inspectSystemWrites } from './system-transcript-boundary.mjs';

test('rejects new transcript inserts and provenance updates outside the writer', () => {
  const file = 'apps/server/src/new-producer.ts';
  for (const sql of [
    "INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'another notice')",
    'WITH batch AS (SELECT 1) INSERT INTO public."messages" (id,author_id,text) SELECT id,author,text FROM batch',
    'UPDATE messages AS m SET card=NULL,system_event=$2 WHERE id=$1',
    'UPDATE messages m SET presentation=$2 FROM incoming WHERE m.id=incoming.id',
    'UPDATE "messages" SET system_transcript=$2 WHERE id=$1',
    'UPDATE messages SET (card, system_event)=($2,$3) WHERE id=$1',
  ]) {
    assert.equal(inspectSystemWrites(file, `db.query(\`${sql}\`);`).length, 1, sql);
  }
});

test('requires a member author guard even in the designated member writer', () => {
  const code = "function insertMemberMessage(db, row) { db.query('INSERT INTO messages(id,author_id,text) VALUES($1,$2,$3)'); }";
  assert.equal(inspectSystemWrites('apps/server/src/message-origin.ts', code).length, 1);
});

test('rejects a standalone system body and an extra pill call in the transcript', () => {
  const file = 'apps/mobile/sources/app/(app)/beeline/chat/useChatTranscriptRenderer.tsx';
  const good = `const renderSystemBody = () => <SquireApprovalCard />;
    const renderPills = () => <TranscriptPills renderBody={renderSystemBody} />;`;
  assert.deepEqual(inspectSystemRenders(file, good), []);
  for (const bypass of ['<LedgerSystemLine />', '<SquireApprovalCard />', '<TranscriptPills />',
    'renderSystemBody(message)', 'React.createElement(LedgerSystemLine)']) {
    assert.ok(inspectSystemRenders(file, `${good}\n${bypass};`).length, bypass);
  }
  assert.equal(inspectSystemRenders(file, 'const unrelated = () => <View />;').length, 1);
});

test('also rejects a bare body when imported under an alias', () => {
  assert.equal(inspectSystemRenders('apps/mobile/sources/components/buzz/AnotherNotice.tsx',
    "import { LedgerSystemLine as Notice } from './Ledger'; export const Body = () => <Notice />;").length, 1);
});
