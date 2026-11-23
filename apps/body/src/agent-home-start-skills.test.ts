import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AGENT_KINDS } from './agent-command.js';
import { agentSkillDir, prepareRoomAgentCredentials } from './agent-home.js';
import { beelineManagedSkills } from './beeline-skill.js';
import { DRAW_AVATAR_SKILL_NAME } from './draw-avatar-skill.js';

const roots: string[] = [];
const links: string[] = [];
afterEach(async () => {
  await Promise.all(links.splice(0).map((path) => rm(path, { force: true })));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function newRoom() {
  const root = await mkdtemp(join(tmpdir(), 'start-skills-'));
  roots.push(root);
  const operatorHome = join(root, 'operator');
  await mkdir(operatorHome);
  return { home: join(root, 'agent-home'), operatorHome };
}

const managedNames = (isReviewer = false) =>
  [
    DRAW_AVATAR_SKILL_NAME,
    ...beelineManagedSkills('test', { isReviewer }).map(({ name }) => name),
  ].sort();

it.each(AGENT_KINDS)(
  'a new Room home for %s carries the Beeline skills before the harness starts',
  async (kind) => {
    const { home, operatorHome } = await newRoom();
    const env = await prepareRoomAgentCredentials({ root: home, operatorHome, agentKind: kind });
    links.push(env.TMPDIR!);
    expect((await readdir(join(home, agentSkillDir(kind), 'skills'))).sort()).toEqual(
      managedNames(),
    );
  },
);

it('pi-skills-1123: a new Pi Room lists beeline-triage and beeline-spec where Pi discovers skills', async () => {
  const { home, operatorHome } = await newRoom();
  const env = await prepareRoomAgentCredentials({
    root: home,
    operatorHome,
    agentKind: 'pi',
    failClosed: true,
  });
  links.push(env.TMPDIR!);
  // Pi loads `$PI_CODING_AGENT_DIR/skills/<name>/SKILL.md` and lists each by its
  // frontmatter name and absolute location, so the rule's names load without a search.
  for (const name of ['beeline-triage', 'beeline-spec']) {
    const skill = await readFile(
      join(env.PI_CODING_AGENT_DIR!, 'skills', name, 'SKILL.md'),
      'utf8',
    );
    expect(skill).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: \\S`));
  }
});

it('keeps operator shares and adds the review skill for a reviewer, as prepare does', async () => {
  const { home, operatorHome } = await newRoom();
  await mkdir(join(operatorHome, '.agents/skills/operator-notes'), { recursive: true });
  await writeFile(
    join(operatorHome, '.agents/skills/operator-notes/SKILL.md'),
    '---\nname: operator-notes\n---\n',
  );
  const env = await prepareRoomAgentCredentials({
    root: home,
    operatorHome,
    agentKind: 'pi',
    isReviewer: true,
  });
  links.push(env.TMPDIR!);
  expect((await readdir(join(home, 'pi', 'skills'))).sort()).toEqual(
    [...managedNames(true), 'operator-notes'].sort(),
  );
});

it('an explicit share that cannot be resolved still leaves the Beeline skills in the private home', async () => {
  const { home, operatorHome } = await newRoom();
  const env = await prepareRoomAgentCredentials({
    root: home,
    operatorHome,
    agentKind: 'pi',
    failClosed: true,
    sharedSkills: ['missing-share'],
  });
  links.push(env.TMPDIR!);
  expect(env.PI_CODING_AGENT_DIR).toBe(join(home, 'pi'));
  expect((await readdir(join(home, 'pi', 'skills'))).sort()).toEqual(managedNames());
});
