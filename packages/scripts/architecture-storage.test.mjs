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

it('trigger assignments count as writers only for their installed table',()=>{
  mkdirSync('.beeline-proof',{recursive:true});
  const root=mkdtempSync(path.resolve('.beeline-proof/storage-trigger-'));
  const storage={scope:['src'],bootstrapTotal:0,unusedTotal:0,tables:{
    messages:{module:'Blocks',reason:'Stores explicit escalation lineage.',columns:{block_parent_id:'Keeps the original block across escalation.'}},
  },jsonb:{}};
  try {
    mkdirSync(path.join(root,'src'));
    const file=path.join(root,'src/blocks.ts');
    const source=`CREATE FUNCTION identify_block() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.block_parent_id := source_block; RETURN NEW; END $$;
      SELECT block_parent_id FROM messages;`;
    writeFileSync(file,source);
    assert.match(judgeStorage(root,storage).join('\n'),/messages.block_parent_id has no writer/);
    writeFileSync(file,source+` CREATE TRIGGER identify_block BEFORE INSERT ON unrelated
      FOR EACH ROW EXECUTE FUNCTION identify_block();`);
    assert.match(judgeStorage(root,storage).join('\n'),/messages.block_parent_id has no writer/);
    writeFileSync(file,source+` CREATE TRIGGER identify_block BEFORE INSERT ON messages
      FOR EACH ROW EXECUTE FUNCTION identify_block();`);
    assert.deepEqual(judgeStorage(root,storage),[]);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
