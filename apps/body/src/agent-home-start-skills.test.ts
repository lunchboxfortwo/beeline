import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

it('installs only managed skills and preserves existing shares for a reviewer', async () => {
  const { home, operatorHome } = await newRoom();
  await mkdir(join(operatorHome, '.agents/skills/operator-notes'), { recursive: true });
  await writeFile(
    join(operatorHome, '.agents/skills/operator-notes/SKILL.md'),
    '---\nname: operator-notes\n---\n',
  );
  const existingShare = join(home, 'pi/skills/previous-share');
  await mkdir(existingShare, { recursive: true });
  await writeFile(join(existingShare, 'SKILL.md'), 'previously prepared share');
  const env = await prepareRoomAgentCredentials({
    root: home,
    operatorHome,
    agentKind: 'pi',
    isReviewer: true,
  });
  links.push(env.TMPDIR!);
  expect((await readdir(join(home, 'pi', 'skills'))).sort()).toEqual(
    [...managedNames(true), 'previous-share'].sort(),
  );
  expect(await readFile(join(existingShare, 'SKILL.md'), 'utf8')).toBe('previously prepared share');
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

it('a configured home that is a file recovers with the rule-named Pi skills', async () => {
  const { home, operatorHome } = await newRoom();
  await writeFile(home, 'unusable home');
  const env = await prepareRoomAgentCredentials({ root: home, operatorHome, agentKind: 'pi' });
  roots.push(dirname(env.HOME!));
  expect(env.PI_CODING_AGENT_DIR).not.toBe(join(home, 'pi'));
  expect((await readdir(join(env.PI_CODING_AGENT_DIR!, 'skills'))).sort()).toEqual(managedNames());
  for (const name of ['beeline-triage', 'beeline-spec']) {
    expect(
      await readFile(join(env.PI_CODING_AGENT_DIR!, 'skills', name, 'SKILL.md'), 'utf8'),
    ).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: \\S`));
  }
  expect(await readFile(home, 'utf8')).toBe('unusable home');
});

it.each(['skills-link', 'skill-link', 'file-link', 'hard-link', 'stale'])(
  'startup replaces %s with private release-owned skills without mutating its source',
  async (shape) => {
    const { home, operatorHome } = await newRoom();
    const source = join(operatorHome, 'source');
    await mkdir(source);
    const original = join(source, 'SKILL.md');
    await writeFile(original, 'old skill');
    const target = join(home, 'pi/skills/beeline-triage');
    await mkdir(join(home, 'pi'), { recursive: true });
    if (shape === 'skills-link') {
      await symlink(source, join(home, 'pi/skills'));
    } else if (shape === 'skill-link') {
      await mkdir(dirname(target));
      await symlink(source, target);
    } else {
      await mkdir(target, { recursive: true });
      if (shape === 'hard-link') await link(original, join(target, 'SKILL.md'));
      else if (shape === 'file-link') await symlink(original, join(target, 'SKILL.md'));
      else await writeFile(join(target, 'SKILL.md'), 'old skill');
    }
    const env = await prepareRoomAgentCredentials({ root: home, operatorHome, agentKind: 'pi' });
    links.push(env.TMPDIR!);
    expect(env.PI_CODING_AGENT_DIR).toBe(join(home, 'pi'));
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toMatch(
      /^---\nname: beeline-triage\ndescription: \S/,
    );
    for (const path of [join(home, 'pi/skills'), target, join(target, 'SKILL.md')]) {
      expect((await lstat(path)).isSymbolicLink()).toBe(false);
    }
    const stats = await lstat(join(target, 'SKILL.md'));
    expect(stats.nlink).toBe(1);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(await readFile(original, 'utf8')).toBe('old skill');
    expect(await readdir(source)).toEqual(['SKILL.md']);
  },
);
