import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { SqlDatabase } from './database.js';
import { migrate } from './database.js';
import { seedCornerOpening, PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import type { GitHubOperations } from './github-operations.js';
import { postRepositoryOnboarding, sanitizeRepositoryName, validateRepositoryName } from './repository-onboarding.js';
import type { CommittedMessageLiveRow } from './live.js';

const H = 'a'.repeat(64), A = 'b'.repeat(64), OTHER = 'c'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111', R = '22222222-2222-4222-8222-222222222222';
const NAMED_R = '44444444-4444-4444-8444-444444444444';
let db: PgliteDatabase, phone: PhoneService;
let nextRepoId = 100;
const github = { refresh: vi.fn(async () => ({})),
  createRepository: vi.fn(async (_viewer: string, input: { name: string }, database: SqlDatabase) => {
    const id = nextRepoId++;
    await database.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,active) VALUES($1,77,$2,'main',true)`, [id, `tester/${input.name}`]);
    return { id, fullName: `tester/${input.name}`, installationId: 77, defaultBranch: 'main', private: true };
  }),
} as unknown as GitHubOperations;

beforeAll(async () => {
  db = new PgliteDatabase();

  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Test','tester'),($2,'agent','Beebee','beebee'),($3,'human','Other','other')`, [H,A,OTHER]);
  await db.query(`UPDATE identities SET github_subject=CASE WHEN id=$1 THEN '296966200' ELSE '123' END WHERE id IN ($1,$2)`, [H,OTHER]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Onboarding test')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'general',$3),($4,$2,'wargame',$3)`, [R,W,H,NAMED_R]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [A,H]);
  for (const identity of [H,A]) {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner'),($1,$4,$2,'owner')`, [W,identity,R,NAMED_R]);
  }
  await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_login,account_type,repository_selection,status) VALUES(77,$1,'tester','User','all','active')`, [H]);
  await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,active) VALUES(42,77,'tester/project','main',true),(43,77,'tester/other','main',true)`);
  phone = new PhoneService(db, 'https://server.test', github);
}, 30_000);
afterAll(async () => { await db?.close(); });

it('sanitizes and validates repository names', () => {
  expect(sanitizeRepositoryName('lunchboxfortwo/Wargame.git')).toBe('wargame');
  expect(sanitizeRepositoryName('#My Game!')).toBe('my-game');
  expect(sanitizeRepositoryName('..')).toBeUndefined();
  expect(validateRepositoryName(' wargame_2 ')).toBe('wargame_2');
  expect(() => validateRepositoryName('bad name')).toThrow(/letters, numbers/i);
  expect(() => validateRepositoryName('wargame.git')).toThrow(/letters, numbers/i);
});

it('defaults new repo name to requested name, then chat name, and falls back in generic chats', async () => {
  const fromChat = await postRepositoryOnboarding(db, github, { roomId: NAMED_R, agentId: A, requesterId: H, kind: 'repository' });
  expect(fromChat.defaultName).toBe('wargame');
  expect(fromChat.installationAccount).toBe('tester');
  const fromRequest = await postRepositoryOnboarding(db, github, { roomId: NAMED_R, agentId: A, requesterId: H, kind: 'repository', repository: 'lunchboxfortwo/Siege-RTS' });
  expect(fromRequest.defaultName).toBe('siege-rts');
  expect(fromRequest.selected).toBeUndefined();
  const generic = await postRepositoryOnboarding(db, github, { roomId: R, agentId: A, requesterId: H, kind: 'repository' });
  expect(generic.defaultName).toMatch(/^new-project-[0-9a-f]{6}$/);
});

