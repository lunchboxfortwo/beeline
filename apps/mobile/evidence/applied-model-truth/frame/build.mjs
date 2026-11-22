// node build.mjs <mobile-root> <out-dir>: bundle the frame against one checkout's sources.
import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
const here = dirname(fileURLToPath(import.meta.url));
const [mobile, out] = process.argv.slice(2).map(p => resolve(p));
const stubs = resolve(here, 'stubs.tsx');
const stubbed = [/\/use-room-view$/, /\/use-workspace-roster$/, /\/workspace-records$/, /\/useAgentProfile$/,
  /\/use-active-community$/, /\/ui\/shell\/panel$/, /\/utils\/responsive$/, /\/latency-route-hook$/,
  /\/monolith-operation$/, /\/InvitePeopleSheet$/, /\/VoicePreviewPlayer$/, /\/AgentVoice$/, /^@\/modal$/,
  /^expo-router(\/|$)/, /^expo-clipboard$/];
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [resolve(here, 'frame.tsx')], bundle: true, outfile: resolve(out, 'frame.js'), format: 'esm',
  platform: 'browser', jsx: 'automatic', loader: { '.js': 'jsx', '.png': 'dataurl', '.ttf': 'dataurl', '.otf': 'dataurl', '.woff2': 'dataurl' },
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.jsx', '.json'],
  nodePaths: [resolve(mobile, 'node_modules'), resolve(mobile, '../../node_modules')],
  define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', 'process.env.EXPO_OS': '"web"', global: 'globalThis' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "production", EXPO_OS: "web" } };' },
  logLevel: 'warning',
  plugins: [{ name: 'frame', setup(b) {
    b.onResolve({ filter: /.*/ }, args => {
      if (args.importer && stubbed.some(r => r.test(args.path))) return { path: stubs };
      if (args.path === 'react-native') return { path: resolve(mobile, 'node_modules/react-native-web/dist/index.js') };
      if (args.path.startsWith('@/')) return b.resolve('./' + args.path.slice(2), { resolveDir: resolve(mobile, 'sources'), kind: args.kind });
      return undefined;
    });
  } }],
});
writeFileSync(resolve(out, 'index.html'), '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;height:100%}</style><div id="root"></div><script type="module" src="frame.js"></script>');
console.log('built', out);
