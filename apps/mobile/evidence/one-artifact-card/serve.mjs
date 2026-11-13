// Runs only the isolated proof entry and restores the shipping configuration.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const mobile = fileURLToPath(new URL('../../', import.meta.url));
const entry = `${mobile}index.ts`, metro = `${mobile}metro.config.js`;
const originalEntry = readFileSync(entry, 'utf8'), originalMetro = readFileSync(metro, 'utf8');
writeFileSync(entry, "import './evidence/one-artifact-card/native-proof';\n");
writeFileSync(metro, originalMetro.replace('config.resolver.resolveRequest = (context, moduleName, platform) => {', `config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Native image props must reach React Native Web, as on the affected phone.
  if (moduleName === '@tamagui/image' && platform === 'web') {
    return { filePath: path.resolve(__dirname, 'node_modules/@tamagui/image/dist/esm/Image.native.js'), type: 'sourceFile' };
  }`));
const child = spawn('npx', ['expo', 'start', '--web', '--port', '8101'], {
  cwd: mobile, stdio: 'inherit', env: { ...process.env, EXPO_OFFLINE: '1', EXPO_PUBLIC_BUZZY_MONOLITH_URL: 'http://127.0.0.1:8102' },
});
const restore = () => { writeFileSync(entry, originalEntry); writeFileSync(metro, originalMetro); };
process.once('SIGINT', () => child.kill('SIGINT'));
process.once('SIGTERM', () => child.kill('SIGTERM'));
child.once('exit', code => { restore(); process.exitCode = code ?? 0; });
process.once('exit', restore);
