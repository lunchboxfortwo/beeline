import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installPiSystemPrompt } from './pi-session-instructions.js';

describe('Pi session rules', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'beeline-pi-instructions-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes the rules to Pi's SYSTEM.md, replacing an older copy", async () => {
    const env = { PI_CODING_AGENT_DIR: join(root, 'pi') };
    await installPiSystemPrompt(env, 'Old rules.');
    await installPiSystemPrompt(env, 'Keep the approved task and safety rules.');
    expect(await readFile(join(root, 'pi', 'SYSTEM.md'), 'utf8')).toBe(
      'Keep the approved task and safety rules.',
    );
  });

  it('refuses to start without a private agent dir instead of dropping the rules', async () => {
    await expect(installPiSystemPrompt({}, 'Rules.')).rejects.toThrow(/PI_CODING_AGENT_DIR/);
  });
});
