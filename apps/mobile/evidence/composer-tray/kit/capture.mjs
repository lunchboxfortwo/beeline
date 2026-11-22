// Capture production components in Chromium and verify the fixed tray geometry.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const out=resolve('apps/mobile/evidence/composer-tray');
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
const measurements=[];
try {
 for (const device of ['phone','web']) for (const theme of ['bone','obsidian']) {
  const heights={};
  for (const state of ['before','after']) for (const scene of ['menu','one','six']) {
   const page=await browser.newPage({viewport:device==='phone'?{width:390,height:844}:{width:1280,height:800},deviceScaleFactor:1});
   page.on('pageerror',e=>{throw e});
   await page.goto(`http://127.0.0.1:${state==='after'?19371:19372}/?theme=${theme}&scene=${scene}&phone=${device==='phone'?1:0}`);
   await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(150);
   mkdirSync(`${out}/${state}`,{recursive:true});
   await page.screenshot({path:`${out}/${state}/${device}-${theme}-${scene}.png`});
   const frame=page.getByTestId('composer-box');
   const box=await frame.locator('..').boundingBox();
   if(state==='after') {
    heights[scene]=box.height;
    const input=page.getByTestId('chat-input');
    if(scene==='one') {
      await input.fill('First\nSecond\nThird\nFourth\nFifth\nSixth');
      await page.waitForTimeout(150);
      const metrics=await input.evaluate(e=>({height:e.clientHeight,scroll:e.scrollHeight,max:parseFloat(getComputedStyle(e).maxHeight)}));
      assert.equal(metrics.max,92);assert.ok(metrics.height<=92);assert.ok(metrics.scroll>metrics.height);
    }
    if(scene!=='menu') {
     const tiles=page.locator('[data-testid^="pending-chat-attachment-"]').filter({has:page.locator('img,svg')});
     const first=await page.getByTestId('pending-chat-attachment-0').boundingBox();assert.equal(first.height,48);assert.equal(first.width,48);
     const close=await page.getByTestId('pending-chat-attachment-remove-0').boundingBox();assert.equal(close.height,44);assert.equal(close.width,44);
     if(scene==='six') {
      const scroll=page.getByTestId('chat-attachment-scroll');
      await scroll.evaluate(e=>{e.scrollLeft=e.scrollWidth});
      await page.getByRole('button',{name:'Remove file-5.jpg',exact:true}).click();
      await page.getByTestId('pending-chat-attachment-5').waitFor({state:'detached'});
      await page.getByRole('button',{name:'Cancel reply',exact:true}).click();
      await page.getByTestId('reply-composer-banner').waitFor({state:'detached'});
     }
    } else {
     assert.equal(await page.getByTestId('channel-suggestions').getByText('In #beeline',{exact:true}).count(),1);
     assert.equal(await page.getByTestId('channel-suggestions').getByText('and 4 others',{exact:true}).count(),1);
    }
   }
   measurements.push({device,theme,state,scene,height:box.height});await page.close();
  }
  assert.equal(heights.one,heights.six,`${device} ${theme} fixed tray`);
 }
 const touchPage=await browser.newPage({viewport:{width:320,height:844},isMobile:true,hasTouch:true});
 await touchPage.goto('http://127.0.0.1:19371/?theme=bone&scene=six&phone=1');
 await touchPage.getByTestId('chat-input').focus();
 const strip=touchPage.getByTestId('chat-attachment-scroll');
 const bounds=await strip.boundingBox();
 const client=await touchPage.context().newCDPSession(touchPage);
 const y=bounds.y+32;
 await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:280,y}]});
 for(let x=260;x>=60;x-=20) await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y}]});
 await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await touchPage.waitForTimeout(200);
 const scrolled=await strip.evaluate(e=>e.scrollLeft);
 assert.ok(scrolled>0,'touch swipe scrolls the attachment strip');
 assert.ok(await touchPage.getByTestId('chat-input').evaluate(e=>e===document.activeElement),'touch scrolling retains input focus');
 await touchPage.screenshot({path:`${out}/after/phone-bone-touch-scroll.png`});
 measurements.push({device:'phone-320',theme:'bone',state:'after',scene:'touch-scroll',scrollLeft:scrolled});
 await touchPage.close();
} finally {await browser.close()}
writeFileSync(`${out}/measurements.json`,JSON.stringify(measurements,null,2)+'\n');
console.log('Verified equal composer heights, 48px thumbnails, 44px targets, removals, and one menu title.');
