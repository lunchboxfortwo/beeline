// Render the production People picker with DOM adapters for native controls.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { agentInvitationJoinLine, agentInvitationPickerGuide } from '../packages/api-contract/src/agent-invitation-guide.ts';
const root = resolve(import.meta.dirname, '..');
const mobile = createRequire(resolve(root, 'apps/mobile/package.json'));
const out = resolve(root, '.beeline-proof/agent-invitations/picker');
mkdirSync(out, { recursive: true });
const adapters = `import React from 'react';
export const XStack=({children,testID})=><div data-testid={testID}>{children}</div>;
export const YStack=XStack; export const Copy=XStack;
export const Image=()=>null; export const Separator=()=> <hr/>;
export const Spinner=()=>null; export const Globe=()=>null; export const Terminal=()=>null;
export const Glyph=()=>null; export const Face=()=>null;
export const Btn=({children,label,onPress,testID})=><button data-testid={testID} aria-label={label} onClick={onPress}>{children}</button>;
export const SheetRow=({label,onPress,testID})=><button data-testid={testID} onClick={onPress}>{label}</button>;
export const CopyLine=({line,label,onCopy})=><button aria-label={label} onClick={()=>onCopy(line)}>{line}</button>;
export const SheetFrame=({children,back,title,testID})=><section data-testid={testID}><h1>{title}</h1>{back&&<button onClick={back}>Back</button>}{children}</section>;
export const copyText=line=>window.copied=line;
export const monolithPhoneOperation=async()=>({code:'REDACTED',invitationGuide:${JSON.stringify(agentInvitationPickerGuide())}});`;
const result = await build({stdin:{contents:`import React from 'react'; import {createRoot} from 'react-dom/client';
import {AddAgentSheet} from './apps/mobile/sources/ui/screens/people/AddAgentSheet.tsx';
createRoot(document.getElementById('root')).render(<AddAgentSheet open close={()=>{}} workspaceId="proof" workspaceName="Proof" agents={[]}/>);`,resolveDir:root,loader:'tsx'},
 bundle:true,write:false,format:'iife',platform:'browser',loader:{'.png':'dataurl'},
 alias:{react:resolve(mobile.resolve('react'),'..'),'react-dom/client':mobile.resolve('react-dom/client'),'@':resolve(root,'apps/mobile/sources')},
 plugins:[{name:'native-browser-proof',setup(b){
 b.onResolve({filter:/^(tamagui|lucide-react-native|@\/ui\/grammar|@\/sync\/transport\/monolith-operation|\.\/PeopleParts)$/},a=>({path:a.path,namespace:'proof'}));
 b.onLoad({filter:/.*/,namespace:'proof'},()=>({contents:adapters,loader:'tsx',resolveDir:root}));
 }}]});
const browser=await chromium.launch({headless:true});
try {
 for(const [device,width] of [['phone',390],['desktop',1280]]) {
  const page=await browser.newPage({viewport:{width,height:900}});
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({content:result.outputFiles[0].text});
  await page.getByTestId('agent-external').click();
  for(const id of ['grok','muse','claude','codex','gemini','opencode','pi','hermes','zcode']) {
   await page.getByTestId(`harness-${id}`).click();
   await page.getByLabel(/^Copy .* join line$/).click();
   assert.equal(await page.evaluate(()=>window.copied),agentInvitationJoinLine(id==='grok'?'grok bot':id));
   await page.screenshot({path:resolve(out,`${id}-${device}.png`),fullPage:true});
   await page.getByRole('button',{name:'Back',exact:true}).click();
  }
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await page.getByTestId('agent-create').click();
  await page.getByLabel('Copy connect command').click();
  assert.equal(await page.evaluate(()=>window.copied),'npx usebeeline connect REDACTED');
  await page.close();
 }
 writeFileSync(resolve(out,'result.json'),JSON.stringify({reproduction:'onboarding-picker-1',pass:true,adapter:'production AddAgentSheet with DOM native-control adapters; no native-device claim'},null,2));
 console.log('Reproduction onboarding-picker-1: People → Agents + → every harness → copy canonical steps; computer-only helper command passes.');
} finally {await browser.close();}
