import { randomBytes } from 'node:crypto';
import { validateWorkQuestion, type AskOwnerQuestionInput } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { postRoomChoice } from './room-choice.js';
import { queueMessage } from './agent-command.js';
import { modelText } from './message-origin.js';
import { updateWorkItem, workBoardScope } from './work-board.js';

export async function askOwnerQuestion(
  db: SqlDatabase,
  input: AskOwnerQuestionInput & { requestId?: string },
  agentId: string,
) {
  validateWorkQuestion(input);
  const roomId = input.about.roomId;
  if (!(await workBoardScope(db, roomId, agentId))) throw new Error('room access denied');
  const owner = (
    await db.query<{ id: string; handle: string }>(
      `SELECT i.id,beeline_room_handle(i.id,$2) handle
    FROM agents a JOIN identities i ON i.id=a.owner_id WHERE a.agent_id=$1`,
      [agentId, roomId],
    )
  ).rows[0];
  if (!owner) throw new Error('identity not found');
  return db.transaction(async (tx) => {
    let messageId: string;
    let recommended: string | undefined;
    if (input.options) {
      const choice = await postRoomChoice(tx, {
        roomId,
        agentId,
        mode: 'question',
        prompt: input.question,
        ask: input.question,
        options: input.options.map((option) => ({
          label: option.label,
          consequence: option.label,
        })),
        requesterId: owner.id,
        requestId: input.requestId,
      });
      messageId = choice.messageId;
      const card = (
        await tx.query<{ options: { optionId: string }[] }>(
          `SELECT options FROM room_choices WHERE id=$1`,
          [choice.choiceId],
        )
      ).rows[0]!;
      const index = input.options.findIndex((option) => option.recommended);
      recommended = index < 0 ? undefined : card.options[index]!.optionId;
    } else {
      messageId = randomBytes(32).toString('hex');
      await queueMessage(tx, {
        kind: 'post',
        roomId,
        authorId: agentId,
        id: messageId,
        text: modelText(`@${owner.handle.replace(/^@/, '')} ${input.question}`),
      });
    }
    if (!input.options)
      await tx.query(
        `UPDATE messages SET card=jsonb_build_object('ask',$2::text,'prompt',$2::text) WHERE id=$1`,
        [messageId, input.question],
      );
    await tx.query(
      `INSERT INTO work_questions(message_id,room_id,about,question,recommended_option_id)
      VALUES($1,$2,$3::jsonb,$4,$5)`,
      [messageId, roomId, JSON.stringify(input.about), input.question, recommended ?? null],
    );
    await updateWorkItem(
      tx,
      { id: messageId, roomId, state: 'needs-you', assigneeId: owner.id },
      agentId,
    );
    return { messageId };
  });
}
