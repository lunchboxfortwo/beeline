// R1: real dropdown, ThreadLine, RepositoryMark and themes; only store hooks are local fixtures.
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
const evidence=dirname(fileURLToPath(import.meta.url)), mobile=resolve(evidence,'../..'), root=resolve(mobile,'../..');
const out=join(root,'.corner-artifacts/threads-web'); mkdirSync(out,{recursive:true});
const before=execFileSync('git',['show','f095d06bb:apps/mobile/sources/ui/screens/chat/ThreadsDropdown.tsx'],{cwd:root,encoding:'utf8'});
const rows=[{id:'glyph',name:'Threads dropdown glyph',state:'waiting'},{id:'output',name:'Live thread output',state:'working'},{id:'palette',name:'Stone palette',state:'review'}];
const data=`const rows=${JSON.stringify(rows)};export const useRoomCornerSummary=()=>({cornerCount:3,openCorners:rows});export const useRoomCorners=()=>({openRows:rows.map(corner=>({corner,state:corner.state})),record:{nextOpen:null},loadMoreOpen:()=>{}});`;
const source=p=>['','.web.tsx','.web.ts','.web.js','.tsx','.ts','.js','/index.ts','/index.tsx'].map(x=>p+x).find(x=>existsSync(x)&&statSync(x).isFile());
for(const version of ['before','after']) {
 await build({entryPoints:[join(evidence,'scene.tsx')],outfile:join(out,`${version}.js`),bundle:true,banner:{js:'var process={env:{NODE_ENV:"production",EXPO_OS:"web"}};'},platform:'browser',jsx:'automatic',mainFields:['browser','module','main'],resolveExtensions:['.web.tsx','.web.ts','.web.js','.tsx','.ts','.js','.json'],loader:{'.js':'jsx','.ttf':'dataurl','.png':'dataurl'},define:{'process.env.NODE_ENV':'"production"','process.env.EXPO_OS':'"web"',__DEV__:'false',global:'globalThis'},plugins:[{name:'local-room-data',setup(b){
  b.onResolve({filter:/^(expo-router|react-native-reanimated|@\/buzz\/(room-corner-store|use-room-corners))$/},a=>({path:a.path,namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='expo-router'?`import React from 'react';export const useFocusEffect=(f)=>React.useEffect(f,[f]);export const router={push:()=>{}};`:a.path==='react-native-reanimated'?`import {View} from 'react-native';export default {View};`:data,loader:'tsx',resolveDir:mobile}));
  b.onResolve({filter:/^react-native$/},()=>({path:join(mobile,'node_modules/react-native-web/dist/index.js')}));
  b.onResolve({filter:/^@tamagui\/image$/},()=>({path:join(mobile,'node_modules/@tamagui/image/dist/esm/index.native.js')}));
  b.onResolve({filter:/^react-native-svg$/},()=>({path:join(mobile,'node_modules/react-native-svg/lib/module/ReactNativeSVG.web.js')}));
  b.onResolve({filter:/^@\//},a=>({path:source(join(mobile,'sources',a.path.slice(2)))}));
  if(version==='before') b.onLoad({filter:/\/screens\/chat\/ThreadsDropdown\.tsx$/},()=>({contents:before,loader:'tsx',resolveDir:join(mobile,'sources/ui/screens/chat')}));
 }}]});
}
let fonts='';for(const f of ['SpaceGrotesk-Regular','SpaceGrotesk-SemiBold','IBMPlexMono-Regular']){copyFileSync(join(mobile,`sources/assets/fonts/${f}.ttf`),join(out,`${f}.ttf`));fonts+=`@font-face{font-family:'${f}';src:url('/${f}.ttf')}`;}
const server=createServer((req,res)=>{const url=new URL(req.url,'http://localhost');if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}html,body,#root{margin:0;min-height:100%;}</style><div id="root"></div><script src="/${url.searchParams.get('version')}.js"></script>`);return;}const p=join(out,url.pathname);if(!existsSync(p)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',p.endsWith('.js')?'application/javascript':'font/ttf');res.end(readFileSync(p));});
await new Promise(r=>server.listen(18493,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});const results=[];
try{for(const version of ['before','after'])for(const theme of ['light_brass','dark_brass','light_stone','dark_stone']){
 const page=await browser.newPage({viewport:{width:411,height:700},deviceScaleFactor:2});const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack);});
 await page.goto(`http://127.0.0.1:18493/?version=${version}&theme=${theme}`);await page.getByTestId('threads-dropdown-trigger').click();await page.getByTestId('thread-row-glyph').waitFor();await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>Promise.all([...document.images].map(i=>i.decode())));
 const observed=await page.evaluate(()=>{const rows=[...document.querySelectorAll('[data-testid^="thread-row-"]')];return{headerImages:document.querySelectorAll('[data-testid="room-header"] img').length,rows:rows.map(r=>({id:r.dataset.testid,images:r.querySelectorAll('img').length,glyphs:r.querySelectorAll('svg').length,color:r.querySelector('svg')?.getAttribute('stroke')}))};});
 if(errors.length)throw Error(errors.join('\n'));if(observed.headerImages!==1||observed.rows.length!==3)throw Error(JSON.stringify(observed));
 for(const row of observed.rows)if(version==='after'?row.images!==0||row.glyphs!==1:row.images!==1)throw Error(JSON.stringify(observed));
 await page.screenshot({path:join(evidence,`${version}-${theme}.png`)});results.push({version,theme,...observed});console.log(version,theme,JSON.stringify(observed));await page.close();
}}finally{await browser.close();server.close();}
writeFileSync(join(evidence,'observations.json'),JSON.stringify(results,null,2)+'\n');
