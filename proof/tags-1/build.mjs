import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const here=import.meta.dirname, mobile=path.resolve(here,'../../apps/mobile');
const services=new Set(['expo-router','@/buzz/latency-route-hook','@/utils/responsive',
  '@/auth/buzz-identity-storage','@/buzz/use-active-community','@/buzz/surface-storage',
  '@/sync/client-reset','@/buzz/needs-you-store','@/components/buzz/SurfaceGlyphLoader',
  '@/components/buzz/ArtifactCard','@/push/push-room-prefetch','@/sync/transport/monolith-operation',
  '@/utils/open-external-url','@/ui/screens/chats/ChatListHeader','@/buzz/artifact-link','@/components/buzz/RepositoryMark']);
await build({entryPoints:[path.join(here,'app.tsx')],outfile:path.join(here,'bundle.js'),bundle:true,
  platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.join(mobile,'node_modules')],
  define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'isolated-native-hosts',setup(b){
    b.onResolve({filter:/.*/},args=>{
      if(services.has(args.path))return {path:path.join(here,'services.tsx')};
      if(['tamagui','react-native','react-native-svg','@/ui/grammar'].includes(args.path))return {path:path.join(here,'hosts.tsx')};
      if(args.path==='lucide-react-native')return {path:'icons',namespace:'icons'};
      if(args.path.startsWith('@/')){
        const source=path.join(mobile,'sources',args.path.slice(2));
        return {path:['.tsx','.ts','/index.ts','.json'].map(ext=>source+ext).find(existsSync)??source};
      }
    });
    b.onLoad({filter:/.*/,namespace:'icons'},()=>({contents:'export const Check=()=>null; export const CornerDownRight=()=>null;'}));
  }}]});
const fonts=(await Promise.all(['SpaceGrotesk-Regular','SpaceGrotesk-SemiBold'].map(async name=>
  `@font-face{font-family:${name};src:url(data:font/ttf;base64,${(await readFile(path.join(mobile,'sources/assets/fonts',name+'.ttf'))).toString('base64')})}`))).join('');
await writeFile(path.join(here,'index.html'),`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${fonts}body{margin:0}#root{min-height:100vh;display:flex;flex-direction:column}</style><div id="root"></div><script src="bundle.js"></script>`);
