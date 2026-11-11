import { createServer, AddressInfo, spawn, existsSync, mkdtemp, readFile, rm, join, describe, expect, it, WebSocket, WebSocketServer, findChromiumPage, shareChromiumPage, waitForComputerHandback, computerViewToken, computerViewerHtml, createComputerSession, endComputerSession, getComputerSession, HUMAN, OTHER, AGENT, ROOM, testSquire, opened, nextType, until, fixtureScope1 } from './test-support-computer-session.test-support.js';

describe('computer session handoff', () => {
const scope1 = fixtureScope1();

  it.skipIf(!existsSync(scope1.chromeBinary))('hands an actual agent-owned Chromium tab to a viewer and waits for handback', async () => {
    let profile = '';
    let chrome!: ReturnType<typeof spawn>;
    let spawnFailed = false;
    try {
      let port = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        profile = await mkdtemp(join(process.cwd(), '.computer-e2e-'));
        chrome = spawn(scope1.chromeBinary, [
          '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
          '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
          `--user-data-dir=${profile}`, `${scope1.origin}/page`,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        spawnFailed = false;
        let startupError = '';
        chrome.stderr?.on('data', (data: Buffer) => { startupError = (startupError + data.toString()).slice(-4_000); });
        chrome.on('error', (error) => { startupError = error.message; spawnFailed = true; });
        try {
          port = await until(async () => {
            try {
              const found = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
              return found > 0 ? found : undefined;
            } catch { return undefined; }
          }, 15_000);
          break;
        } catch (error) {
          if (!spawnFailed && chrome.exitCode === null && chrome.signalCode === null) {
            chrome.kill('SIGTERM');
            await new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
          }
          await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
          profile = '';
          if (attempt === 3) throw new Error(`Chromium startup failed after 3 attempts: ${startupError || String(error)}`);
        }
      }
      const debugUrl = `http://127.0.0.1:${port}`;
      const page = await until(async () => {
        try { return await findChromiumPage(debugUrl, '/page'); } catch { return undefined; }
      });
      // A browser automation client may already be attached to the shared tab.
      const existingDevtools = new WebSocket(page.webSocketDebuggerUrl!);
      await opened(existingDevtools);
      existingDevtools.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
      const share = await createComputerSession(scope1.database, scope1.live, {
        roomId: ROOM, agentId: AGENT, sessionId: page.id, upstreamUrl: 'body:', title: 'Live Chrome',
      });
      const access = await computerViewToken(scope1.database, share.id, HUMAN);
      await shareChromiumPage({ page, serverBaseUrl: scope1.origin, shareId: share.id,
        daemonToken: 'test-token', onEnded: async () => {} });
      const viewer = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${access}`);
      // The server can send its cached frame in the same packet as the upgrade.
      // Listen before open so a static page's only frame cannot be missed.
      let receivedScreen: { decoded: { method?: string; params?: { data?: string } }; binary: boolean } | undefined;
      const receiveScreen = (data: WebSocket.RawData, binary: boolean) => {
        const decoded = JSON.parse(data.toString()) as { method?: string; params?: { data?: string } };
        if (decoded.method === 'Page.screencastFrame' && decoded.params?.data)
          receivedScreen = { decoded, binary };
      };
      viewer.on('message', receiveScreen);
      await opened(viewer);
      const screen = await until(async () => receivedScreen);
      viewer.off('message', receiveScreen);
      expect(screen.binary).toBe(false);
      expect(Buffer.from(screen.decoded.params!.data!, 'base64').subarray(0, 3).toString('hex')).toBe('ffd8ff');
      const agentWait = waitForComputerHandback({ serverBaseUrl: scope1.origin, shareId: share.id, daemonToken: 'test-token' });
      viewer.send(JSON.stringify({ type: 'takeover' }));
      viewer.send(JSON.stringify({ id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 30, y: 20, button: 'left', clickCount: 1 } }));
      viewer.send(JSON.stringify({ id: 2, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 30, y: 20, button: 'left', clickCount: 1 } }));
      await until(async () => (await findChromiumPage(debugUrl, page.id)).title === 'clicked' ? true : undefined);
      // Copy returns the shared tab's selection to the controlling viewer.
      existingDevtools.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: 'getSelection().selectAllChildren(document.body)' } }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      const copied = nextType(viewer, 'clipboard');
      viewer.send(JSON.stringify({ type: 'copy' }));
      expect(await copied).toEqual({ type: 'clipboard', text: 'Click' });
      viewer.send(JSON.stringify({ type: 'handback' }));
      viewer.close();
      const answer = await agentWait;
      expect(answer).toMatchObject({ type: 'handoff' });
      expect(answer.events.map((event) => event.name)).toEqual(expect.arrayContaining(['viewer-opened', 'takeover', 'input', 'handback']));
      expect(answer.events.every((event) => Number.isFinite(Date.parse(event.at)))).toBe(true);
      expect((await getComputerSession(scope1.database, share.id))?.status).toBe('live');
      chrome.kill('SIGTERM');
      await new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
      await until(async () => (await getComputerSession(scope1.database, share.id))?.status === 'ended' ? true : undefined);
      const ended = await fetch(`${scope1.origin}/s/${share.id}?access=${access}`);
      expect(ended.status).toBe(410);
      expect((await fetch(`${scope1.origin}/s/${share.id}/last.jpg`)).status).toBe(404);
      existingDevtools.close();
    } finally {
      if (chrome && !spawnFailed && chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill('SIGTERM');
        await new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
      }
      if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);


  it('Reproduction SB-CENTER-1 and SB-ZOOM-1: opens centred, zooms from the whole page to 4x and stays centred', () => {
    const { viewerLayout, viewerZoomAt } = scope1.viewerLayoutMath;
    // A 1279x936 Squire page in a 900x700 desktop frame opens filling the
    // frame, with the overflow split evenly instead of pinned to the left.
    const opened = viewerLayout({ zoom: 1, left: 0, top: 0, fitted: false }, 900, 700, 1279, 936);
    expect(opened.height).toBeCloseTo(700);
    expect(opened.left).toBeCloseTo((900 - opened.width) / 2);
    expect(opened.top).toBe(0);
    // Zooming out stops at the whole page in view, centred horizontally and pinned to the top.
    const out = viewerLayout(viewerZoomAt(opened, 0.01, 450, 350), 900, 700, 1279, 936);
    expect(out.zoom).toBeCloseTo(opened.minZoom);
    expect(out.zoom).toBeLessThan(1);
    expect(out.width).toBeCloseTo(900);
    expect(out.height).toBeLessThan(700);
    expect(out.left).toBeCloseTo(0);
    expect(out.top).toBe(0);
    // Zooming in keeps the point under the cursor and stops at 4x.
    const inside = viewerLayout(viewerZoomAt(opened, 2, 300, 200), 900, 700, 1279, 936);
    expect((300 - inside.left) / inside.scale).toBeCloseTo((300 - opened.left) / opened.scale);
    expect(viewerLayout(viewerZoomAt(inside, 50, 300, 200), 900, 700, 1279, 936).zoom).toBe(4);
    // A narrower frame or a phone rotation keeps the page centred.
    const narrower = viewerLayout(opened, 760, 700, 1279, 936);
    expect(narrower.left).toBeCloseTo((760 - narrower.width) / 2);
    const phone = viewerLayout({ zoom: 1, left: 0, top: 0, fitted: false }, 390, 800, 1279, 936);
    expect(phone.left).toBeCloseTo((390 - phone.width) / 2);
    const rotated = viewerLayout(phone, 800, 390, 1279, 936);
    expect(rotated.left).toBeCloseTo((800 - rotated.width) / 2);
    // A new remote size opens centred again.
    const resized = viewerLayout({ ...inside }, 900, 700, 1600, 900);
    expect(resized.left).toBeCloseTo((900 - resized.width) / 2);
  });


  it('returns copied page text only to the controlling body viewer', async () => {
    const share = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'body-copy', upstreamUrl: 'body:', title: 'Body copy',
    });
    const source = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/source`);
    await opened(source);
    const toSource: Record<string, unknown>[] = [];
    source.on('message', (data) => toSource.push(JSON.parse(data.toString()) as Record<string, unknown>));
    const controller = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${await computerViewToken(scope1.database, share.id, HUMAN)}`);
    const watcher = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${await computerViewToken(scope1.database, share.id, OTHER)}`);
    await Promise.all([opened(controller), opened(watcher)]);
    const watched: string[] = [];
    watcher.on('message', (data) => watched.push(data.toString()));
    try {
      watcher.send(JSON.stringify({ type: 'copy' }));
      controller.send(JSON.stringify({ type: 'takeover' }));
      controller.send(JSON.stringify({ type: 'copy' }));
      await until(async () => toSource.some((message) => message.type === 'copy') ? true : undefined);
      expect(toSource.filter((message) => message.type === 'copy')).toHaveLength(1);
      const copied = nextType(controller, 'clipboard');
      source.send(JSON.stringify({ type: 'clipboard', text: 'selected words' }));
      expect(await copied).toEqual({ type: 'clipboard', text: 'selected words' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(watched.some((raw) => raw.includes('selected words'))).toBe(false);
    } finally {
      controller.close(); watcher.close(); source.close();
      await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, share.id))!);
    }
  });


  it.skipIf(!existsSync(scope1.chromeBinary))('Reproduction SB-PASTE-1 and SB-ZOOM-1: pastes the viewer clipboard and zooms on trackpad pinch in the Squire bridge', async () => {
    // The input handlers below follow Squire's live viewer page: it forwards
    // Ctrl/Cmd+letter as a key, pastes clipboard text and forwards wheels.
    // The page answers late, so the test must wait for the viewer canvas.
    const squire = createServer(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        html,body{margin:0;width:100%;height:100%}body{display:flex;flex-direction:column}#screen{flex:1;min-height:0}</style></head><body>
        <div id="bar"><span id="state"></span><button id="focus"></button></div>
        <div id="screen"><canvas id="canvas" tabindex="0" width="1279" height="936"></canvas></div>
        <input id="keyboard" type="text">
        <script>const canvas=document.getElementById('canvas');const socket = new WebSocket(new URL("stream", location.href));
        function send(message){if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));}
        function sendText(value){send({type:'text',text:value});}
        function point(event){const r=canvas.getBoundingClientRect();return {x:(event.clientX-r.left)/r.width,y:(event.clientY-r.top)/r.height};}
        canvas.addEventListener('pointerdown',event=>{event.preventDefault();canvas.focus();send({type:'pointer',phase:'down',...point(event)});});
        canvas.addEventListener('wheel',event=>{event.preventDefault();send({type:'wheel',delta_x:event.deltaX,delta_y:event.deltaY,...point(event)});},{passive:false});
        canvas.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey||event.altKey)&&/^[a-z]$/i.test(event.key)){
          event.preventDefault();send({type:'key',key:event.key,ctrl:event.ctrlKey,meta:event.metaKey});}});
        document.addEventListener('paste',event=>{if(document.activeElement!==canvas)return;const text=event.clipboardData?.getData('text/plain');
          if(text){event.preventDefault();sendText(text);}});</script></body>`);
    });
    const streams = new WebSocketServer({ noServer: true });
    const forwarded: Record<string, unknown>[] = [];
    squire.on('upgrade', (request, socket, head) => streams.handleUpgrade(request, socket, head, (client) => streams.emit('connection', client, request)));
    streams.on('connection', (socket) => socket.on('message', (data) => forwarded.push(JSON.parse(data.toString()) as Record<string, unknown>)));
    await new Promise<void>((resolve) => squire.listen(0, '127.0.0.1', resolve));
    const share = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'squire-paste',
      upstreamUrl: `http://127.0.0.1:${(squire.address() as AddressInfo).port}/s/${'p'.repeat(43)}/`,
    }, testSquire);
    const access = await computerViewToken(scope1.database, share.id, HUMAN);
    const profile = await mkdtemp(join(process.cwd(), '.paste-e2e-'));
    const chrome = spawn(scope1.chromeBinary, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, `${scope1.origin}/s/${share.id}/?access=${access}&embedded=1`,
    ], { stdio: 'ignore' });
    try {
      const port = await until(async () => {
        try {
          const found = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
          return found > 0 ? found : undefined;
        } catch { return undefined; }
      }, 15_000);
      const page = await until(async () => {
        try { return await findChromiumPage(`http://127.0.0.1:${port}`, share.id); } catch { return undefined; }
      });
      const socket = new WebSocket(page.webSocketDebuggerUrl!);
      await opened(socket);
      let serial = 0;
      const pending = new Map<number, (value: { result?: Record<string, unknown>; error?: unknown }) => void>();
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as { id?: number; result?: Record<string, unknown>; error?: unknown };
        if (message.id && pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); }
      });
      const command = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = ++serial;
        pending.set(id, (message) => message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result ?? {}));
        socket.send(JSON.stringify({ id, method, params }));
      });
      const evaluate = async <T>(expression: string) => {
        const reply = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }) as
          { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
        if (reply.exceptionDetails) throw new Error(`Page script failed: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
        return reply.result?.value as T;
      };
      type Box = { left: number; width: number; height: number; view: number; viewHeight: number };
      // Null until the viewer document has loaded and laid out its canvas.
      const layoutBox = () => evaluate<Box | null>(
        `(() => { const c = document.getElementById('canvas'), s = document.getElementById('screen');
          if (document.readyState !== 'complete' || !c || !s || !c.style.width) return null;
          const r = c.getBoundingClientRect();
          return { left: r.left, width: r.width, height: r.height, view: s.clientWidth, viewHeight: s.clientHeight }; })()`);
      const canvasBox = async () => {
        const box = await layoutBox();
        if (!box) throw new Error('Viewer canvas is not laid out');
        return box;
      };
      const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
        command('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
      await command('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
      await command('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
      // The document can still be navigating, so a failed read is retried
      // and reported only if the canvas never appears.
      let lastError: unknown;
      const start = await until(async () => {
        try { const box = await layoutBox(); return box && box.height === box.viewHeight ? box : undefined; }
        catch (error) { lastError = error; return undefined; }
      }, 30_000).catch((error: Error) => { throw lastError ? new Error(`${error.message}: ${String(lastError)}`) : error; });
      expect(start.left).toBeCloseTo((start.view - start.width) / 2, 0);
      // Headless Chrome reports pointer:none and ignores pointer emulation, so
      // desktop hiding is asserted from the served rule. A fine pointer still
      // matches @media(pointer:fine) and hides the bar; the keyboard rule does not.
      const keyboardRules = await evaluate<string>(`[...document.styleSheets].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join('\\n')`);
      expect(keyboardRules).toContain('@media (pointer: fine)');
      expect(keyboardRules).toContain('display: none !important');
      const keyboardBarRule = keyboardRules.split('\n').find((rule) => rule.includes('beeline-keyboard') && rule.includes('#bar'));
      expect(keyboardBarRule ?? '').not.toContain('display');
      // Trackpad pinch zooms in and back out to the whole page, centred, and
      // never reaches the remote page as a wheel.
      for (let index = 0; index < 4; index++) await mouse('mouseWheel', 450, 350, { deltaX: 0, deltaY: -60, modifiers: 2, button: 'none' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await canvasBox()).width).toBeGreaterThan(start.width);
      for (let index = 0; index < 30; index++) await mouse('mouseWheel', 450, 350, { deltaX: 0, deltaY: 120, modifiers: 2, button: 'none' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const zoomedOut = await canvasBox();
      expect(zoomedOut.width).toBeLessThanOrEqual(zoomedOut.view + 1);
      expect(zoomedOut.height).toBeLessThan(zoomedOut.viewHeight);
      expect(zoomedOut.left).toBeCloseTo((zoomedOut.view - zoomedOut.width) / 2, 0);
      expect(forwarded.filter((message) => message.type === 'wheel')).toHaveLength(0);
      // Ctrl+V pastes this device's clipboard as text, never the remote's.
      await mouse('mousePressed', 450, 300); await mouse('mouseReleased', 450, 300);
      const pasteShortcut = async () => {
        await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2, commands: ['paste'] });
        await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
      };
      // Reproduction SB-PASTE-2: with no text on this device's clipboard
      // (empty, or only an image) the shortcut sends nothing, so the remote
      // page cannot paste the remote machine's clipboard.
      await evaluate(`window.pastes = 0; document.addEventListener('paste', () => window.pastes++, true)`);
      await evaluate(`navigator.clipboard.writeText('')`);
      await pasteShortcut();
      await evaluate(`(async () => { const image = new OffscreenCanvas(2, 2); image.getContext('2d').fillRect(0, 0, 2, 2);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': await image.convertToBlob({ type: 'image/png' }) })]); })()`);
      expect(await evaluate<string>(`navigator.clipboard.read().then((items) => items.flatMap((item) => item.types).join())`)).toBe('image/png');
      await pasteShortcut();
      await until(async () => await evaluate<number>('window.pastes') === 2 ? true : undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(forwarded.filter((message) => message.type === 'key' || message.type === 'text')).toEqual([]);
      expect(await evaluate<string>('document.activeElement.id')).toBe('canvas');
      await evaluate(`navigator.clipboard.writeText('from the viewer clipboard')`);
      await pasteShortcut();
      await until(async () => forwarded.some((message) => message.type === 'text') ? true : undefined);
      expect(forwarded.filter((message) => message.type === 'text')).toEqual([{ type: 'text', text: 'from the viewer clipboard' }]);
      expect(forwarded.some((message) => message.type === 'key' && message.key === 'v')).toBe(false);
      // Focus returns to the page view, so other shortcuts still reach the remote.
      expect(await evaluate<string>('document.activeElement.id')).toBe('canvas');
      // The phone key bar posts a key into the page, which forwards it as Squire's key message.
      await evaluate(`window.postMessage({ type: 'viewer-key', id: '${share.id}', key: 'Escape' }, '*')`);
      await until(async () => forwarded.some((message) => message.type === 'key' && message.key === 'Escape') ? true : undefined);
      expect(forwarded.filter((message) => message.type === 'key')).toEqual([{ type: 'key', key: 'Escape', ctrl: false, meta: false }]);
      // Reproduction R1: a phone in control keeps the keyboard button on a
      // remote sign-in window. That window's own keyboard does not open the
      // phone keyboard. Reproduction R2: focusing the keyboard does not scroll
      // the page off the screen.
      await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 750, deviceScaleFactor: 1, mobile: true });
      await command('Emulation.setTouchEmulationEnabled', { enabled: true });
      expect(await evaluate<boolean>(`document.getElementById('beeline-paste') === null`)).toBe(true);
      await evaluate(`socket.dispatchEvent(new MessageEvent('message', {data:JSON.stringify({type:'navigation',url:'https://login.example/vnc.html'})}))`);
      expect(await evaluate<string>(`getComputedStyle(document.getElementById('bar')).display`)).not.toBe('none');
      const beforeFocus = await evaluate<{ x: number; y: number; top: number; bottom: number; view: number }>(`(() => { const box = document.getElementById('canvas').getBoundingClientRect(); return { x: scrollX, y: scrollY, top: box.top, bottom: box.bottom, view: innerHeight }; })()`);
      await evaluate(`document.getElementById('focus').click()`);
      const afterFocus = await evaluate<{ x: number; y: number; top: number; bottom: number; view: number; position: string; left: number }>(`(() => { const box = document.getElementById('canvas').getBoundingClientRect(); const key = getComputedStyle(document.getElementById('keyboard')); return { x: scrollX, y: scrollY, top: box.top, bottom: box.bottom, view: innerHeight, position: key.position, left: Number.parseFloat(key.left) }; })()`);
      expect(afterFocus.position).toBe('fixed');
      expect(afterFocus.left).toBe(0);
      expect(afterFocus.x).toBe(0);
      expect(afterFocus.y).toBe(0);
      expect(afterFocus.bottom).toBeGreaterThan(0);
      expect(afterFocus.top).toBeLessThan(afterFocus.view);
      expect(Math.abs(afterFocus.top - beforeFocus.top)).toBeLessThan(2);
      // The phone keyboard shrinks the visual viewport and leaves the layout
      // viewport tall. Squire's #screen{flex:1} then ignores a plain height.
      // Reproduce that split here and require the page and the button to fit.
      const installed = await evaluate<{ ok: boolean; reason?: string }>(`(() => {
        if (window.__beelineSetViewport) return { ok: true };
        const real = window.visualViewport;
        if (!real) return { ok: false, reason: 'missing visualViewport' };
        let next = null;
        const fake = {
          get height() { return next ? next.height : real.height; },
          get width() { return real.width; },
          get offsetTop() { return next ? next.offsetTop : real.offsetTop; },
          get offsetLeft() { return 0; },
          get pageTop() { return next ? next.offsetTop : real.pageTop; },
          get pageLeft() { return 0; },
          get scale() { return real.scale; },
          addEventListener: (...args) => real.addEventListener(...args),
          removeEventListener: (...args) => real.removeEventListener(...args),
          dispatchEvent: (event) => real.dispatchEvent(event),
        };
        try { Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake }); }
        catch (error) { return { ok: false, reason: String(error) }; }
        window.__beelineSetViewport = (height, offsetTop = 0) => {
          next = height == null ? null : { height, offsetTop };
          real.dispatchEvent(new Event('resize'));
        };
        return { ok: true };
      })()`);
      if (!installed.ok) throw new Error(`visualViewport stand-in unavailable: ${installed.reason}`);
      type KeyboardFit = {
        vvHeight: number; vvTop: number; innerHeight: number; innerWidth: number;
        screenHeight: number; flexGrow: string; flexInline: string;
        canvasTop: number; canvasBottom: number; canvasLeft: number; canvasRight: number;
        buttonTop: number; buttonBottom: number; buttonDisplay: string;
      };
      const keyboardFit = () => evaluate<KeyboardFit>(`(() => {
        const vv = window.visualViewport, screen = document.getElementById('screen');
        const canvas = document.getElementById('canvas').getBoundingClientRect();
        const button = document.getElementById('focus').getBoundingClientRect();
        return {
          vvHeight: vv.height, vvTop: vv.offsetTop, innerHeight, innerWidth,
          screenHeight: screen.getBoundingClientRect().height,
          flexGrow: getComputedStyle(screen).flexGrow, flexInline: screen.style.flex,
          canvasTop: canvas.top, canvasBottom: canvas.bottom, canvasLeft: canvas.left, canvasRight: canvas.right,
          buttonTop: button.top, buttonBottom: button.bottom,
          buttonDisplay: getComputedStyle(document.getElementById('bar')).display,
        };
      })()`);
      const openKeyboard = (inset: number) => evaluate(`window.__beelineSetViewport(Math.round(innerHeight - ${inset}), 0)`);
      const closeKeyboard = () => evaluate(`window.__beelineSetViewport(null)`);
      const expectPageInside = (box: KeyboardFit, label: string) => {
        const top = box.vvTop, bottom = box.vvTop + box.vvHeight;
        const field = box.canvasTop + (box.canvasBottom - box.canvasTop) * 0.92;
        expect(box.innerHeight - box.vvHeight, label).toBeGreaterThanOrEqual(80);
        expect(box.flexGrow, label).toBe('0');
        expect(Math.abs(box.screenHeight - box.vvHeight), label).toBeLessThanOrEqual(1);
        expect(box.canvasTop, label).toBeGreaterThanOrEqual(top - 1);
        expect(box.canvasBottom, label).toBeLessThanOrEqual(bottom + 1);
        expect(box.canvasLeft, label).toBeGreaterThanOrEqual(-1);
        expect(box.canvasRight, label).toBeLessThanOrEqual(box.innerWidth + 1);
        expect(box.buttonDisplay, label).not.toBe('none');
        expect(box.buttonTop, label).toBeGreaterThanOrEqual(top - 1);
        expect(box.buttonBottom, label).toBeLessThanOrEqual(bottom + 1);
        expect(field, label).toBeGreaterThanOrEqual(top - 1);
        expect(field, label).toBeLessThanOrEqual(bottom + 1);
      };
      await openKeyboard(327);
      const normalKeyboard = await keyboardFit();
      expectPageInside(normalKeyboard, 'normal remote page');
      await evaluate(`(() => { const canvas = document.getElementById('canvas'); canvas.width = 1280; canvas.height = 1600; })()`);
      await openKeyboard(327);
      const tallKeyboard = await keyboardFit();
      expectPageInside(tallKeyboard, 'taller remote page');
      await evaluate(`document.getElementById('bar').style.display = 'none'`);
      const watchOnly = await keyboardFit();
      expect(watchOnly.buttonDisplay).toBe('none');
      expect(Math.abs(watchOnly.screenHeight - watchOnly.vvHeight)).toBeLessThanOrEqual(1);
      await evaluate(`document.getElementById('bar').style.display = ''`);
      await closeKeyboard();
      const restored = await keyboardFit();
      expect(restored.flexGrow).toBe('1');
      expect(restored.flexInline).toBe('');
      expect(restored.innerHeight - restored.vvHeight).toBeLessThan(2);
      expect(restored.screenHeight).toBeGreaterThan(tallKeyboard.screenHeight + 100);
      expect(restored.buttonDisplay).not.toBe('none');
      expect(Math.abs(restored.buttonBottom - (restored.innerHeight - 12))).toBeLessThanOrEqual(2);
      await command('Emulation.setDeviceMetricsOverride', { width: 800, height: 390, deviceScaleFactor: 1, mobile: true });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await evaluate(`(() => { const canvas = document.getElementById('canvas'); canvas.width = 1279; canvas.height = 936; })()`);
      await openKeyboard(160);
      expectPageInside(await keyboardFit(), 'landscape phone');
      await closeKeyboard();
      const landscapeClosed = await keyboardFit();
      expect(landscapeClosed.flexGrow).toBe('1');
      expect(landscapeClosed.screenHeight).toBeGreaterThan(landscapeClosed.vvHeight * 0.8);
      await evaluate(`socket.dispatchEvent(new MessageEvent('message', {data:JSON.stringify({type:'navigation',url:'https://example.com/'})}))`);
      expect(await evaluate<string>(`getComputedStyle(document.getElementById('bar')).display`)).not.toBe('none');
      socket.close();
    } finally {
      if (chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill('SIGTERM');
        await new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
      }
      await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      for (const client of streams.clients) client.close();
      await new Promise<void>((resolve) => streams.close(() => resolve()));
      await new Promise<void>((resolve) => squire.close(() => resolve()));
      await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, share.id))!);
    }
  }, 120_000);


  it('locks the body viewer document so a native host cannot page-zoom it', () => {
    const html = computerViewerHtml('lock-id');
    expect(html).toContain('maximum-scale=1,user-scalable=no');
    expect(html).toContain('touch-action:none;overscroll-behavior:none');
  });


  it.skipIf(!existsSync(scope1.chromeBinary))('pinches, pans and maps a tap in the body-hosted viewer without forwarding the gesture', async () => {
    const share = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'body-pinch', upstreamUrl: 'body:', title: 'Body viewer',
    });
    const access = await computerViewToken(scope1.database, share.id, HUMAN);
    const source = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/source`);
    await opened(source);
    const forwarded: string[] = [];
    source.on('message', (data) => forwarded.push(data.toString()));
    source.send(JSON.stringify({ method: 'Page.screencastFrame',
      params: { data: '/9j/2Q==', sessionId: 1, metadata: { deviceWidth: 800, deviceHeight: 600 } } }));
    const inputCounts: Record<string, number> = {};
    try {
      const gesture = await scope1.gestureViewer(`${scope1.origin}/s/${share.id}?access=${access}&embedded=1`, {
        pinch: [{ x: 150, y: 400 }, { x: 250, y: 400 }],
        remote: { width: 800, height: 600 },
        onPhase: (name) => { inputCounts[name] = forwarded.filter(scope1.isForwardedInput).length; },
      });
      scope1.expectViewerGesture(gesture, forwarded, inputCounts);
    } finally {
      source.close();
      await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, share.id))!);
    }
  }, 120_000);


  it.skipIf(!existsSync(scope1.chromeBinary))('pinches and pans locally, then dispatches a phone tap through the Squire mouse path', async () => {
    const squire = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        html,body{margin:0;width:100%;height:100%}#screen{width:100vw;height:100vh}</style></head><body>
        <div id="bar"><button id="focus"></button></div>
        <div id="screen"><canvas id="canvas" width="0" height="0"></canvas></div>
        <script>// Reproduction viewer-flake-1: remote dimensions arrive after the old 1.5s sleep.
        setTimeout(() => {const c=document.getElementById('canvas');c.width=800;c.height=600;}, 3_000);
        const socket = new WebSocket(new URL("stream", location.href));
        function send(message){if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));}
        function point(event){const canvas=document.getElementById('canvas');const r=canvas.getBoundingClientRect();
          const scale=r.width/canvas.width;return {x:(event.clientX-r.left)/scale,y:(event.clientY-r.top)/scale};}</script></body>`);
    });
    const streams = new WebSocketServer({ noServer: true });
    const forwarded: string[] = [];
    squire.on('upgrade', (request, socket, head) => streams.handleUpgrade(request, socket, head, (client) => streams.emit('connection', client, request)));
    streams.on('connection', (socket) => socket.on('message', (data) => forwarded.push(data.toString())));
    await new Promise<void>((resolve) => squire.listen(0, '127.0.0.1', resolve));
    const share = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'squire-pinch',
      upstreamUrl: `http://127.0.0.1:${(squire.address() as AddressInfo).port}/s/${'s'.repeat(43)}/`,
    }, testSquire);
    const access = await computerViewToken(scope1.database, share.id, HUMAN);
    const inputCounts: Record<string, number> = {};
    try {
      const gesture = await scope1.gestureViewer(`${scope1.origin}/s/${share.id}/?access=${access}&embedded=1`, {
        pinch: [{ x: 150, y: 250 }, { x: 250, y: 250 }],
        onPhase: (name) => { inputCounts[name] = forwarded.filter(scope1.isForwardedInput).length; },
      });
      scope1.expectViewerGesture(gesture, forwarded, inputCounts);
      // Squire's touch path offsets input twice inside a cross-origin iframe.
      // A deliberate tap must use the same trusted mouse path as a desktop click.
      const input = forwarded.filter(scope1.isForwardedInput).map((raw) => JSON.parse(raw));
      expect(input).toEqual([
        { type: 'pointer', phase: 'down', button: 'left', x: expect.any(Number), y: expect.any(Number) },
        { type: 'pointer', phase: 'up', button: 'left', x: input[0]?.x, y: input[0]?.y },
      ]);
    } finally {
      for (const client of streams.clients) client.close();
      await new Promise<void>((resolve) => streams.close(() => resolve()));
      await new Promise<void>((resolve) => squire.close(() => resolve()));
      await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, share.id))!);
    }
  }, 120_000);
});
