import { runOwned } from './wait.js';

export interface CursorModelCatalog {
  currentValue: string;
  options: Array<{ id: string; name?: string }>;
}

/**
 * Parse `cursor-agent models` output. Each model prints as one line:
 *
 *   auto - Auto (current, default)
 *   gpt-5.3-codex - GPT-5.3
 *
 * `auto` is cursor-agent's own default and is always served, so it anchors
 * the picker's initial value whenever the CLI lists it.
 */
export function parseCursorModelsOutput(output: string): CursorModelCatalog | undefined {
  const options: Array<{ id: string; name?: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s+-\s+(\S.*?)\s*$/.exec(line);
    if (!match) continue;
    const id = match[1] as string;
    const name = (match[2] as string).replace(/\s*\(current, default\)\s*$/i, '').trim();
    options.push({ id, ...(name && name !== id ? { name } : {}) });
  }
  if (!options.length) return undefined;
  return {
    currentValue: options.some((option) => option.id === 'auto') ? 'auto' : (options[0] as { id: string }).id,
    options,
  };
}

/**
 * Enumerate the models cursor-agent actually serves by running its own
 * `models` command. The owned cursor ACP bridge advertises this catalog at
 * `session/new`; this CLI read remains the connect fallback when ACP is empty.
 */
export async function enumerateCursorModels(
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<CursorModelCatalog | undefined> {
  try {
    const result = await runOwned({ step: 'cursor-agent models', file: 'cursor-agent', args: ['models'], env, signal });
    return result.code === 0 ? parseCursorModelsOutput(result.stdout) : undefined;
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}
