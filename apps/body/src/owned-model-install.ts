import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeIsolatedHarnessFile } from './agent-home.js';
/** The release owns this extension; activation writes only its import declaration. */
export async function installOwnedModelProvider(piHome: string | undefined): Promise<void> {
  if (!piHome) return;
  const meta = import.meta.url;
  const entry = meta.startsWith('beeline:')
    ? resolve(dirname(process.argv[1]!), 'owned-model-provider.mjs')
    : fileURLToPath(
        new URL(
          existsSync(fileURLToPath(new URL('./owned-model-provider.js', meta)))
            ? './owned-model-provider.js'
            : './owned-model-provider.ts',
          meta,
        ),
      );
  if (!existsSync(entry)) throw new Error('The pinned helper does not contain its model provider');
  await mkdir(resolve(piHome, 'extensions'), { recursive: true, mode: 0o700 });
  await rm(resolve(piHome,'extensions','beeline-turn-budget.js'),{force:true});
  await writeIsolatedHarnessFile(
    resolve(piHome, 'extensions', 'beeline-owned-model.js'),
    `export {default} from ${JSON.stringify(pathToFileURL(entry).href)};\n`,
  );
}
