#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateBundleDirectory } from './pages-site.mjs';

export async function mergeBeelineBundles({ outputDir, inputDirs, carriedArm64Dir }) {
  outputDir = resolve(outputDir);
  inputDirs = inputDirs.map((directory) => resolve(directory));
  if (inputDirs.length === 0) throw new Error('at least one helper bundle directory is required');
  const inputs = [];
  for (const directory of inputDirs) {
    inputs.push({ directory, ...(await validateBundleDirectory(directory)) });
  }
  const identity = inputs[0].manifest;
  for (const input of inputs)
    if (JSON.stringify(input.manifest.recovery) !== JSON.stringify(identity.recovery))
      throw new Error(`helper recovery bootstrap differs in ${input.directory}`);
  const bundles = {};
  await mkdir(outputDir, { recursive: true });
  for (const input of inputs) {
    if (
      input.manifest.sourceCommit !== identity.sourceCommit ||
      input.manifest.version !== identity.version
    ) {
      throw new Error(`helper bundle identity differs in ${input.directory}`);
    }
    for (const [platform, bundle] of Object.entries(input.manifest.bundles)) {
      if (bundles[platform]) throw new Error(`duplicate helper bundle platform ${platform}`);
      bundles[platform] = bundle;
      for (const name of [bundle.file, `${bundle.file}.sha256`]) {
        const source = join(input.directory, name);
        const destination = join(outputDir, name);
        if (source !== destination) await copyFile(source, destination);
      }
    }
  }
  const manifest = { ...identity, bundles };
  // Outage recovery only: retain the verified Apple-silicon archive verbatim.
  // The old identity remains on the entry; it must never be restamped as new.
  if (carriedArm64Dir) {
    const { manifest: previous } = await validateBundleDirectory(resolve(carriedArm64Dir));
    const carried = previous.bundles['darwin-arm64'];
    if (!carried || bundles['darwin-arm64']) throw new Error('expected one carried darwin-arm64 helper');
    bundles['darwin-arm64'] = { ...carried, carriedFrom: { commit: carried.commit, version: carried.version, sha256: carried.sha256 } };
    for (const name of [carried.file, `${carried.file}.sha256`])
      await copyFile(join(carriedArm64Dir, name), join(outputDir, name));
    console.log(`Helper darwin-arm64 carried unchanged: ${carried.version} ${carried.commit} sha256=${carried.sha256}`);
  }
  if (identity.recovery)
    for (const name of [identity.recovery.file, `${identity.recovery.file}.sha256`]) {
      const source = join(inputs[0].directory, name);
      const destination = join(outputDir, name);
      if (source !== destination) await copyFile(source, destination);
    }
  await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await validateBundleDirectory(outputDir, {
    expectedSha: identity.sourceCommit,
    expectedVersion: identity.version,
  });
  return manifest;
}

async function main() {
  const outputIndex = process.argv.indexOf('--output-dir');
  const outputDir = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  const inputDirs = process.argv
    .flatMap((value, index) => (value === '--input-dir' ? [process.argv[index + 1]] : []))
    .filter(Boolean);
  if (!outputDir || inputDirs.length === 0) {
    throw new Error(
      'usage: merge-beeline-bundles.mjs --output-dir DIR --input-dir DIR [--input-dir DIR ...]',
    );
  }
  const carryIndex = process.argv.indexOf('--carry-arm64-dir');
  const carriedArm64Dir = carryIndex >= 0 ? process.argv[carryIndex + 1] : undefined;
  if (carryIndex >= 0 && !carriedArm64Dir) throw new Error('--carry-arm64-dir needs a directory');
  const manifest = await mergeBeelineBundles({ outputDir, inputDirs, carriedArm64Dir });
  console.log(
    `merge-beeline-bundles: ${Object.keys(manifest.bundles).sort().join(', ')} for ${manifest.version}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      `merge-beeline-bundles: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
