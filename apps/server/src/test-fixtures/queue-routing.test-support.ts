import {queueMessage,type CommandRow} from '../agent-command.js';
import type {SqlDatabase} from '../database.js';
/** Fixture convenience for tests that install source rows directly. */
export async function routeAgentResult(db:SqlDatabase,parent:CommandRow|undefined,id:string,speaker?:{agentId:string;roomId:string;initialAgentDepth?:number}) {
  const row=(await db.query<{room_id:string;author_id:string;text:string}>('SELECT room_id,author_id,text FROM messages WHERE id=$1',[id])).rows[0]!;
  const saved=await queueMessage(db,{kind:'post',id,roomId:row.room_id,authorId:speaker?.agentId ?? row.author_id,text:row.text,parent});
  return {woken:saved.woken,notWoken:saved.notWoken};
}

export async function routeHumanMessage(db: SqlDatabase, sourceId: string): Promise<boolean> {
  const source = (await db.query<{ room_id: string; author_id: string; text: string; presentation:string; attachments: import('../agent-command.js').PrivateCommandPayload['attachments'] }>(
    'SELECT room_id,author_id,text,attachments,presentation FROM messages WHERE id=$1', [sourceId],
  )).rows[0];
  const saved = source && source.presentation==='message' && await queueMessage(db, { kind: 'post', roomId: source.room_id, authorId: source.author_id,
    id: sourceId, text: source.text, attachments: source.attachments,
  });
  return Boolean(saved?.stopped);
}
