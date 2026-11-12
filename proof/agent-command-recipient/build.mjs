import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
const here = import.meta.dirname;
const mobile = path.resolve(here, '../../apps/mobile');
await build({ entryPoints: [path.join(here, 'app.tsx')], outfile: path.join(here, 'bundle.js'),
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
  mainFields: ['browser', 'module', 'main'],
  define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true', global: 'globalThis' },
  nodePaths: [path.join(mobile, 'node_modules')],
  plugins: [{ name: 'browser-hosts', setup(b) {
    b.onResolve({ filter: /^(tamagui|@\/ui\/grammar|\.\/MonoHull)$/ }, () => ({ path: path.join(here, 'hosts.tsx') }));
    b.onResolve({ filter: /^lucide-react-native$/ }, () => ({ path: 'icons', namespace: 'icons' }));
    b.onLoad({ filter: /.*/, namespace: 'icons' }, () => ({ contents: 'export const ArrowRight = () => null; export const Bookmark = () => null;' }));
    b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(mobile, 'node_modules/react-native-web/dist/index.js') }));
    b.onResolve({ filter: /^react-native-svg$/ }, () => ({ path: path.join(mobile, 'node_modules/react-native-svg/lib/module/ReactNativeSVG.web.js') }));
    b.onResolve({ filter: /^@\// }, args => {
      const source = path.join(mobile, 'sources', args.path.slice(2));
      return { path: ['.tsx', '.ts', '/index.ts', '.json'].map(ext => source + ext).find(existsSync) ?? source };
    });
  }}],
});
const fonts = (await Promise.all(['SpaceGrotesk-Regular', 'SpaceGrotesk-SemiBold'].map(async name =>
  `@font-face{font-family:${name};src:url(data:font/ttf;base64,${(await readFile(path.join(mobile, 'sources/assets/fonts', name + '.ttf'))).toString('base64')})}`))).join('');
await writeFile(path.join(here, 'index.html'), `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${fonts}body{margin:0}svg{position:relative}</style><div id="root"></div><script src="bundle.js"></script>`);
