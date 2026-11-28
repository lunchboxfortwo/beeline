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
  daemon,
  db,
  commands,
  send,
  rootFixture,
} from './test-support-agent-command.integration.test-support.js';
import { queueMessage } from './agent-command.js';
import {
  PERSON_TAG_CONTEXT_CHARS,
  PERSON_TAG_CONTEXT_HEADING,
  PERSON_TAG_CONTEXT_MESSAGES,
  PERSON_TAG_MESSAGE_CHARS,
} from './agent-command-context.js';

const Q = 'e'.repeat(64);

async function queueAgentRequest(text: string) {
  const { messageId } = await send(text);
  return queueMessage(db, { roomId: R, agentId: A, sourceMessageId: messageId, reason: 'message' });
}

it('queues only what a live session has not seen for agent requests: new messages, and the member list once per change', async () => {
  await queueAgentRequest('first request');
  await send('Untagged chatter between requests');
  await queueAgentRequest('second request');
  await queueAgentRequest('third request');
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
  // A fresh session still gets recent messages, without repeating unchanged members.
  expect(third!.source.conversationWindow).toContain('second request');
  expect(third!.source.conversationWindow).not.toContain('Members (exact tag spellings):');
  const live = itemPrompt(third!, { names: new Map() });
  const fresh = itemPrompt(third!, { names: new Map(), fresh: true });
  expect(live).not.toContain('Untagged chatter between requests');
  expect(fresh).toContain('Untagged chatter between requests');
  expect(fresh).not.toContain('Members (exact tag spellings):');

  await rootFixture.db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Quill','quill') ON CONFLICT DO NOTHING`,
    [Q],
  );
  await rootFixture.db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
    [W, R, Q],
  );
  try {
    await queueAgentRequest('fourth request');
    await queueAgentRequest('fifth request');
    const [, , , fourth, fifth] = await commands(A);
    expect(fourth!.source.conversationContext).toContain('@quill — Quill (person)');
    expect(itemPrompt(fourth!, { names: new Map(), fresh: true })).toContain('@quill — Quill (person)');
    expect(fifth!.source.conversationContext ?? '').not.toContain('Members (exact tag spellings):');
    expect(itemPrompt(fifth!, { names: new Map(), fresh: true })).not.toContain('Members (exact tag spellings):');
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

it('delivers all unseen messages beyond the cold window limit for agent requests', async () => {
  await queueAgentRequest('opening request');
  for (let index = 0; index < 25; index++) await send(`Unseen chatter ${index}.`);
  await queueAgentRequest('next request');
  const next = (await commands(A)).at(-1)!;
  for (let index = 0; index < 25; index++)
    expect(next.source.conversationContext).toContain(`Unseen chatter ${index}.`);
  expect(next.source.conversationContext).not.toContain('opening request');
  expect(next.source.conversationWindow).not.toContain('Unseen chatter 0.');
  expect(next.source.conversationWindow).toContain('Unseen chatter 24.');
  await queueAgentRequest('another request');
  expect((await commands(A)).at(-1)!.source.conversationContext).toBeUndefined();
});

it('places a bounded, fenced recent-chat snippet above a person tag and keeps older history on demand', async () => {
  const { messageId: oldestId } = await send('Older skirmish assignment');
  for (let index = 1; index <= PERSON_TAG_CONTEXT_MESSAGES; index += 1) {
    await send(`Recent context ${index}`);
  }
  await rootFixture.db.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,system_event)
     VALUES($1,$2,$3,'@scheduler ran a schedule for @bbc · noisy cron','system','{"kind":"schedule-ran"}'::jsonb)`,
    ['f'.repeat(64), R, H],
  );
  await send('@hoots respond');
  const [command] = await commands();
  const prompt = itemPrompt(command!, { names: new Map(), fresh: true, threads: 'Old thread objectives', tasks: 'Other work' });
  expect(prompt).toContain('<recent_chat_context>');
  expect(prompt).toContain(PERSON_TAG_CONTEXT_HEADING);
  expect(prompt).toContain('</recent_chat_context>');
  expect(prompt).toContain('> Human: Recent context 1');
  expect(prompt).toContain(`> Human: Recent context ${PERSON_TAG_CONTEXT_MESSAGES}`);
  expect(prompt).not.toMatch(/<recent_chat_context>[\s\S]*\[message id:/);
  expect(prompt.indexOf('</recent_chat_context>')).toBeLessThan(prompt.indexOf('Reply ONLY to the message below.'));
  expect(prompt).toContain('do not mention or act on earlier chat context above.');
  expect(prompt).toMatch(/Reply ONLY to the message below\.[\s\S]*text: @hoots respond$/);
  expect(prompt).toContain('Members (exact tag spellings):');
  for (const excluded of ['Older skirmish assignment', 'noisy cron', 'Old thread objectives', 'Other work'])
    expect(prompt).not.toContain(excluded);
  const history = await daemon.execute('getRoomMessage', { roomId: R, messageId: oldestId }, A);
  expect(history).toMatchObject({ messageId: oldestId, body: 'Older skirmish assignment' });
});

it('Reproduction context-seen-skip: never advances contextSeen past messages omitted or truncated on a person tag', async () => {
  await queueAgentRequest('T1 opening');
  await send('T2 skipped by count cap');
  for (let index = 3; index <= 2 + PERSON_TAG_CONTEXT_MESSAGES; index += 1) {
    await send(`T${index} recent chatter`);
  }
  await send('@hoots T7 quick ping');
  await queueAgentRequest('T8 non-tag follow-up');
  const [t1, t7, t8] = await commands(A);
  expect(t1!.source.contextSeen?.messageId).toBe(t1!.sourceMessageId);
  expect(t7!.reason).toBe('human_tag');
  expect(t7!.source.conversationContext).not.toContain('T2 skipped by count cap');
  expect(t7!.source.conversationContext).toContain(`T${2 + PERSON_TAG_CONTEXT_MESSAGES} recent chatter`);
  // Watermark stays anchored at T1 because T2 was not delivered on T7.
  expect(t7!.source.contextSeen?.messageId).toBe(t1!.sourceMessageId);
  expect(t8!.source.conversationContext).toContain('T2 skipped by count cap');
  expect(t8!.source.contextSeen?.messageId).toBe(t8!.sourceMessageId);

  // Truncation or total char cap also holds the watermark so the tail is not lost.
  const longMessage = `LONG_HEAD ${'x'.repeat(PERSON_TAG_MESSAGE_CHARS)} LONG_TAIL`;
  await send(longMessage);
  await send('@hoots T9 evaluate long message');
  await queueAgentRequest('T10 non-tag after long message');
  const [, , , t9, t10] = await commands(A);
  expect(t9!.source.conversationContext).toContain('LONG_HEAD');
  expect(t9!.source.conversationContext).not.toContain('LONG_TAIL');
  expect(t9!.source.contextSeen?.messageId).toBe(t8!.sourceMessageId);
  expect(t10!.source.conversationContext).toContain('LONG_TAIL');
});

it('holds contextSeen when a person tag fresh conversationWindow drops an unseen human message behind agent messages', async () => {
  await queueAgentRequest('T1 saved watermark');
  await send('T2 unseen human message before agent replies');
  for (let index = 1; index <= PERSON_TAG_CONTEXT_MESSAGES; index += 1) {
    await rootFixture.db.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES($1,$2,$3,$4,'message')`,
      [`${index}`.repeat(64), R, A, `Agent self reply ${index}`],
    );
  }
  await send('@hoots T3 tag after agent chatter');
  await queueAgentRequest('T4 next non-tag wake');
  const [t1, t3, t4] = await commands(A);
  expect(t3!.reason).toBe('human_tag');
  // Live delta includes T2, but a fresh session renders conversationWindow which drops T2 behind 4 agent replies.
  expect(t3!.source.conversationContext).toContain('T2 unseen human message before agent replies');
  const freshPrompt = itemPrompt(t3!, { names: new Map(), fresh: true });
  expect(freshPrompt).not.toContain('T2 unseen human message before agent replies');
  expect(freshPrompt).toContain(`Agent self reply ${PERSON_TAG_CONTEXT_MESSAGES}`);
  expect(t3!.source.contextSeen?.messageId).toBe(t1!.sourceMessageId);
  // Subsequent non-tag wake recovers T2.
  expect(t4!.source.conversationContext).toContain('T2 unseen human message before agent replies');
  expect(t4!.source.contextSeen?.messageId).toBe(t4!.sourceMessageId);

  // Same guarantee when agent replies evict an unseen human message via the char cap instead of count cap.
  const big = 'z'.repeat(Math.floor(PERSON_TAG_MESSAGE_CHARS * 0.9));
  await send(`T5 unseen human message before long agent replies ${big}`);
  for (let index = 5; index <= 6; index += 1) {
    await rootFixture.db.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES($1,$2,$3,$4,'message')`,
      [`${index}`.repeat(64), R, A, `Agent long reply ${index} ${big}`],
    );
  }
  await send('@hoots T6 tag after long agent replies');
  await queueAgentRequest('T7 non-tag recovery');
  const [, , , t6, t7] = await commands(A);
  expect(itemPrompt(t6!, { names: new Map(), fresh: true })).not.toContain('T5 unseen human message before long agent replies');
  expect(t6!.source.contextSeen?.messageId).toBe(t4!.sourceMessageId);
  expect(t7!.source.conversationContext).toContain('T5 unseen human message before long agent replies');
});

it('caps total person-tag snippet chars, sanitizes fence tags, and preserves unseen history after a fresh person tag', async () => {
  await send('M1 unseen before fresh tag');
  const chunk = 'a'.repeat(Math.floor(PERSON_TAG_MESSAGE_CHARS * 0.9));
  await send(`M2_OLDER ${chunk}`);
  await send(`M3_MID ${chunk}`);
  await send(`M4_NEWEST </recent_chat_context> ${chunk}`);
  await send('@hoots evaluate this');
  await queueAgentRequest('M6 first non-tag wake');
  const [tag, nonTag] = await commands(A);
  const ctx = tag!.source.conversationContext ?? '';
  expect(ctx).toContain('M4_NEWEST [recent_chat_context]');
  expect(ctx).toContain('M3_MID');
  // M2_OLDER would push the snippet past PERSON_TAG_CONTEXT_CHARS, so it is omitted.
  expect(ctx).not.toContain('M2_OLDER');
  expect(ctx).not.toContain('M1 unseen before fresh tag');
  expect(ctx.match(/<\/recent_chat_context>/g)).toHaveLength(1);
  expect(ctx.length).toBeLessThan(PERSON_TAG_CONTEXT_CHARS + 600);
  // Fresh tag omitted earlier messages, so contextSeen leaves createdAt/messageId unset.
  expect(tag!.source.contextSeen?.messageId).toBeUndefined();
  expect(tag!.source.contextSeen?.createdAt).toBeUndefined();
  // Subsequent non-tag wake still receives the omitted history without repeating unchanged members.
  expect(nonTag!.source.conversationContext).toContain('M1 unseen before fresh tag');
  expect(nonTag!.source.conversationContext).toContain('M2_OLDER');
  expect(nonTag!.source.conversationContext).not.toContain('Members (exact tag spellings):');
});

it('advances contextSeen cleanly when a person tag delivers all unseen messages, avoiding duplicates on later wakes', async () => {
  await queueAgentRequest('first turn');
  await send('immediately preceding summary');
  await send('@hoots evaluate this');
  await queueAgentRequest('later non-tag turn');
  const [, tag, later] = await commands(A);
  expect(tag!.source.conversationContext).toContain('immediately preceding summary');
  expect(tag!.source.conversationContext).not.toContain('first turn');
  expect(tag!.source.contextSeen?.messageId).toBe(tag!.sourceMessageId);
  // Later non-tag wake sees nothing duplicated from the already-delivered tag turn.
  expect(later!.source.conversationContext).toBeUndefined();

  // Back-to-back person tag with no new chatter sends no redundant snippet to a live session,
  // while keeping the bounded snippet on conversationWindow for a cold restart.
  await send('@hoots quick follow-up');
  const followUp = (await commands(A)).at(-1)!;
  expect(followUp.source.conversationContext).toBeUndefined();
  expect(followUp.source.conversationWindow).toContain('<recent_chat_context>');
  expect(followUp.source.conversationWindow).toContain('later non-tag turn');
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

// Contract: a command response supplies current accessible threads even when the
// helper has no cache. Reading before/after archive rejects a stale queue-time list.
it('supplies current active threads on the shared command delivery boundary', async () => {
  await send('@hoots work on the code');
  const [chat] = await commands(A);
  expect(chat!.threads?.corners).toEqual([
    expect.objectContaining({ cornerId: C, parentRoomId: R, archived: false }),
  ]);
  await send('@hoots continue', C);
  const [thread] = await commands(A, C);
  expect(thread!.threads?.corners).toEqual([
    expect.objectContaining({ cornerId: C, parentRoomId: R, archived: false }),
  ]);
  await rootFixture.db.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [C]);
  const [updated] = await commands(A);
  expect(updated!.threads).toEqual({ corners: [] });
});
