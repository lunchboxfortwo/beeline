import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { webProofShims } from './runtime-shims.mjs';
const mobile = path.resolve('apps/mobile'),
  out = path.resolve('.scratch/room-preview');
fs.mkdirSync(out, { recursive: true });
const shims = webProofShims(mobile);
shims['react-native-reanimated'] += 'export const FadeOut=FadeInDown;';
shims['react-native-unistyles'] = shims['react-native-unistyles'].replace(
  'beelineThemes.obsidian',
  "beelineThemes[new URLSearchParams(location.search).get('theme')||'bone']",
);
Object.assign(shims, {
  'expo-font': 'export const useFonts=()=>[true,null];export const isLoaded=()=>true;',
  '@/buzz/speech-input':
    'export const useSpeechInput=()=>({available:false,capability:"unavailable",modelDownloadOffered:false,state:"idle",start:()=>{},stop:()=>{},cancel:()=>{}});',
  '@/buzz/client-error-report': 'export const reportClientError=()=>{};',
  '@/buzz/media-cache': 'export const mediaCache={};',
  'expo-router': 'export const router={};export const useRouter=()=>({});',
});
await build({
  entryPoints: ['packages/scripts/connector-preview/room.tsx'],
  outfile: out + '/bundle.js',
  nodePaths: [mobile + '/node_modules'],
  bundle: true,
  platform: 'browser',
  jsx: 'automatic',
  mainFields: ['browser', 'module', 'main'],
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
  loader: { '.js': 'jsx', '.ttf': 'dataurl', '.png': 'dataurl' },
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.EXPO_OS': '"web"',
    __DEV__: 'false',
    global: 'globalThis',
  },
  plugins: [
    {
      name: 'preview',
      setup(api) {
        api.onResolve({ filter: /.*/ }, ({ path: spec }) => {
          if (spec in shims) return { path: spec, namespace: 'shim' };
          if (spec === 'react-native')
            return { path: mobile + '/node_modules/react-native-web/dist/index.js' };
          if (spec === 'react-native-svg')
            return {
              path: mobile + '/node_modules/react-native-svg/lib/module/ReactNativeSVG.web.js',
            };
          if (spec === 'react-dom/client')
            return { path: mobile + '/node_modules/react-dom/client.js' };
          if (spec.startsWith('@/')) {
            const base = mobile + '/sources/' + spec.slice(2);
            return {
              path: ['', '.web.tsx', '.web.ts', '.tsx', '.ts', '.json', '/index.ts', '/index.tsx']
                .map((e) => base + e)
                .find((p) => fs.existsSync(p) && fs.statSync(p).isFile()),
            };
          }
        });
        api.onLoad({ filter: /.*/, namespace: 'shim' }, ({ path: spec }) => ({
          contents: shims[spec],
          loader: 'tsx',
          resolveDir: mobile,
        }));
      },
    },
  ],
});
let fonts = '';
for (const name of [
  'SpaceGrotesk-Regular',
  'SpaceGrotesk-Medium',
  'SpaceGrotesk-SemiBold',
  'IBMPlexMono-Regular',
])
  fonts += `@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${fs.readFileSync(mobile + '/sources/assets/fonts/' + name + '.ttf').toString('base64')})}`;
fs.writeFileSync(
  out + '/index.html',
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}html,body{margin:0}*{box-sizing:border-box}</style><div id="root"></div><script src="bundle.js"></script>`,
);