it('shows installation missing for an account without an installation', async () => {
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`, [W,OTHER]);
  const card = await postRepositoryOnboarding(db, undefined, { roomId:R, agentId:A, requesterId:OTHER, kind:'repository' });
  expect(card.state).toBe('install_missing');
  expect(card.ownerHandle).toBe('tester');
  expect(card.canLink).toBe(false);
  await expect(phone.execute('actOnRepositoryCard', { roomId:R, cardId:card.id, action:'install', redirectUri:'beeline://beeline/github-installation' }, OTHER)).rejects.toThrow();
  await expect(phone.execute('actOnRepositoryCard', { roomId:R, cardId:card.id, action:'link', repositoryId:42 }, OTHER)).rejects.toThrow();
});

it('pre-selects an installation repo the agent named and uses an uninstalled name as defaultName', async () => {
  const card = await postRepositoryOnboarding(db, github, { roomId:R, agentId:A, requesterId:H, kind:'repository', repository:'Tester/Other' });
  expect(card.selected).toBe('tester/other');
  expect(card.repositories.find(repo => repo.fullName === 'tester/other')).toBeTruthy();
  const bare = await postRepositoryOnboarding(db, github, { roomId:R, agentId:A, requesterId:H, kind:'repository', repository:'project' });
  expect(bare.selected).toBe('tester/project');
  const missed = await postRepositoryOnboarding(db, github, { roomId:R, agentId:A, requesterId:H, kind:'repository', repository:'nope/missing' });
  expect(missed.selected).toBeUndefined();
  expect(missed.defaultName).toBe('missing');
  expect(missed.repositories.map(repo => repo.fullName)).not.toContain('nope/missing');
});

it('links from the card, settles immediately with the linked repo without posting starters, and switches without touching open work', async () => {
  const card = await postRepositoryOnboarding(db, github, { roomId:R, agentId:A, requesterId:H, kind:'repository' });
  expect(card.state).toBe('no_repo_linked');
  const before = await phone.readRoom(R,H);
  expect(before?.messages.find(message => message.id === card.id)?.onboarding?.repositories).toHaveLength(2);
  await phone.execute('actOnRepositoryCard', { roomId:R, cardId:card.id, action:'link', repositoryId:42 }, H);
  expect((await db.query(`SELECT identity_id FROM repository_link_successes`)).rows).toEqual([{ identity_id: H }]);
  const linked = await phone.readRoom(R,H);
  const settledCard = linked?.messages.find(message => message.id === card.id)?.onboarding;
  expect(settledCard).toMatchObject({ status: 'settled', repository: 'tester/project', selected: '42' });
  expect(linked?.messages.filter(message => message.onboarding)).toHaveLength(1);
  const corner='33333333-3333-4333-8333-333333333333';
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,repository_key,repository_name,repository_remote,repository_resolution,github_installation_id)
    VALUES($1,$2,$3,'open-work','github:42','tester/project','git://github.com/tester/project','repository',77)`, [corner,W,R]);
  await db.query(`INSERT INTO corner_facts(corner_id,lifecycle) VALUES($1,'{"pr":{"number":17,"url":"https://github.com/tester/project/pull/17"}}')`, [corner]);
  await seedCornerOpening(db, { cornerId: corner, commissionedBy: H });
  const switchCard = await postRepositoryOnboarding(db, github, { roomId:R, agentId:A, requesterId:H, kind:'repository' });
  expect(switchCard.repositories.find(r => r.id === 42)?.current).toBe(true);
  await phone.execute('actOnRepositoryCard', { roomId:R, cardId:switchCard.id, action:'link', repositoryId:43 }, H);
  const switchedRoom = await phone.readRoom(R,H);
  expect(switchedRoom?.repository?.name).toBe('tester/other');
  expect(switchedRoom?.messages.find(message => message.id === switchCard.id)?.onboarding).toMatchObject({ status: 'settled', repository: 'tester/other' });
  expect((await db.query(`SELECT repository_name FROM rooms WHERE id=$1`,[corner])).rows[0]?.repository_name).toBe('tester/project');
  expect((await db.query(`SELECT lifecycle->'pr'->>'url' url FROM corner_facts WHERE corner_id=$1`,[corner])).rows[0]?.url).toBe('https://github.com/tester/project/pull/17');
});

it('creates and links a custom-named private repository once when the same tap is retried', async () => {
  vi.mocked(github.createRepository).mockClear();
  const card = await postRepositoryOnboarding(db, github, { roomId: NAMED_R, agentId: A, requesterId: H, kind: 'repository' });
  await expect(phone.execute('actOnRepositoryCard', { roomId: NAMED_R, cardId: card.id, action: 'create', name: 'bad name' }, H)).rejects.toThrow(/letters, numbers/i);
  const tap = { roomId: NAMED_R, cardId: card.id, action: 'create' as const, name: 'wargame-rts' };
  await phone.execute('actOnRepositoryCard', tap, H);
  await phone.execute('actOnRepositoryCard', tap, H);
  expect(github.createRepository).toHaveBeenCalledTimes(1);
  expect(github.createRepository).toHaveBeenCalledWith(H, expect.objectContaining({ installationId: 77, name: 'wargame-rts', private: true }), expect.anything());
  const room = await phone.readRoom(NAMED_R, H);
  expect(room?.repository?.name).toBe('tester/wargame-rts');
  expect(room?.messages.find(m => m.id === card.id)?.onboarding).toMatchObject({ status: 'settled', repository: 'tester/wargame-rts', defaultName: 'wargame-rts' });
});

