// Release gate: a free agent in the review proof Workspace answers a real tag.
// The review identity owns "Play Review's team"; no owner Workspace is touched.
// The live socket delivers the reply or the turn's failure. There is no
// timer, poll or resend: the job's own timeout bounds the wait. A cancelled
// execution whose command is still pending is not an outcome: the server
// redelivers that owed command (2026-11-23: the first execution replied to an
// older identical tag, and the redelivered execution answered this one).
import { randomBytes } from 'node:crypto';

const origin = process.env.BEELINE_PROOF_ORIGIN ?? 'https://server.usebeeline.app';
const roomId = '79237f38-5214-47ef-b1ef-7bd8ad035d3a'; // Play Review's team #general
const agentId = 'bb35cda30e5bcda7bb15d78fe2def34ecc9e2a389f5c455fad8e657b2d0aa4a6';
const handle = 'beebee_26';
const secret = process.env.SERVER_CANARY_REVIEW_SECRET;
if (!secret) throw new Error('The free-agent reply proof requires SERVER_CANARY_REVIEW_SECRET');

const exchange = await fetch(`${origin}/v1/auth/review/exchange`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret }),
});
if (!exchange.ok) throw new Error(`Review access exchange failed with HTTP ${exchange.status}`);
const { accessToken } = await exchange.json();
if (typeof accessToken !== 'string' || !accessToken) throw new Error('Review access exchange returned no token');
const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
const messageId = randomBytes(32).toString('hex');
const sentAt = Date.now();

const outcome = await new Promise((resolve, reject) => {
  const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/v1/phone/live`, [`bearer.${accessToken}`]);
  let sent = false, settled = false, dirty = false, owed = false;
  let accepted, requestId, reading;
  const finish = (error, value) => {
    if (settled) return; settled = true; socket.close();
    if (error) reject(error); else resolve(value);
  };
  const judge = message => {
    if (message?.author?.pubkey !== agentId || message.requestId !== requestId) return;
    if (message.presentation === 'message' && message.text) finish(undefined, message.text);
    else if (message.presentation === 'system') finish(new Error(`Free agent turn failed: ${message.text}`));
  };
  // Every caller waits for a read that started after its call.
  const read = () => {
    dirty = true;
    return reading ??= (async () => {
      try {
        while (dirty && !settled) {
          dirty = false;
          const response = await fetch(`${origin}/v1/phone/rooms/${roomId}`, { headers });
          if (!response.ok) throw new Error(`Proof Room read failed with HTTP ${response.status}`);
          const room = await response.json();
          for (const message of room.messages ?? []) judge(message);
          owed = (room.pendingAgentCommands ?? []).some(command =>
            command.agentPubkey === agentId && command.requestId === requestId);
        }
      } catch (error) { finish(error); } finally { reading = undefined; }
    })();
  };
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'subscribe', roomId, roomStateProjections: true })));
  socket.addEventListener('message', async event => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === 'subscribed' && !sent) {
      sent = true;
      accepted = fetch(`${origin}/v1/phone/operations/sendRoomMessage`, {
        method: 'POST', headers,
        body: JSON.stringify({ roomId, messageId, text: `@${handle} Release proof: reply with one short sentence.` }),
      }).then(async response => {
        if (!response.ok) throw new Error(`Proof tag failed with HTTP ${response.status}: ${await response.text()}`);
        // Replies name the accepted agent command, not the human source message.
        const receipt = await response.json();
        requestId = receipt.pendingAgentCommands?.find(command => command.agentPubkey === agentId)?.requestId;
        if (!requestId) throw new Error('Proof tag accepted no command for the free agent');
      }).catch(finish);
      return;
    }
    if (frame.roomId !== roomId) return;
    // Committed live frames may beat the HTTP receipt carrying that command ID.
    await accepted;
    if (!sent || settled) return;
    if (frame.type === 'message-delta') judge(frame.message);
    else if (frame.type === 'turn-delta' && frame.turn?.agentPubkey === agentId && frame.turn.requestId === requestId &&
        (frame.turn.status === 'failed' || frame.turn.status === 'cancelled'))
      void read().then(() => {
        if (frame.turn.status === 'cancelled' && owed) return;
        finish(new Error(`Free agent turn ${frame.turn.status} without a reply`));
      });
    else if (frame.type === 'invalidate') void read();
  });
  socket.addEventListener('close', () => finish(new Error('Live connection closed before the free agent answered')));
  socket.addEventListener('error', () => finish(new Error('Live connection failed before the free agent answered')));
});
console.log(`@${handle} answered the release proof in ${Date.now() - sentAt} ms: ${outcome.slice(0, 200)}`);
