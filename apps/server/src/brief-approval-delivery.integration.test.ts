import {
  randomBytes,
  randomUUID,
  expect,
  it,
  HUMAN,
  RUBY,
  WORKER,
  WS,
  ROOM,
  claim,
  authority,
  commands,
  open,
  rootFixture,
} from './test-support-commander-recovery.integration.test-support.js';
import { cornerCommanderIdSql } from './corner-commander.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';

async function tag(roomId: string, text: string, agentId = RUBY) {
  const messageId = randomBytes(32).toString('hex');
  await rootFixture.phone.execute('sendRoomMessage', { roomId, messageId, text }, HUMAN);
  const command = (await commands(roomId, agentId)).find((c) => c.sourceMessageId === messageId)!;
  expect(command).toBeDefined();
  return { messageId, command };
}
const finishAll = () =>
  rootFixture.db.query(`UPDATE agent_commands SET state='complete' WHERE state<>'complete'`);
const revise = (
  turn: AgentCommand,
  cornerId: string,
  expectedRevision: number,
  sourceMessageId?: string,
) =>
  rootFixture.daemon.execute(
    'reviseCornerBrief',
    {
      ...authority(turn),
      cornerId,
      expectedRevision,
      brief: {
        spec: `Fold GitHub events into pills, revision ${expectedRevision + 1}`,
        change: 'Apply the approved revision',
        repositoryWork: false,
        ...(sourceMessageId !== undefined ? { approval: { sourceMessageId } } : {}),
      },
    },
    RUBY,
  );

// Reproduction BRIEF-APPROVAL-DELIVERY (github-event-pills, 23 Nov): Ruby opened
// the thread from the owner's tag in its parent Room. Ruby's session there
// commands the thread. Citing the owner's earlier delivery ID and revising without a
// citation were both refused with 403.
async function openThread() {
  await finishAll();
  const go = await tag(ROOM, '@ruby ok cute. Go');
  await claim(go.command);
  const opened = await rootFixture.daemon.execute(
    'createCorner',
    {
      ...authority(go.command),
      targetRoomId: ROOM,
      name: 'github-event-pills',
      objective: 'Fold GitHub events into pills',
      brief: {
        spec: 'Fold GitHub events into pills',
        repositoryWork: false,
        approval: { sourceMessageId: go.command.id },
      },
    },
    RUBY,
  );
  const commander = (
    await rootFixture.db.query<{ commander: string }>(
      `SELECT ${cornerCommanderIdSql('corner')} commander FROM rooms corner WHERE id=$1`,
      [opened.cornerId],
    )
  ).rows[0]!.commander;
  expect(commander).toBe(RUBY);
  await finishAll();
  return opened.cornerId;
}

it('Reproduction BRIEF-APPROVAL-DELIVERY: an earlier human delivery ID approves a revision', async () => {
  const cornerId = await openThread();
  // Before: 403 "must cite a human message from a current chat member…".
  const caution = await tag(ROOM, '@ruby a thread opening is not a GitHub event');
  await claim(caution.command);
  await finishAll();
  const choose = await tag(ROOM, "@ruby let's go with revision 3");
  await claim(choose.command);
  expect(await revise(choose.command, cornerId, 1, caution.command.id)).toMatchObject({
    revision: 2,
    approval: {
      sourceMessageId: caution.messageId,
      approvedBy: HUMAN,
      text: caution.command.source.body,
    },
  });
  console.info(
    'Demonstrated BRIEF-APPROVAL-DELIVERY: an earlier delivery ID resolves to its human message',
  );
}, 60_000);

it('Reproduction BRIEF-APPROVAL-TURN: a commander records human approval only when citing the human message', async () => {
  const cornerId = await openThread();
  const request = await tag(ROOM, '@ruby just do it');
  await claim(request.command);
  expect(await revise(request.command, cornerId, 1)).toMatchObject({
    revision: 2,
    approval: { kind: 'commander-direct', sourceMessageId: '', approvedBy: RUBY },
  });
  expect(await revise(request.command, cornerId, 2, request.messageId)).toMatchObject({
    revision: 3,
    approval: { sourceMessageId: request.messageId, approvedBy: HUMAN },
  });
}, 60_000);

it("BRIEF-APPROVAL-DELIVERY: the commander cites a delivery from any chat it was addressed in; another agent's delivery approves nothing", async () => {
  const opened = await open();
  await finishAll();
  const other = randomUUID();
  await rootFixture.db.query(
    `INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Elsewhere',$3)`,
    [other, WS, HUMAN],
  );
  for (const member of [HUMAN, RUBY])
    await rootFixture.db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member')`,
      [WS, other, member],
    );
  const elsewhere = await tag(other, '@ruby also keep the event icons');
  await claim(elsewhere.command);
  await finishAll();
  const apply = await tag(ROOM, '@ruby apply what I said elsewhere');
  await claim(apply.command);
  expect(await revise(apply.command, opened.cornerId, 1, elsewhere.command.id)).toMatchObject({
    revision: 2,
    approval: { sourceMessageId: elsewhere.messageId, approvedBy: HUMAN },
  });
  const peer = await tag(ROOM, '@worker look at the pills', WORKER);
  await expect(revise(apply.command, opened.cornerId, 2, peer.command.id)).rejects.toThrow(
    'brief.approval.sourceMessageId',
  );
}, 60_000);

// Reproduction DELIVERY-ID-HOLD-READ (morning card item 4, 23 Nov): holds and
// message reads refused the delivery ID an agent was shown for a person's tag
// (hold: "cited message does not exist"; read: "message not found in this chat").
it('Reproduction DELIVERY-ID-HOLD: a hold citing a delivery ID cites the human message it delivered', async () => {
  const cornerId = await openThread();
  const hold = await tag(ROOM, '@ruby hold the merge until I look');
  await claim(hold.command);
  await rootFixture.daemon.execute(
    'setCornerHold',
    { ...authority(hold.command), cornerId, sourceMessageId: hold.command.id },
    RUBY,
  );
  expect(
    (
      await rootFixture.db.query(
        `SELECT source_message_id,source_author_id FROM corner_merge_holds
         WHERE corner_id=$1 AND released_at IS NULL`,
        [cornerId],
      )
    ).rows,
  ).toEqual([{ source_message_id: hold.messageId, source_author_id: HUMAN }]);
}, 60_000);

it('Reproduction DELIVERY-ID-READ: a message read by delivery ID returns the human message; another agent\'s delivery does not', async () => {
  await finishAll();
  const mine = await tag(ROOM, '@ruby read this back to me');
  expect(
    await rootFixture.daemon.execute('getRoomMessage', { roomId: ROOM, messageId: mine.command.id }, RUBY),
  ).toMatchObject({ body: '@ruby read this back to me' });
  const peer = await tag(ROOM, '@worker this one is yours', WORKER);
  await expect(
    rootFixture.daemon.execute('getRoomMessage', { roomId: ROOM, messageId: peer.command.id }, RUBY),
  ).rejects.toThrow('message not found');
}, 60_000);
