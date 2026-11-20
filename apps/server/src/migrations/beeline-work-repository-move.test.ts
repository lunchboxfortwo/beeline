import { afterEach, beforeEach, expect, it } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from '../test-support.js';
import { repointBeelineWorkRepositories } from './beeline-work-repository-move.js';

const OWNER = 'a'.repeat(64), WORKSPACE = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222', CORNER = '33333333-3333-4333-8333-333333333333';
const LINKED = '44444444-4444-4444-8444-444444444444', OTHER = '55555555-5555-4555-8555-555555555555';
const SKILL = '66666666-6666-4666-8666-666666666666';
let db: PgliteDatabase;
beforeEach(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [OWNER]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [WORKSPACE]);
  for (const [id, login] of [[1, 'Beeline-Work'], [2, 'lunchboxfortwo']] as const)
    await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_login,account_type) VALUES($1,$2,$3,'User')`, [id, OWNER, login]);
  for (const [id, installation, name] of [[10, 1, 'Beeline-Work/beeline'], [11, 1, 'Beeline-Work/beeline-dashboard'],
    [12, 1, 'Beeline-Work/apm'], [20, 2, 'lunchboxfortwo/beeline'], [21, 2, 'lunchboxfortwo/beeline-dashboard'],
    [30, 2, 'someone/beeline']] as const)
    await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES($1,$2,$3,'main')`, [id, installation, name]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,repository_key,repository_name,repository_remote,repository_resolution,github_installation_id)
    VALUES($1,$2,'beeline','github:20','lunchboxfortwo/beeline','git://github.com/lunchboxfortwo/beeline','repository',2)`, [PARENT, WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,repository_key) VALUES($1,$2,$3,'issues-triage','github:10')`, [CORNER, WORKSPACE, PARENT]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,repository_key,repository_name,repository_remote,repository_resolution,github_installation_id)
    VALUES($1,$2,'dashboard','github:11','Beeline-Work/beeline-dashboard','git://github.com/Beeline-Work/beeline-dashboard','repository',1)`, [LINKED, WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,repository_key) VALUES($1,$2,$3,'apm','github:12')`, [OTHER, WORKSPACE, PARENT]);
  await db.query(`INSERT INTO workspace_skills(id,workspace_id,slug,description,state,current_version,revision,source_room_id,repository,target_commit,path,kind)
    VALUES($1,$2,'latency','Latency','active',1,1,$3,'Beeline-Work/beeline','',NULL,'procedure')`, [SKILL, WORKSPACE, PARENT]);
  await db.query(`INSERT INTO workspace_skill_versions(skill_id,version,markdown,content_hash,source_job_id,source_message_ids,repository,target_commit,path,extractor_version,model)
    VALUES($1,1,'{}',$2,NULL,$3,'Beeline-Work/beeline','',NULL,'test','n/a')`, [SKILL, 'a'.repeat(64), ['m']]);
});
afterEach(async () => { await db.close(); });

const room = async (id: string) => (await db.query(`SELECT repository_key,repository_name,repository_remote,repository_resolution,github_installation_id::text installation
  FROM rooms WHERE id=$1`, [id])).rows[0];

it('repoints Rooms and saved skill versions from each retired Beeline-Work repository to its lunchboxfortwo move', async () => {
  const untouched = await room(PARENT);
  await repointBeelineWorkRepositories(db);
  await repointBeelineWorkRepositories(db);
  expect(await room(CORNER)).toEqual({ repository_key: 'github:20', repository_name: null, repository_remote: null,
    repository_resolution: 'none', installation: null });
  expect(await room(LINKED)).toEqual({ repository_key: 'github:21', repository_name: 'lunchboxfortwo/beeline-dashboard',
    repository_remote: 'git://github.com/lunchboxfortwo/beeline-dashboard', repository_resolution: 'repository', installation: '2' });
  expect(await room(PARENT)).toEqual(untouched);
  // No moved copy exists, so the binding is left as it was.
  expect((await room(OTHER))?.repository_key).toBe('github:12');
  expect((await db.query(`SELECT repository FROM workspace_skills WHERE id=$1`, [SKILL])).rows)
    .toEqual([{ repository: 'lunchboxfortwo/beeline' }]);
  expect((await db.query(`SELECT repository FROM workspace_skill_versions WHERE skill_id=$1`, [SKILL])).rows)
    .toEqual([{ repository: 'lunchboxfortwo/beeline' }]);
});
