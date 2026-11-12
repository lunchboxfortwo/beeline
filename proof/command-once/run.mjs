import {chromium} from 'playwright';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
const here=import.meta.dirname;
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
const results=[];
try{
for(const theme of ['bone','obsidian'])for(const [device,width] of [['web',1100],['phone',390]])for(const before of [true,false]){
const page=await browser.newPage({viewport:{width,height:850}});
page.on('pageerror',error=>console.error(error.message));
await page.goto(`file://${here}/index.html?theme=${theme}${before?'&before':''}`);
await page.getByTestId('grant-command-proof-always').waitFor({timeout:15000});
await page.getByTestId('grant-command-proof-script-toggle').click();
await page.getByText('printf check',{exact:true}).waitFor();
const labels=await page.locator('[data-testid^="grant-command-proof-"]').evaluateAll(nodes=>nodes.filter(n=>/-(always|once|deny)$/.test(n.dataset.testid)).map(n=>n.getAttribute('aria-label')));
if(JSON.stringify(labels)!==JSON.stringify(before?['Approve always','Deny']:['Always','Once','Deny']))throw Error('Wrong decision choices');
const once=await page.getByTestId('grant-command-proof-once').count();
if(once!==Number(!before))throw Error('Once visibility incorrect');
if(!before){await page.getByTestId('grant-command-proof-once').click();if(await page.locator('body').getAttribute('data-decision')!=='once')throw Error('Wrong callback');}
await page.evaluate(()=>document.fonts.ready);
await page.screenshot({path:path.join(here,`${device}-${theme}-${before?'before':'after'}.png`)});
results.push({device,width,theme,before,onceVisible:Boolean(once),labels,callback:before?null:'once'});
await page.close();
}
await writeFile(path.join(here,'results.json'),JSON.stringify(results,null,2));
}finally{await browser.close();}