it('hides retired historical starters cards from room reads and live deltas', async () => {
  const legacyId = 'e'.repeat(64);
  const legacyCard = {
    id: legacyId, roomId: NAMED_R, agentId: A, requesterId: H, kind: 'starters', state: 'repo_linked',
    status: 'open', canLink: true, repository: 'tester/wargame-rts', defaultName: 'wargame-rts', repositories: [],
    starters: [{ id: 'readme', title: 'Make the README useful', evidence: 'Empty', task: 'Write README' }],
  };
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
     VALUES($1,$2,$3,'@beebee suggested work tester/wargame-rts','card','repository-onboarding',$4)`,
    [legacyId, NAMED_R, A, JSON.stringify(legacyCard)],
  );
  expect((await phone.readRoom(NAMED_R, H))?.messages.some(m => m.id === legacyId)).toBe(false);
  const row = (await db.query<CommittedMessageLiveRow>(`SELECT m.*,i.kind author_kind,i.name author_name,
    i.handle author_handle,i.avatar author_avatar,i.face_id author_face,ARRAY[]::text[] tagged_ids
    FROM messages m JOIN identities i ON i.id=m.author_id WHERE m.id=$1`, [legacyId])).rows[0]!;
  expect(await phone.projectCommittedLiveDelta(NAMED_R, { type: 'message', row }, H)).toBeNull();
});

it('advertises cards to Google-only viewers without feature configuration', async () => {
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING`, [W,R,OTHER]);
  expect(await phone.execute('getAuthCapabilities', {}, OTHER)).toHaveProperty('repositoryOnboarding', true);
  const card = await postRepositoryOnboarding(db, undefined, { roomId:R, agentId:A, requesterId:OTHER, kind:'repository' });
  expect((await phone.readRoom(R, OTHER))?.messages.some(message => message.id === card.id)).toBe(true);
});

it('keeps another requester\'s unanswered card open when onboarding an invitee', async () => {
  const ownerCard = await postRepositoryOnboarding(db, github, { roomId:R, agentId:A, requesterId:H, kind:'repository' });
  const inviteeCard = await postRepositoryOnboarding(db, github, { roomId:R, agentId:A, requesterId:OTHER, kind:'repository' });
  const cards = (await db.query<{ id: string; status: string }>(
    `SELECT id,card->>'status' status FROM messages WHERE id=ANY($1::text[])`, [[ownerCard.id, inviteeCard.id]])).rows;
  expect(cards).toHaveLength(2);
  expect(cards.every(card => card.status === 'open')).toBe(true);
});

it('R-onb-22: public rollout keeps personal repository choices private in reads and live deltas', async () => {
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING`,[W,R,OTHER]);
  const card=await postRepositoryOnboarding(db,github,{roomId:R,agentId:A,requesterId:H,kind:'repository'});
  expect((await phone.readRoom(R,H))?.messages.some(message=>message.id===card.id)).toBe(true);
  expect((await phone.readRoom(R,OTHER))?.messages.some(message=>message.id===card.id)).toBe(false);
  const row=(await db.query<CommittedMessageLiveRow>(`SELECT m.*,i.kind author_kind,i.name author_name,
    i.handle author_handle,i.avatar author_avatar,i.face_id author_face,ARRAY[]::text[] tagged_ids
    FROM messages m JOIN identities i ON i.id=m.author_id WHERE m.id=$1`,[card.id])).rows[0]!;
  expect(await phone.projectCommittedLiveDelta(R,{type:'message',row},H)).toMatchObject({type:'message-delta'});
  expect(await phone.projectCommittedLiveDelta(R,{type:'message',row},OTHER)).toBeNull();
  expect(await phone.readLiveDelta(R,OTHER,{type:'message',messageId:card.id})).toBeNull();
});

it('E19/E20: allows any Google-only identity without configuration', async () => {
  await db.query(`UPDATE identities SET github_subject=NULL WHERE id=$1`, [OTHER]);
  const card = await postRepositoryOnboarding(db, undefined, { roomId:R, agentId:A, requesterId:OTHER, kind:'repository' });
  expect(card.githubLinked).toBe(false);
  expect(card.repositories).toEqual([]);
});


it('opens the picker for covered users and refreshes one live card in place', async () => {
  const card = await db.transaction(tx => postRepositoryOnboarding(tx, github, { roomId:R, agentId:A, requesterId:H, kind:'repository' }));
  const result = await phone.execute('actOnRepositoryCard', { roomId:R, cardId:card.id, action:'install', redirectUri:'beeline://beeline/github-installation' }, H);
  expect(result).toEqual({ openPicker:true });
  await phone.execute('actOnRepositoryCard', { roomId:R, cardId:card.id, action:'refresh' }, H);
  const current = (await phone.readRoom(R,H))!.messages.filter(m => m.onboarding?.kind === 'repository' && m.onboarding.status === 'open');
  expect(current).toHaveLength(1);
  expect(current[0]!.id).toBe(card.id);
  expect(current[0]!.onboarding!.defaultName).toBe(card.defaultName);
});
