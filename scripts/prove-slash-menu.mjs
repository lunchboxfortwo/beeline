// Production picker and markdown with DOM adapters for native controls.
// Captures are browser stand-ins, not installed native-app screenshots.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { beelineThemes, stonePalette } from '../apps/mobile/sources/buzz/groknight.ts';
import { agentCommandCatalogPublisher } from '../apps/body/src/agent-command-catalog.ts';
const root = resolve(import.meta.dirname, '..');
// Keep the original reproduction usable after the fix is committed.
const baseline = process.argv[2] ?? 'ef2ad4125';
const out = resolve(root, '.beeline-proof/slash-menu');
mkdirSync(out, { recursive: true });
const mobile = createRequire(resolve(root, 'apps/mobile/package.json'));
const harness = [{ name: 'skill:draw-avatar', description: 'Generate or refine your persisted avatar' }, { name: 'skill:beeline-memory' }];
let commands;
agentCommandCatalogPublisher({ api: { execute: async (_, payload) => { commands = payload.commands; } }, agentId: 'stand-in-grunt', workspaceId: 'proof' })(harness);
assert.deepEqual(commands.map(c => c.name), ['draw-avatar']);
const adapters = `import React from 'react';
const space={0:0,1:4,2:8,3:12,4:16};
const val=v=>space[v]??v;
function host(tag, horizontal=false){return ({children,testID,onPress,style,...p})=>{
 const s={display:'flex',flexDirection:horizontal?'row':'column',boxSizing:'border-box',borderWidth:0,flexShrink:0,...style};
 for(const k of ['width','height','minHeight','minWidth','maxHeight','flex','flexShrink','alignItems','justifyContent','overflow'])if(p[k]!==undefined)s[k]=p[k];
 for(const k of ['padding','gap','paddingLeft','paddingTop','marginBottom'])if(p[k]!==undefined)s[k]=val(p[k]);
 for(const [a,b,c] of [['paddingHorizontal','paddingLeft','paddingRight'],['paddingVertical','paddingTop','paddingBottom']])if(p[a]!==undefined)s[b]=s[c]=val(p[a]);
 for(const k of ['borderWidth','borderTopWidth'])if(p[k]!==undefined){s[k]=p[k];s.borderStyle='solid';}
 s.borderColor='var(--stroke)';if(p.backgroundColor)s.backgroundColor='var(--'+p.backgroundColor+')';
 if(p.borderRadius)s.borderRadius=p.borderRadius==='md'?8:3;
 return React.createElement(tag,{'data-testid':testID,onClick:onPress,style:s},children);};}
export const YStack=host('div'), XStack=host('div',true), Card=host('section'), ListItem=host('button',true), ScrollView=host('div');
export const HEIGHT={sheetRow:56};
export function T({children,v,color,style,testID,numberOfLines}){return <span data-testid={testID} style={{fontSize:v?.startsWith('meta')?13:16,lineHeight:v?.startsWith('meta')?'19px':'23px',fontWeight:v?.endsWith('Strong')?600:400,color:color==='secondary'?'var(--secondary)':undefined,whiteSpace:numberOfLines===1?'nowrap':undefined,overflow:numberOfLines===1?'hidden':undefined,textOverflow:numberOfLines===1?'ellipsis':undefined,...style}}>{children}</span>}
export function ProseRun({children,marks}){return <span style={{fontWeight:marks?.includes('strong')?600:400}}>{children}</span>}
export const Indent=YStack;
export const Btn=({children,label,onPress})=><button aria-label={label} onClick={onPress} style={{width:44,height:44,background:'none',border:0,color:'inherit'}}>{children}</button>;
export const Glyph=({icon:Icon})=><Icon/>;
export const Slash=()=> <svg data-slash width="14" height="14"><path d="M1 13L13 1" stroke="currentColor"/></svg>;
export const X=()=> <svg width="16" height="16"><path d="M2 2L14 14M14 2L2 14" stroke="currentColor"/></svg>;
export const Platform={OS:'web'};
export const CodeBlock=()=>null, ChatLinkRun=()=>null;
export const messageLinkId=()=>undefined, openMessageLink=()=>{},openExternalUrl=()=>{};`;
const font = readFileSync(resolve(root, 'apps/mobile/sources/assets/fonts/SpaceGrotesk-Regular.ttf')).toString('base64');
const semibold = readFileSync(resolve(root, 'apps/mobile/sources/assets/fonts/SpaceGrotesk-SemiBold.ttf')).toString('base64');
const browser = await chromium.launch({ headless: true });
const results = [];
try {
 for (const phase of ['before','after']) {
  const catalog = phase === 'before' ? [...harness, commands[0]] : commands;
  const bundle = await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';
import {SlashVerbPicker} from './apps/mobile/sources/components/buzz/SlashVerbPicker.tsx';
import {MonoMarkdown} from './apps/mobile/sources/components/buzz/MonoMarkdown.tsx';
createRoot(document.getElementById('root')).render(<main><h2>Commands · Grunt</h2><p>Browser stand-in · production picker and message renderer</p><div id="message"><MonoMarkdown textStyle={{}} markdown="You can also give a refinement, like /draw-avatar make her more glamorous."/></div><div id="long"><MonoMarkdown textStyle={{}} markdown={'x'.repeat(150)}/></div><SlashVerbPicker verbs={[{id:'open-corner',command:'open-corner',label:'Open corner',description:'Start a corner'}]} commands={${JSON.stringify(catalog)}} agentName="Grunt" query="" highlightedIndex={0} onDismiss={()=>{}} onSelect={()=>{}} onSelectCommand={name=>{window.selected=name}}/><footer>@minerva /</footer></main>);`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',format:'iife',alias:{react:resolve(mobile.resolve('react'),'..'),'react-dom/client':mobile.resolve('react-dom/client'),'@':resolve(root,'apps/mobile/sources')},plugins:[{name:'native-dom',setup(b){
   b.onResolve({filter:/^(tamagui|lucide-react-native|react-native|@\/ui\/grammar|@\/components\/buzz\/(CodeBlock|ChatLinks)|@\/buzz\/message-link|@\/utils\/open-external-url)$/},a=>({path:a.path,namespace:'adapter'}));
   b.onLoad({filter:/.*/,namespace:'adapter'},()=>({contents:adapters,loader:'tsx',resolveDir:root}));
   if(phase==='before')b.onLoad({filter:/(SlashVerbPicker|MonoMarkdown|Suggestions)\.tsx$/},a=>({contents:execFileSync('git',['show',`${baseline}:${a.path.slice(root.length+1)}`],{encoding:'utf8'}),loader:'tsx',resolveDir:resolve(a.path,'..')}));
  }}]});
  for(const [device,width] of [['phone',390],['web',1280]])for(const theme of ['light','dark']){
   const page=await browser.newPage({viewport:{width,height:820}});
   const palette={...beelineThemes[theme === 'light' ? 'bone' : 'obsidian'], ...stonePalette[theme]};
   await page.setContent(`<style>@font-face{font-family:Space;src:url(data:font/ttf;base64,${font})}@font-face{font-family:Space;src:url(data:font/ttf;base64,${semibold});font-weight:600}body{--canvas:${palette.bgBase};--highlight:${palette.bgHighlight};--stroke:${palette.border};--secondary:${palette.textSecondary};background:var(--canvas);color:${palette.textPrimary};font:16px/23px Space;margin:0}main{max-width:620px;margin:32px auto;padding:16px}button{font-family:inherit;color:inherit;text-align:left}p{font-size:13px;color:var(--secondary)}#message{margin:32px 0;overflow-wrap:normal}#long{overflow-wrap:anywhere;max-width:200px;margin:16px 0;font-size:13px;line-height:19px}footer{border:1px solid var(--stroke);padding:16px;border-radius:8px}h2{font-size:24px}</style><div id="root"></div>`);
   await page.addScriptTag({content:bundle.outputFiles[0].text});
   await page.getByTestId('slash-verb-picker').waitFor();
   await page.evaluate(()=>document.fonts.ready);
   // Same narrow message measure for both phases: a command crosses a line before the fix (Chromium breaks at the hyphen).
   const measure=await page.evaluate(()=>{
    const box=document.querySelector('#message');const walker=document.createTreeWalker(box,NodeFilter.SHOW_TEXT);let n;const nodes=[];while(n=walker.nextNode())nodes.push(n);
    const node=nodes.find(n=>n.textContent.includes('/'));const text=node.textContent;const start=text.indexOf('/'), end=text.indexOf(' make')-1;
    const y=i=>{const r=document.createRange();r.setStart(node,i);r.setEnd(node,i+1);return r.getBoundingClientRect().y};
    for(let w=220;w<=340;w++){box.style.width=w+'px';if(y(start)!==y(end))return w;}return 273;
   });
   // The baseline's chosen width is shared with the corresponding fixed capture.
   const key=`${device}-${theme}`;
   if(phase==='before')results.push({key,measure});
   const chosen=results.find(r=>r.key===key).measure;
   await page.locator('#message').evaluate((el,w)=>{el.style.width=w+'px'},chosen);
   const split=await page.evaluate(()=>{
    const walker=document.createTreeWalker(document.querySelector('#message'),NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){const s=n.textContent;if(!s.includes('/'))continue;const start=s.indexOf('/'),end=s.indexOf(' make');const ys=[];for(let i=start;i<end;i++){if(s[i]==='\u2060')continue;const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+1);ys.push(r.getBoundingClientRect().y)}return new Set(ys).size>1;}
   });
   assert.equal(split,phase==='before',`${phase} ${key} command wrapping`);
   assert.equal(await page.locator('[data-slash]').count(),phase==='before'?4:0);
   if(phase==='after'){
    assert.equal(await page.locator('[data-testid^="slash-agent-command-"]').count(),1);
    await page.getByTestId('slash-agent-command-draw-avatar').click();
    assert.equal(await page.evaluate(()=>window.selected),'draw-avatar');
    const aligned=await page.evaluate(()=>{const h=document.querySelector('[data-testid="slash-verb-picker"] span'),row=document.querySelector('[data-testid="slash-agent-command-draw-avatar"] span');return Math.abs(h.getBoundingClientRect().x-row.getBoundingClientRect().x)<1});
    assert.ok(aligned,'row name aligns with header');
    assert.ok(await page.locator('#long').evaluate(el=>el.clientHeight>23),'ordinary long text still wraps');
   }
   await page.screenshot({path:resolve(out,`${phase}-${key}.png`),fullPage:true});
   await page.close();
  }
 }
 writeFileSync(resolve(out,'result.json'),JSON.stringify({reproductions:['slash-dup','slash-wrap'],pass:true,adapter:'Production components with DOM native-control adapters; phone viewport and web, not native device proof',results},null,2));
 console.log('Reproduction slash-dup and slash-wrap: before fails visibly; after renders one draw-avatar, no rule skills or slash tiles, aligned names and joined commands in both themes and viewports.');
}finally{await browser.close();}
