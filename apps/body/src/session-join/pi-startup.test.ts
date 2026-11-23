import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { fill, PI_EXTENSION } from './templates.js';

const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it.each(['before startup', 'during status'])('delivers Pi mail pending %s without another event', when => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-startup-'));
  folders.push(dir);
  const pending = join(dir, 'pending');
  if (when === 'before startup') writeFileSync(pending, 'startup mail');
  const hook = join(dir, 'hook.mjs');
  writeFileSync(hook, `import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
    const pending = ${JSON.stringify(pending)};
    if (process.argv.includes('status') && ${JSON.stringify(when)} === 'during status')
      writeFileSync(pending, 'startup mail');
    if (process.argv.includes('poll') && existsSync(pending)) {
      const text = readFileSync(pending, 'utf8'); unlinkSync(pending); process.stdout.write(text);
    }`);
  const extension = join(dir, 'beeline.ts');
  writeFileSync(extension, fill(PI_EXTENSION, process.execPath, hook));
  const driver = join(dir, 'driver.mjs');
  writeFileSync(driver, `import extension from ${JSON.stringify(extension)};
    const handlers = {}, messages = [];
    let received;
    const delivered = new Promise(done => { received = done; });
    extension({ on: (name, handler) => { handlers[name] = handler; },
      sendUserMessage: text => { messages.push(text); received(); } });
    await handlers.session_start({}, { sessionManager: { getSessionId: () => 'p1' }, cwd: ${JSON.stringify(dir)} });
    await delivered;
    await handlers.session_shutdown();
    console.log(JSON.stringify(messages));`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', driver], {
    env: { ...process.env, XDG_STATE_HOME: dir }, encoding: 'utf8', timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual(['startup mail']);
});
