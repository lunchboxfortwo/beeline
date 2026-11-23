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
// the thread from the owner's tag in its parent Room, so the owner is its
// commander. Citing the owner's earlier delivery ID and revising without a
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
  expect(commander).toBe(HUMAN);
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

it('Reproduction BRIEF-APPROVAL-TURN: a revision without a citation cites the human turn that asked for it', async () => {
  const cornerId = await openThread();
  // Before: 403 "sourceMessageId is required".
  const doIt = await tag(ROOM, '@ruby just do it');
  await claim(doIt.command);
  expect(await revise(doIt.command, cornerId, 1)).toMatchObject({
    revision: 2,
    approval: { sourceMessageId: doIt.messageId, approvedBy: HUMAN },
  });
  // An empty copied citation reads the same as none.
  expect(await revise(doIt.command, cornerId, 2, '')).toMatchObject({
    revision: 3,
    approval: { sourceMessageId: doIt.messageId, approvedBy: HUMAN },
  });
  console.info(
    'Demonstrated BRIEF-APPROVAL-TURN: the current human delivery approves an uncited revision',
  );
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
