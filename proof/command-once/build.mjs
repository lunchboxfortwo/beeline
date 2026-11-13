import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {existsSync} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const here=import.meta.dirname,mobile=path.resolve(here,'../../apps/mobile');
const require=createRequire(path.join(mobile,'package.json'));
const before=process.argv.includes('--before');
await build({entryPoints:[path.join(here,'app.tsx')],outfile:path.join(here,before?'before.js':'after.js'),banner:{js:'globalThis.process={env:{NODE_ENV:"development"},browser:true};'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',resolveExtensions:['.web.tsx','.web.ts','.web.js','.tsx','.ts','.js','.json'],mainFields:['browser','module','main'],define:{'process.env.TAMAGUI_TARGET':'"web"','process.env.NODE_ENV':'"development"',__DEV__:'true',global:'globalThis'},nodePaths:[path.join(mobile,'node_modules')],plugins:[{name:'isolated-services',setup(b){
 b.onResolve({filter:/^(react|react-dom)(\/.*)?$/},args=>({path:require.resolve(args.path)}));
 b.onResolve({filter:/^react-native$/},()=>({path:path.join(mobile,'node_modules/react-native-web/dist/index.js')}));
 b.onResolve({filter:/^react-native-svg$/},()=>({path:path.join(mobile,'node_modules/react-native-svg/lib/module/ReactNativeSVG.web.js')}));
 b.onResolve({filter:/react-native-reanimated|react-native-safe-area-context|lower-keyboard$|RequestMedia$|\/IdentityMark$|\/Ledger$|^\.\/ErrorBanner$/},args=>({path:args.path,namespace:'stubs'}));
 b.onLoad({filter:/.*/,namespace:'stubs'},()=>({loader:'jsx',contents:`import React from 'react'; export const lowerKeyboard=()=>{}; export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0}); export const RequestMedia=()=>null; export const IdentityMark=()=>null; export const ErrorBanner=()=>null; export const LedgerEntryFrame=({children})=>children; export default {createAnimatedComponent:x=>x};`}));
 b.onResolve({filter:/^@\//},args=>{const source=path.join(mobile,'sources',args.path.slice(2));return {path:['.tsx','.ts','/index.ts','/index.tsx','.web.ts'].map(ext=>source+ext).find(existsSync)??source};});
 if(before)b.onLoad({filter:/GrantRequestCard\.tsx$/},args=>({contents:execFileSync('git',['show','23aa526^:apps/mobile/sources/components/buzz/GrantRequestCard.tsx'],{encoding:'utf8'}),loader:'tsx',resolveDir:path.dirname(args.path)}));
}}]});
const fonts=(await Promise.all(['SpaceGrotesk-Regular','SpaceGrotesk-SemiBold','IBMPlexMono-Regular'].map(async name=>`@font-face{font-family:${name};src:url(data:font/ttf;base64,${(await readFile(path.join(mobile,'sources/assets/fonts',name+'.ttf'))).toString('base64')})}`))).join('');
await writeFile(path.join(here,'index.html'),`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}body{margin:0}</style><div id="root"></div><script>document.write('<script src="'+(location.search.includes('before')?'before':'after')+'.js"><'+'/script>')</script>`);

// Reuse the same historical card on the native fixture.
const historical=execFileSync('git',['show','23aa526^:apps/mobile/sources/components/buzz/GrantRequestCard.tsx'],{encoding:'utf8'}).replace("from './AgentApprovalCard'","from '../../../apps/mobile/sources/components/buzz/AgentApprovalCard'").replace("from './Ledger'","from '../../../apps/mobile/sources/components/buzz/Ledger'");
await writeFile(path.join(here,'native/BeforeCard.tsx'),historical);
