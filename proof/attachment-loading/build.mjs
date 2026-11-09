import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const here = import.meta.dirname;
const mobile = path.resolve(here, '../../apps/mobile');
await build({
  entryPoints: [path.join(here, 'app.tsx')], outfile: path.join(here, 'bundle.js'),
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true', global: 'globalThis' },
  nodePaths: [path.join(mobile, 'node_modules')],
  plugins: [{ name: 'production-row', setup(b) {
    b.onResolve({ filter: /^@proof\/row$/ }, () => ({ path: 'row', namespace: 'row' }));
    b.onLoad({ filter: /.*/, namespace: 'row' }, async () => {
      const base = path.join(mobile, 'sources/app/(app)/beeline/chat');
      const source = await readFile(path.join(base, 'RoomMessageVariants-attachment-card.tsx'), 'utf8');
      const owner = await readFile(path.join(base, 'RoomMessageVariants-ordinary-ledger-message.tsx'), 'utf8');
      const card = source.slice(source.indexOf('export function AttachmentCard('), source.indexOf('\nexport function SwipeToReply'));
      const styles = owner.slice(owner.indexOf('  attachmentCard: {'), owner.indexOf('\nreplyDesktopLabel:'));
      if (!card || !styles) throw Error('Production row extraction failed');
      return { loader: 'tsx', resolveDir: here, contents: `
import React from 'react';
import { View, Text, Pressable as ContentTarget } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ArtifactImage } from '../../apps/mobile/sources/components/buzz/ArtifactMedia';
import { mediaIdFromUrl } from '../../apps/mobile/sources/buzz/artifact';
${(await readFile(path.join(mobile, 'sources/buzz/chat-attachment.ts'), 'utf8')).match(/export function formatAttachmentSize[\s\S]*?\n}/)[0].replace('export ', '')}
const CHEVRON_ROW_SIZE = 14;
function ChevronGlyph() { return <Text>›</Text>; }
const Modal = { show() {} }; const ArtifactViewerScreen = null;
const showPictureActions = () => {}; const openExternalUrl = async () => {}; const attachmentOpenUrl = () => '';
const styles = StyleSheet.create(theme => ({${styles}}));
${card}` };
    });
    b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(mobile, 'node_modules/react-native-web/dist/index.js') }));
    b.onResolve({ filter: /^react-native-unistyles$/ }, () => ({ path: path.join(here, 'theme.ts') }));
    b.onResolve({ filter: /^@\/buzz\/(artifact-link|use-artifact-recovery)$/ }, () => ({ path: path.join(here, 'bytes.ts') }));
    b.onResolve({ filter: /^@\/components\/buzz\/IndexRow$/ }, () => ({ path: path.join(here, 'failure.tsx') }));
    b.onResolve({ filter: /^@\// }, args => ({ path: path.join(mobile, 'sources', args.path.slice(2) + '.ts') }));
    if (process.env.BEFORE) b.onLoad({ filter: /ArtifactMedia\.tsx$/ }, async args => ({
      contents: (await readFile(args.path, 'utf8')).replace('styles.imagePlaceholder, style', 'styles.placeholder, style'), loader: 'tsx', resolveDir: path.dirname(args.path),
    }));
  }}],
});
const fonts = (await Promise.all(['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular'].map(async name => `@font-face{font-family:${name};src:url(data:font/ttf;base64,${(await readFile(path.join(mobile, 'sources/assets/fonts', name + '.ttf'))).toString('base64')})}`))).join('');
await writeFile(path.join(here, 'index.html'), `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${fonts}body{margin:0}</style><div id="root"></div><script src="bundle.js"></script>`);
