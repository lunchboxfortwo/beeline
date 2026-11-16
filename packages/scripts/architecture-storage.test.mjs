import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { judgeStorage } from './architecture-storage.mjs';

it('partition leaves inherit real parent writers and readers without waiving unused-column checks',()=>{
  mkdirSync('.beeline-proof',{recursive:true});
  const root=mkdtempSync(path.resolve('.beeline-proof/storage-partition-'));
  const storage={scope:['src'],bootstrapTotal:0,unusedTotal:0,tables:{
    journal:{module:'Diagnostics',reason:'Parent stores the observed event occurrence.',columns:{event_id:'Stable occurrence id for duplicate delivery.'}},
    journal_default:{module:'Diagnostics',reason:'Leaf stores events without a dated partition.',columns:{event_id:'Inherited occurrence id retains parent semantics.'}},
  },jsonb:{}};
  try {
    mkdirSync(path.join(root,'src'));
    const file=path.join(root,'src/events.ts');
    const ddl='CREATE TABLE journal(event_id uuid); CREATE TABLE journal_default PARTITION OF journal DEFAULT;';
    writeFileSync(file,ddl+' INSERT INTO journal(event_id) VALUES($1); SELECT event_id FROM journal;');
    assert.deepEqual(judgeStorage(root,storage),[]);
    writeFileSync(file,ddl+' SELECT event_id FROM journal;');
    const errors=judgeStorage(root,storage).join('\n');
    assert.match(errors,/journal.event_id has no writer/);
    assert.match(errors,/journal_default.event_id has no writer/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
