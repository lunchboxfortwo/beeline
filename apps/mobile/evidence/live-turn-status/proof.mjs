// Render production thread status and live steps against local conversation fixtures.
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
const evidence=dirname(fileURLToPath(import.meta.url)), mobile=resolve(evidence,'../..'), root=resolve(mobile,'../..');
const out=join(root,'.corner-artifacts/live-turn-web'); mkdirSync(out,{recursive:true});
const source=p=>['','.web.tsx','.web.ts','.web.js','.tsx','.ts','.js','/index.ts','/index.tsx'].map(x=>p+x).find(x=>existsSync(x)&&statSync(x).isFile());
for(const version of ['before','after']) {
 await build({entryPoints:[join(evidence,'scene.tsx')],outfile:join(out,`${version}.js`),bundle:true,banner:{js:'var process={env:{NODE_ENV:"production",EXPO_OS:"web"}};'},platform:'browser',jsx:'automatic',mainFields:['browser','module','main'],resolveExtensions:['.web.tsx','.web.ts','.web.js','.tsx','.ts','.js','.json'],loader:{'.js':'jsx','.ttf':'dataurl','.png':'dataurl'},define:{'process.env.NODE_ENV':'"production"','process.env.EXPO_OS':'"web"',__DEV__:'false',global:'globalThis'},plugins:[{name:'local-room-data',setup(b){
  b.onResolve({filter:/^(react-native-keyboard-controller|expo-router|react-native-reanimated|@\/ui\/screens\/tags\/WorkBoard|@\/sync\/transport\/monolith-operation|@\/buzz\/room-view-presentation|\.\/ToolOutputSheet|\.\/MonoMarkdown|\.\/StreamingProse)$/},a=>({path:a.path,namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='react-native-keyboard-controller'?`export const useReanimatedKeyboardAnimation=()=>({height:{value:0},progress:{value:0}});export const KeyboardController={dismiss:()=>{}};`:a.path==='expo-router'?`export const router={push:()=>{}};`:a.path==='react-native-reanimated'?`import {View,Text,ScrollView} from 'react-native';export default {View,Text,ScrollView,createAnimatedComponent:x=>x};export const Easing={linear:x=>x,inOut:x=>x,out:x=>x,quad:x=>x,cubic:x=>x,poly:()=>x=>x};export const ReduceMotion={System:0};export const FadeInDown={duration(){return this},reduceMotion(){return this}};export const useSharedValue=x=>({value:x});export const useReducedMotion=()=>true;export const useAnimatedStyle=f=>f();export const useAnimatedProps=f=>f();export const withRepeat=x=>x;export const withTiming=x=>x;export const withDelay=(_,x)=>x;export const withSpring=x=>x;export const cancelAnimation=()=>{};export const interpolate=(v,a,b)=>b[0];export const runOnJS=f=>f;export const runOnUI=f=>f;export const useDerivedValue=f=>({value:f()});export const useAnimatedReaction=()=>{};` :a.path.includes('WorkBoard')?`export const WorkAvatar=()=>null;export const WorkAssigneePicker=()=>null;`:a.path.includes('monolith-operation')?`export const monolithPhoneOperation=async()=>({});`:a.path.includes('room-view-presentation')?`export const displayRoomMessage=x=>x;`:`export const ToolOutputSheet=()=>null;export const MonoMarkdown=()=>null;export const StreamingProse=()=>null;`,loader:'tsx',resolveDir:mobile}));
  b.onResolve({filter:/^react-native$/},()=>({path:join(mobile,'node_modules/react-native-web/dist/index.js')}));
  b.onResolve({filter:/^@tamagui\/image$/},()=>({path:join(mobile,'node_modules/@tamagui/image/dist/esm/index.native.js')}));
  b.onResolve({filter:/^react-native-svg$/},()=>({path:join(mobile,'node_modules/react-native-svg/lib/module/ReactNativeSVG.web.js')}));
  b.onResolve({filter:/^@\//},a=>({path:source(join(mobile,'sources',a.path.slice(2)))}));
  if(version==='before') b.onLoad({filter:/\/(?:(ThreadHeader|ThreadLine|TurnProgressLine)\.tsx|turn-clock\.ts)$/},a=>({contents:execFileSync('git',['show',`d36b8d2babb2dc47d85d3a4ff7bdec4c103d7d44:${a.path.slice(root.length+1)}`],{cwd:root,encoding:'utf8'}),loader:'tsx',resolveDir:dirname(a.path)}));
 }}]});
}
let fonts='';for(const f of ['SpaceGrotesk-Regular','SpaceGrotesk-SemiBold','IBMPlexMono-Regular']){copyFileSync(join(mobile,`sources/assets/fonts/${f}.ttf`),join(out,`${f}.ttf`));fonts+=`@font-face{font-family:'${f}';src:url('/${f}.ttf')}`;}
const server=createServer((req,res)=>{const url=new URL(req.url,'http://localhost');if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}html,body,#root{margin:0;min-height:100%;}</style><div id="root"></div><script src="/${url.searchParams.get('version')}.js"></script>`);return;}const p=join(out,url.pathname);if(!existsSync(p)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',p.endsWith('.js')?'application/javascript':'font/ttf');res.end(readFileSync(p));});
await new Promise(r=>server.listen(18495,'127.0.0.1',r));
console.log('Proof server http://127.0.0.1:18495');
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try {
 for (const version of ['before','after']) for (const theme of ['light_brass','dark_brass']) for (const [device,width,height] of [['phone',411,880],['web',1100,900]]) {
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)});
  await page.goto(`http://127.0.0.1:18495/?version=${version}&theme=${theme}`);
  await page.getByTestId('thread-row').waitFor();await page.evaluate(()=>document.fonts.ready);
  if(version==='after') {
    await page.getByText('2 steps',{exact:true}).waitFor();
    await page.evaluate(()=>globalThis.finishStep());
    await page.getByText('3 steps',{exact:true}).waitFor();
    if(await page.getByText('Ruby is working',{exact:true}).count()!==3)throw Error('Missing working surface');
  }
  if(errors.length)throw Error(errors.join('\n'));
  await page.screenshot({path:join(evidence,`${version}-${theme}-${device}.png`)});
  console.log(version,theme,device);await page.close();
 }
} finally { await browser.close(); }
if(!process.argv.includes('--serve'))server.close();
