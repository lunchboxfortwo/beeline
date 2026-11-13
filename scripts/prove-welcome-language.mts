import { writeFile } from 'node:fs/promises';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { FreeAgentService } from '../apps/server/dist/free-agents.js';
import { StarterOnboardingService } from '../apps/server/dist/starter-onboarding-run.js';
const db = new PgliteDatabase();
await migrate(db);
const phone = new PhoneService(db, 'http://proof.invalid');
phone.setFreeAgents(new FreeAgentService(db, { model: 'proof', idleSeconds: 60, maxPerOwner: 3, dailyTokenCap: 1000000, firstDayTokenCap: 1000000, lifetimeTokenCap: 3000000, sealSecret: 'isolated-proof-secret', publicOrigin: 'http://proof.invalid', image: 'proof', region: 'iad', cpus: 1, memoryMb: 1024, reapIdleMs: 300000, deleteAfterMs: 86400000 }, {} as never, async () => { throw new Error('No real Machine in proof'); }, () => undefined));
const results = [];
for (const [index, locale, firstMessage, greeting] of [
  [1, 'en-US', '', 'Hi Charles'], [2, 'es-MX', '', 'Hola Charles'],
  [3, 'en-US', '안녕하세요, 한국어로 이야기해 주세요', '안녕하세요 Charles'],
  [4, 'invalid_locale', 'OK', 'Hi Charles'],
  [5, 'en-US', 'Can you translate hola for me?', 'Hi Charles'],
  [6, 'en-US', 'Olá!', 'Olá Charles'],
  [7, 'en-US', '¿Podemos hablar en español?', 'Hola Charles'],
] as const) {
  const user = String(index).repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Charles',$2)`, [user, `proof${index}`]);
  const workspace = await phone.execute('createWorkspace', { name: 'Language welcome', locale }, user);
  if (firstMessage) await phone.execute('sendRoomMessage', { roomId: workspace.roomId!, text: firstMessage }, user);
  await new StarterOnboardingService(db).enter(workspace.roomId!, user);
  const room = await phone.readRoom(workspace.roomId!, user);
  const welcome = room!.messages.find(message => message.text.startsWith(greeting));
  if (!welcome) throw new Error(`Wrong welcome for ${locale}: ${JSON.stringify(room!.messages.map(m => m.text))}`);
  results.push({ locale, firstMessage, text: welcome.text, passed: true });
}
await writeFile(new URL('../.beeline-proof/welcome-language/result.json', import.meta.url), JSON.stringify({ reproduction: 'WELCOME-LANGUAGE-1', target: 'built PhoneService createWorkspace → starter playback → readRoom', standIn: 'Isolated PGlite and local agent provisioning; no production signups or Fly machines.', results }, null, 2));
await db.close();
console.log('WELCOME-LANGUAGE-1: built Room welcomes pass');
