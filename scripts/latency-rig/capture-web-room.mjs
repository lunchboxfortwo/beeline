#!/usr/bin/env node
// Measure warm busy-Room selection through a complete visible message frame.
// Run against the unchanged seed-local.mjs fixture in a disposable browser.
import WebSocket from 'ws';
import { completeRoomFrame } from './web-room-frame.mjs';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const endpoint = process.env.LATENCY_RIG_CDP ?? 'http://127.0.0.1:18083';
if (!['localhost', '127.0.0.1'].includes(new URL(endpoint).hostname))
  throw Error('Loopback CDP required');
const pages = await (await fetch(`${endpoint}/json/list`)).json();
const page = pages.find((p) => p.type === 'page' && p.url.startsWith('http://127.0.0.1:'));
if (!page) throw Error('Open the local web export and select Latency Rig 200 first');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.once('open', r));
let sequence = 0;
const pending = new Map();
ws.on('message', (b) => {
  const m = JSON.parse(b);
  if (m.id) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(m.error) : p.resolve(m.result);
  }
});
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const largeId = createHash('sha256')
  .update('beeline-latency-rig:message:10kb-answer')
  .digest('hex');
const samples = [];
try {
  await call('Emulation.setCPUThrottlingRate', {
    rate: Number(process.env.LATENCY_RIG_CPU_RATE ?? 1),
  });
  for (let capture = 0; capture < 2; capture++) {
    const durations = [];
    for (let sample = 0; sample < 20; sample++) {
      await evaluate(
        `(async()=>{const e=document.querySelector('[aria-label="#Rig room 002"]');if(!e)throw Error('Missing alternate Room');e.click();await new Promise(r=>setTimeout(r,500));})()`,
      );
      const result = await evaluate(`new Promise((resolve,reject)=>{
    const selector='[data-testid="chat-message-text-${largeId}"]';
    const completeRoomFrame=${completeRoomFrame.toString()};
    if(document.querySelector(selector)?.getBoundingClientRect().width>0)return reject(Error('Old busy Room remains visible'));
    const row=document.querySelector('[aria-label="#Rig room 001"]');if(!row)return reject(Error('Missing busy Room'));
    const start=performance.now();const timeout=setTimeout(()=>reject(Error('Complete Room frame timed out')),10000);
    row.click();
    function frame(){
      if(completeRoomFrame(document,'${largeId}')) {
        requestAnimationFrame(()=>{if(!completeRoomFrame(document,'${largeId}'))return requestAnimationFrame(frame);clearTimeout(timeout);resolve({durationMs:performance.now()-start});});return;
      }requestAnimationFrame(frame);
    }requestAnimationFrame(frame);
   })`);
      durations.push(result.durationMs);
    }
    const sorted = [...durations].sort((a, b) => a - b);
    samples.push({ capture, samples: durations, p50: sorted[9], p95: sorted[18] });
  }
  const report = {
    endpoint,
    url: page.url,
    browser: await evaluate('({userAgent:navigator.userAgent,viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,scripts:[...document.scripts].map(e=>e.src)})'),
    cpuRate: Number(process.env.LATENCY_RIG_CPU_RATE ?? 1),
    completion: 'Full fixture answer and visible composer hit-tested; all visible bodies complete; following frame revalidated',
    captures: samples,
  };
  await writeFile(process.argv[2] ?? 'web-room.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(samples.map(({ capture, p50, p95 }) => ({ capture, p50, p95 }))));
} finally {
  ws.close();
}
