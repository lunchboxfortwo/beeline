import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writePrivateFileAtomically } from './atomic-private-file.js';
import { piSessionFilePath } from './pi-turn-record.js';

export async function piCompactionMarker(session: string, env: Record<string, string>): Promise<string | undefined> {
  const file = await piSessionFilePath(env, session);
  if (!file) return undefined;
  try {
    let marker = '';
    for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.type === 'compaction') marker = entry.id ?? entry.timestamp;
    }
    return marker;
  } catch { return undefined; }
}

/** Pi ignores ACP systemPrompt but replaces its own system prompt with
 * `<agent-dir>/SYSTEM.md`, read when its process starts. Write the session
 * rules there before session/new so they sit in Pi's system slot, once, and
 * survive compaction. Without a private agent dir the session cannot start. */
export async function installPiSystemPrompt(
  env: Record<string, string>,
  instructions: string,
): Promise<void> {
  const agentDir = env.PI_CODING_AGENT_DIR;
  if (!agentDir) throw new Error('Pi session has no PI_CODING_AGENT_DIR for its rules');
  await writePrivateFileAtomically(resolve(agentDir, 'SYSTEM.md'), instructions);
}
