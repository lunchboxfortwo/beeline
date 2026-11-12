import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
const here=import.meta.dirname;
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
const results=[];
await mkdir(path.join(here,'screenshots'),{recursive:true});
try{
  for(const theme of ['bone','obsidian'])for(const width of [390,960])for(const before of [true,false]){
    const page=await browser.newPage({viewport:{width,height:650}});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`file://${here}/index.html?theme=${theme}${before?'&before':''}`);
    const root=page.getByTestId('tag-card-root');
    await root.waitFor();
    const text=await root.innerText();
    assert.equal(text.includes('Ruby needs your decision:'),!before);
    assert.equal(text.includes('Ruby tagged you:'),before);
    assert.equal(await page.getByTestId('tray-decisions-heading').count(),before?0:1);
    assert.equal(await page.getByTestId('tray-tags-heading').count(),1);
    assert.match(await page.getByTestId('tag-card-real').innerText(),/Bee tagged you:/);
    assert.match(await page.getByTestId('tag-card-channel').innerText(),/Bee tagged you:/);
    await page.screenshot({path:path.join(here,'screenshots',`${width}-${theme}-${before?'before':'after'}.png`)});
    await root.click();
    assert.match(await page.locator('body').getAttribute('data-opened'),/root/);
    assert.deepEqual(errors,[]);
    results.push({theme,width,before,rootLabel:before?'tagged you':'needs your decision',opensSource:true});
    await page.close();
  }
  await writeFile(path.join(here,'render-results.json'),JSON.stringify(results,null,2)+'\n');
  console.log('TAGS-1 rendered screen PASS: decisions and real/channel tags, source navigation, Bone/Obsidian at phone/web widths.');
}finally{await browser.close();}
