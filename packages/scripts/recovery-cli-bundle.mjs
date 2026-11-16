// Both the helper archive and npm package ship this entry. CommonJS
// dependencies (including undici) need require even inside an ESM bundle.
export function recoveryCliBundleArgs(entry, output) {
  return [
    '--no-install',
    'esbuild',
    entry,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node20',
    '--banner:js=import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);',
    `--outfile=${output}`,
  ];
}
