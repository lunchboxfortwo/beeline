/**
 * Android stand-in for the shared-browser keyboard fit.
 *
 * The phone build on the emulators is production, and this branch is not
 * deployed, so a share started in the corner does not open there. This serves
 * the viewer document the phone loads: a Squire-shaped page
 * (`#screen { flex: 1; min-height: 0 }`) through this checkout's
 * `serveComputerSession`, including the injected keyboard rules.
 *
 *   OUT=/tmp/kb-proof-out npm run repro:shared-browser-keyboard --prefix apps/server
 *
 * The process prints a URL on 127.0.0.1 and stays up. On an already-running
 * emulator, reverse that port and open the URL in Chrome:
 *
 *   adb -H 127.0.0.1 -P 5037 -s emulator-5634 reverse tcp:PORT tcp:PORT
 *   adb -H 127.0.0.1 -P 5037 -s emulator-5634 shell am start \
 *     -a android.intent.action.VIEW -d "http://127.0.0.1:PORT/s/..."
 *
 * Tap the Email field. The page posts layout measurements to OUT/probes.json
 * (visual viewport, screen height, canvas, email field, keyboard button).
 * With the keyboard open those boxes sit in the visible area. Closing the
 * keyboard restores flex-grow 1.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { migrate } from '../src/database.js';
import { PgliteDatabase } from '../src/test-support.js';
import { LiveHub } from '../src/live.js';
import {
  computerViewToken, createComputerSession, serveComputerSession, serveComputerStatus, upgradeComputerSession,
} from '../src/computer-session.js';

const HUMAN = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111119';
const ROOM = '22222222-2222-4222-8222-222222222229';
const out = process.env.OUT ?? join(tmpdir(), 'kb-proof-out');
await mkdir(out, { recursive: true });

const upstreamHtml = `<!doctype html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  html,body{margin:0;width:100%;height:100%}body{display:flex;flex-direction:column}
  #screen{flex:1;min-height:0;position:relative}
  #remote-email{position:absolute;left:16px;right:72px;bottom:16px;height:44px;z-index:3;font:16px sans-serif}
</style></head><body>
  <div id="bar"><span id="state"></span><button id="focus" aria-label="Open keyboard"></button></div>
  <div id="screen"><canvas id="canvas" tabindex="0" width="1280" height="1600"></canvas>
    <input id="remote-email" type="email" inputmode="email" aria-label="Email" placeholder="Email" autocomplete="off">
  </div>
  <input id="keyboard" type="text" aria-label="Remote keys">
  <script>
    const canvas = document.getElementById('canvas');
    const paint = () => {
      const g = canvas.getContext('2d');
      g.fillStyle = '#f4efe6'; g.fillRect(0, 0, canvas.width, canvas.height);
      g.fillStyle = '#1b1320'; g.font = '64px sans-serif';
      g.fillText('Remote page', 72, 140);
      g.fillText(canvas.width + 'x' + canvas.height, 72, 230);
      g.fillText('Email near page bottom', 72, canvas.height - 210);
      g.strokeStyle = '#1b1320'; g.lineWidth = 6;
      g.strokeRect(72, canvas.height - 170, canvas.width - 220, 100);
    };
    paint();
    new MutationObserver(paint).observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
    const socket = new WebSocket(new URL("stream", location.href));
    const report = () => {
      const vv = window.visualViewport;
      const screen = document.getElementById('screen').getBoundingClientRect();
      const box = canvas.getBoundingClientRect();
      const button = document.getElementById('focus').getBoundingClientRect();
      const email = document.getElementById('remote-email').getBoundingClientRect();
      const row = {
        t: Date.now(), innerWidth, innerHeight,
        vvHeight: vv ? Math.round(vv.height) : null, vvTop: vv ? Math.round(vv.offsetTop) : null,
        screenHeight: Math.round(screen.height),
        flexGrow: getComputedStyle(document.getElementById('screen')).flexGrow,
        canvasTop: Math.round(box.top), canvasBottom: Math.round(box.bottom),
        buttonTop: Math.round(button.top), buttonBottom: Math.round(button.bottom),
        buttonDisplay: getComputedStyle(document.getElementById('bar')).display,
        emailTop: Math.round(email.top), emailBottom: Math.round(email.bottom),
        scrollX, scrollY,
      };
      fetch('/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(row) }).catch(() => {});
    };
    addEventListener('load', report);
    if (window.visualViewport) visualViewport.addEventListener('resize', () => setTimeout(report, 350));
    setInterval(report, 1000);
  </script></body>`;

const squire = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(upstreamHtml);
});
await new Promise<void>((resolve) => squire.listen(0, '127.0.0.1', () => resolve()));
const upstreamPort = (squire.address() as AddressInfo).port;

const database = new PgliteDatabase();
const live = new LiveHub();
await migrate(database);
await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Human'),($2,'agent','Agent')`, [HUMAN, AGENT]);
await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','System')`, [SYSTEM_IDENTITY_ID]);
await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Repro')`, [WORKSPACE]);
await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [ROOM, WORKSPACE]);
await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE, ROOM, AGENT]);
await database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [WORKSPACE, HUMAN]);
await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [WORKSPACE, ROOM, HUMAN]);

const probes: unknown[] = [];
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://beeline.local');
  if (url.pathname === '/probe') {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Buffer));
    request.on('end', () => {
      try { probes.push(JSON.parse(Buffer.concat(chunks).toString())); } catch { /* ignore a partial post */ }
      void writeFile(join(out, 'probes.json'), JSON.stringify(probes, null, 2));
      response.writeHead(204).end();
    });
    return;
  }
  const status = /^\/s\/([A-Za-z0-9_-]{43})\/status$/.exec(url.pathname)?.[1];
  if (status) { void serveComputerStatus(request, response, database, status); return; }
  const id = /^\/s\/([A-Za-z0-9_-]{43})\/?$/.exec(url.pathname)?.[1];
  if (!id) { response.writeHead(404).end(); return; }
  void serveComputerSession(request, response, database, live, id);
});
server.on('upgrade', (request, socket, head) => {
  const match = /^\/s\/([A-Za-z0-9_-]{43})\/stream$/.exec(new URL(request.url ?? '/', 'http://beeline.local').pathname);
  if (!match) { socket.destroy(); return; }
  void upgradeComputerSession(request, socket, head, database, live, match[1]!).catch(() => socket.destroy());
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const port = (server.address() as AddressInfo).port;
const created = await createComputerSession(database, live, {
  roomId: ROOM, agentId: AGENT, sessionId: `keyboard-${Date.now()}`,
  upstreamUrl: `http://127.0.0.1:${upstreamPort}/s/${'k'.repeat(43)}/`,
}, (upstream) => upstream.hostname === '127.0.0.1');
const access = await computerViewToken(database, created.id, HUMAN);
const viewer = `http://127.0.0.1:${port}/s/${created.id}/?access=${access}&embedded=1`;
await writeFile(join(out, 'url.txt'), `${viewer}\n`);
console.log(JSON.stringify({ port, upstreamPort, viewer, out }));
setInterval(() => { /* keep the viewer up until the process is stopped */ }, 60_000);
