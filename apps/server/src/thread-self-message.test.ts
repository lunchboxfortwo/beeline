import { expect, it, A, B, R, C, rootFixture, commands, send, claim } from './test-support-agent-command.integration.test-support.js';

const selfMessage = (agent: string, roomId: string, requestId: string, place: string, text: string) =>
  rootFixture.daemon.execute('message', { roomId, requestId, to: { agent, place }, text }, agent);

it('queues one self-addressed turn in a thread the sender implements, and that turn cannot queue another', async () => {
  await send('@goosy Start the work', C);
  const task = (await commands(B, C))[0]!;
  await claim(task);
  const sent = await selfMessage(B, C, task.turnRequestId, C, 'Continue with step two');
  expect(sent).not.toHaveProperty('receipt');
  const queued = (await commands(B, C)).filter(item => item.id !== task.id);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({ id: sent.id, reason: 'message' });
  await claim(queued[0]!);
  const again = await selfMessage(B, C, queued[0]!.turnRequestId, C, 'And step three');
  expect(again).toMatchObject({ receipt: expect.stringContaining('You addressed yourself') });
  expect((await commands(B, C)).map(item => item.id).sort()).toEqual([task.id, sent.id].sort());
});

it('keeps self-messages transcript-only outside a thread the sender commands or implements', async () => {
  await send('@hoots A question', C);
  const guest = (await commands(A, C))[0]!;
  await claim(guest);
  const refused = await selfMessage(A, C, guest.turnRequestId, C, 'Note to self');
  expect(refused).toMatchObject({ receipt: expect.stringContaining('You addressed yourself') });
  expect((await commands(A, C)).map(item => item.id)).toEqual([guest.id]);
  await send('@goosy Chat work', R);
  const chat = (await commands(B, R))[0]!;
  await claim(chat);
  const inChat = await selfMessage(B, R, chat.turnRequestId, R, 'Chat note');
  expect(inChat).toMatchObject({ receipt: expect.stringContaining('You addressed yourself') });
  expect((await commands(B, R)).map(item => item.id)).toEqual([chat.id]);
});

it('queues a turn in the thread for its commander writing from the parent chat', async () => {
  await rootFixture.db.query('UPDATE rooms SET created_by=$2 WHERE id=$1', [C, A]);
  try {
    await send('@hoots Check the thread', R);
    const chat = (await commands(A, R))[0]!;
    await claim(chat);
    const sent = await selfMessage(A, R, chat.turnRequestId, C, 'Resume the thread');
    expect(sent).not.toHaveProperty('receipt');
    expect((await commands(A, C)).map(item => item.id)).toEqual([sent.id]);
  } finally {
    await rootFixture.db.query('UPDATE rooms SET created_by=NULL WHERE id=$1', [C]);
  }
});
