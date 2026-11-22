// node build.mjs <mobile-root> <out-dir>: bundle the frame against one checkout's sources.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
const here = dirname(fileURLToPath(import.meta.url));
const [mobile, out] = process.argv.slice(2,4).map(p => resolve(p));
const revision = process.argv[4];
const stubs = resolve(here, 'stubs.tsx');
const stubbed = [/speech-input$/, /VoiceBar$/, /HullDialog$/, /SurfaceGlyphLoader$/, /RuntimeErrorBoundary$/, /window-dimensions$/, /lower-keyboard$/, /use-fine-pointer$/, /agent-display$/, /MemberRosterRow$/, /IdentityMark$/, /^expo-haptics$/, /^react-native-keyboard-controller$/];
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
    if (revision) b.onLoad({filter: /sources\/.*\.(ts|tsx)$/}, args => {
      const repoPath = relative(resolve(mobile, '../..'), args.path);
      if (!['ConversationComposer.tsx', 'ComposerChrome.tsx', 'MentionSuggestionMenu.tsx', 'channel-suggestions.ts', 'tamagui.config.ts'].some(name => args.path.endsWith('/'+name))) return;
      return {contents: execFileSync('git', ['show', revision+':'+repoPath], {cwd:resolve(mobile,'../..'),encoding:'utf8'}), loader: args.path.endsWith('tsx') ? 'tsx' : 'ts', resolveDir: dirname(args.path)};
    });
    b.onResolve({ filter: /.*/ }, args => {
      if (args.importer && stubbed.some(r => r.test(args.path))) return { path: stubs };
      if (args.path === 'react-native') return { path: resolve(mobile, 'node_modules/react-native-web/dist/index.js') };
      if (args.path.startsWith('@/')) return b.resolve('./' + args.path.slice(2), { resolveDir: resolve(mobile, 'sources'), kind: args.kind });
      return undefined;
    });
  } }],
});
for (const face of ['SpaceGrotesk-Regular','SpaceGrotesk-Medium','SpaceGrotesk-SemiBold']) copyFileSync(resolve(mobile, 'sources/assets/fonts', face+'.ttf'), resolve(out, face+'.ttf'));
writeFileSync(resolve(out, 'index.html'), '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>@font-face{font-family:SpaceGrotesk-Regular;src:url(SpaceGrotesk-Regular.ttf)}@font-face{font-family:SpaceGrotesk-SemiBold;src:url(SpaceGrotesk-SemiBold.ttf)}@font-face{font-family:SpaceGrotesk-Medium;src:url(SpaceGrotesk-Medium.ttf)}html,body,#root{margin:0;height:100%}</style><div id="root"></div><script type="module" src="frame.js"></script>');
console.log('built', out);
