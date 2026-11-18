import { renderWake, renderMention } from '../../body/src/session-join/bridge.js';
import { pendingMcpWakes } from './rooms-mcp-agent.js';
import { itemPrompt } from '../../body/src/place-prompt.js';
import {
  expect,
  it,
  H,
  A,
  R,
  C,
  W,
  commands,
  send,
  rootFixture,
} from './test-support-agent-command.integration.test-support.js';

const Q = 'e'.repeat(64);

it('queues only what a live session has not seen: new messages, and the member list once per change', async () => {
  await send('@hoots first request');
  await send('Untagged chatter between requests');
  await send('@hoots second request');
  await send('@hoots third request');
  const [first, second, third] = await commands(A);
  // A session with no earlier command here gets the window.
  expect(first!.source.conversationContext).toContain('Members (exact tag spellings):');
  expect(first!.source.conversationContext).toContain('You are @hoots');
  expect(first!.source.conversationWindow).toBeUndefined();
  // The tip: only the message it has not seen, never its own source again.
  expect(second!.source.conversationContext).toContain('Untagged chatter between requests');
  expect(second!.source.conversationContext).not.toContain('first request');
  expect(second!.source.conversationContext).not.toContain('Members (exact tag spellings):');
  expect(third!.source.conversationContext).toBeUndefined();
  // A fresh session still has the bounded window, brief-free here, with members.
  expect(third!.source.conversationWindow).toContain('second request');
  expect(third!.source.conversationWindow).toContain('Members (exact tag spellings):');
  const live = itemPrompt(third!, { names: new Map() });
  const fresh = itemPrompt(third!, { names: new Map(), fresh: true });
  expect(live).not.toContain('Untagged chatter between requests');
  expect(fresh).toContain('Untagged chatter between requests');

  await rootFixture.db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Quill','quill') ON CONFLICT DO NOTHING`,
    [Q],
  );
  await rootFixture.db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
    [W, R, Q],
  );
  try {
    await send('@hoots fourth request');
    await send('@hoots fifth request');
    const [, , , fourth, fifth] = await commands(A);
    expect(fourth!.source.conversationContext).toContain('@quill — Quill (person)');
    expect(fifth!.source.conversationContext ?? '').not.toContain('Members (exact tag spellings):');
  } finally {
    await rootFixture.db.query('DELETE FROM memberships WHERE identity_id=$1', [Q]);
  }
});

it('delivers a thread brief with the first turn and again only when its revision changes, in wakes too', async () => {
  await rootFixture.db.query('DELETE FROM corner_brief_revisions WHERE corner_id=$1', [C]);
  await rootFixture.db.query(
    `INSERT INTO corner_brief_revisions(corner_id,revision,spec,objective,author_id,source_room_id)
    VALUES($1,1,'Build the first version.','Build it',$2,$3)`,
    [C, H, R],
  );
  await send('@hoots start the thread', C);
  await send('@hoots continue', C);
  await rootFixture.db.query(
    `INSERT INTO corner_brief_revisions(corner_id,revision,spec,objective,author_id,source_room_id)
    VALUES($1,2,'Build the second version.','Build it',$2,$3)`,
    [C, H, R],
  );
  await send('@hoots go on', C);
  const [opening, unchanged, revised] = await commands(A, C);
  expect(opening!.source.conversationContext).toContain('revision 1');
  expect(unchanged!.source.conversationContext ?? '').not.toContain('Current thread brief');
  expect(revised!.source.conversationContext).toContain('Build the second version.');
  expect(revised!.source.conversationContext).not.toContain('Build the first version.');
  // External sessions read the same delta from the wake payload.
  const wakes = await pendingMcpWakes(rootFixture.db, A);
  expect(wakes.find((wake) => wake.id === revised!.id)?.institutionalContext ?? '').toContain(
    'Build the second version.',
  );
});

it('delivers all unseen messages beyond the cold window limit', async () => {
  await send('@hoots opening request');
  for (let index = 0; index < 25; index++) await send(`Unseen chatter ${index}.`);
  await send('@hoots next request');
  const next = (await commands(A)).at(-1)!;
  for (let index = 0; index < 25; index++)
    expect(next.source.conversationContext).toContain(`Unseen chatter ${index}.`);
  expect(next.source.conversationContext).not.toContain('opening request');
  expect(next.source.conversationWindow).not.toContain('Unseen chatter 0.');
  expect(next.source.conversationWindow).toContain('Unseen chatter 24.');
  await send('@hoots another request');
  expect((await commands(A)).at(-1)!.source.conversationContext).toBeUndefined();
});


it('delivers the generated human thread rename and first-brief asks on its first native and external turn', async () => {
  await rootFixture.db.query('UPDATE rooms SET name=$2 WHERE id=$1', [C, 'steady-amber-thread']);
  await send('@hoots Build the thread naming fix', C);
  const [opening] = await commands(A, C);
  const native = itemPrompt(opening!, { names: new Map(), fresh: true });
  const wake = (await pendingMcpWakes(rootFixture.db, A)).find(wake => wake.id === opening!.id)!;
  const runner = { node: '/synthetic/node', bundle: '/synthetic/beeline.mjs' };
  const joined = { agent: 'codex', cwd: '/synthetic' } as Parameters<typeof renderWake>[1];
  const external = renderWake(wake, joined, runner);
  // Mentions carry the same frozen context through queuedContextSql.
  const mention = renderMention({ id: opening!.sourceMessageId, room_id: C,
    institutionalContext: wake.institutionalContext, text: opening!.source.body });
  for (const prompt of [native, external, mention]) {
    expect(prompt).toContain('still has its generated name, "steady-amber-thread"');
    expect(prompt).toContain('revise_thread(action:install_brief');
    expect(prompt).toContain('a short objective');
    expect(prompt).toContain('brief.approval.sourceMessageId');
    expect(prompt).not.toContain('No assigned brief yet');
  }
});

it('does not ask to rename a human thread after its name and brief are set', async () => {
  await rootFixture.db.query('UPDATE rooms SET name=$2 WHERE id=$1', [C, 'thread-naming-fix']);
  await rootFixture.db.query(
    `INSERT INTO corner_brief_revisions(corner_id,revision,spec,objective,author_id,source_room_id)
     VALUES($1,1,'Restore the naming prompt.','Restore naming',$2,$3)`, [C, H, R],
  );
  await send('@hoots Continue the fix', C);
  const [opening] = await commands(A, C);
  const wake = (await pendingMcpWakes(rootFixture.db, A)).find(wake => wake.id === opening!.id)!;
  for (const prompt of [itemPrompt(opening!, { names: new Map(), fresh: true }), wake.institutionalContext ?? '']) {
    expect(prompt).toContain('Restore the naming prompt.');
    expect(prompt).not.toContain('still has its generated name');
    expect(prompt).not.toContain('write the first brief');
  }
});
