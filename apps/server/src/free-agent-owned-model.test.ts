import { OwnedModelAttempts } from './owned-model-attempt.js';
import { settleAllowance } from './free-agent-accounting.js';
import { groupBPostgresDatabase } from './test-fixtures/test-support-router-group-b-postgres.js';
import { seedOwnedModelFixture, type OwnedModelFixture } from './test-fixtures/owned-model.js';
import { readOwnedModelReceipt } from '@beeline/api-contract/helper-model-receipt';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from './database.js';
import { DEFAULT_FREE_AGENT_LIMITS } from './free-agent-limits.js';
import { freeAgentModelTakesImages } from './free-agent-image-input.js';
import { handleFreeAgentModelRequest, type FreeAgentModelProxyOptions } from './free-agent-model-proxy.js';
import { MODEL, MODEL_AGENT, MODEL_ROOM, ownedModelFixture } from './test-fixtures/owned-model.js';

vi.mock('./free-agent-image-input.js', async original => ({
  ...await original<typeof import('./free-agent-image-input.js')>(), freeAgentModelTakesImages: vi.fn(async () => false),
}));
const ONE = '11111111-1111-4111-8111-111111111111', TWO = '22222222-2222-4222-8222-222222222222';
const input = { messages: [{ role: 'user', content: 'SYNTHETIC_PRIVATE_HISTORY' }], max_tokens: 8 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const success = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'SYNTHETIC_PRIVATE_ANSWER' } }],
  usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.00002 } });

describe('actual owned model endpoint and actual quota adapter', () => {
  let f: OwnedModelFixture<SqlDatabase>, closeDatabase:()=>Promise<void>, server: Server, origin: string, options: FreeAgentModelProxyOptions;
  let calls: { body: string; headers: Headers }[], reply: () => Response | Promise<Response>;
  beforeEach(async context => {
    vi.mocked(freeAgentModelTakesImages).mockClear();
    const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
    if(url&&/image input|large provider/.test(context.task.name)){
      const pg=await groupBPostgresDatabase(url);f=await seedOwnedModelFixture(pg.database,{installSchema:false});closeDatabase=pg.close;
    }else{const local=await ownedModelFixture();f=local;closeDatabase=()=>local.db.close();} calls = []; reply = success;
    options = { database: f.db, config: { model: 'unselected/default', dailyTokenCap: 100_000, firstDayTokenCap: 100_000, lifetimeTokenCap: 0 },
      upstreamKey: 'SYNTHETIC_SERVER_PROVIDER_KEY',
      ownedModel: { credentials: f.credentials, ready: () => true },
      fetchImpl: ((_url: string | URL | Request, init?: RequestInit) => {
        calls.push({ body: String(init?.body), headers: new Headers(init?.headers) }); return Promise.resolve(reply());
      }) as typeof fetch,
    };
    server = createServer((request, response) => {
      void handleFreeAgentModelRequest(request, response, new URL(request.url!, 'http://fixture').pathname, options).catch(() => response.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  },60000);
  afterEach(async () => { vi.useRealTimers(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await closeDatabase(); },60000);
  const call = (body: Record<string, unknown> = input, id = ONE, token?: string) => fetch(origin + '/v1/free-agents/model/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${token ?? f.issued.token}`, 'x-beeline-model-request': id,
      'content-type': 'application/json', 'x-beeline-command-generation': 'UNTRUSTED_CALLER_METADATA' }, body: JSON.stringify(body),
  });
  const counters = async () => ({
    usage: (await f.db.query('SELECT tokens,reservation_credit FROM free_agent_usage')).rows,
    budget: (await f.db.query('SELECT usd FROM free_agent_budget')).rows,
    rate: (await f.db.query('SELECT calls FROM free_agent_call_rate')).rows,
  });

  it('keeps the original claimed invocation usable after the former execution window', async () => {
    await f.db.query("UPDATE agent_commands SET created_at=clock_timestamp()-interval '2 hours'");
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SYNTHETIC_PRIVATE_ANSWER');
    expect(calls).toHaveLength(1);
    expect((await f.db.query('SELECT state FROM agent_commands')).rows).toEqual([{ state: 'claimed' }]);
  });

  it('sends N concurrent owner calls directly upstream while retaining the spend refusal', async () => {
    const release=deferred<void>();
    options.config.dailyTokenCap=1_000_000;options.config.firstDayTokenCap=1_000_000;
    const count=40;
    reply=async()=>{ await release.promise;return success(); };
    const pending=Array.from({length:count},(_,index)=>call({messages:[{role:'user',content:`Distinct authorized call ${index}`}],max_tokens:256},
      `11111111-1111-4111-8111-${String(index).padStart(12,'0')}`).catch(()=>new Response('{}',{status:599})));
    try {
      await vi.waitFor(()=>expect(calls).toHaveLength(count),{timeout:5000});
      expect(calls).toHaveLength(count);
    } finally { release.resolve();await Promise.allSettled(pending); }
    const results=await Promise.all(pending);
    for(const response of results){expect(response.status).toBe(200);await response.text();}
    options.config.dailyTokenCap=100;options.config.firstDayTokenCap=100;
    const refused=await call({messages:[{role:'user',content:'Fresh call after spend exhaustion'}]},TWO);
    expect(refused.status).toBe(403);expect(calls).toHaveLength(count);
  });

  it('reads the recorded result on the existing POST leaf without another paid provider request',async()=>{
    const response=await call();expect(response.status).toBe(200);await response.text();
    const recorded=await call();expect(recorded.status).toBe(409);
    const body=await recorded.json();expect(body.receipt.state).toBe('succeeded');
    expect(readOwnedModelReceipt(body.error.signedReceipt,f.issued.token,ONE)).toMatchObject({state:'succeeded'});
    expect(calls).toHaveLength(1);
    const removedRead=await fetch(origin+'/v1/free-agents/model/requests/'+ONE,{headers:{authorization:'Bearer '+f.issued.token}});
    expect(removedRead.status).toBe(404);await removedRead.text();
  });

  it('reads the invocation header supplied by the existing native Pi transport',async()=>{
    const response=await fetch(origin+'/v1/free-agents/model/chat/completions',{
      method:'POST',headers:{authorization:'Bearer bfm_native_provider_config',
        'x-beeline-model-invocation':f.issued.token,'x-beeline-model-request':ONE,'content-type':'application/json'},
      body:JSON.stringify(input),
    });
    expect(response.status).toBe(200);await response.text();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.has('x-beeline-model-invocation')).toBe(false);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer SYNTHETIC_SERVER_PROVIDER_KEY');
  });

  it('reconciles a lost provider reply inside the existing leaf from its recorded receipt',async()=>{
    reply=async()=>{
      const binding=f.credentials.actor(f.actor);
      await new OwnedModelAttempts(f.db,f.credentials).settleUsage(f.actor,ONE,{tokens:13,usd:0.00002},'succeeded',async(tx,reservation)=>{
        await settleAllowance(tx,binding.ownerId,binding.agentId,reservation.day,
          13-reservation.reserved,-reservation.credit,0.00002-reservation.reservedUsd,{modelRequestId:ONE});
      });
      throw new TypeError('synthetic lost provider reply after recorded completion');
    };
    const response=await call();expect(response.status).toBe(409);
    const body=await response.json();expect(body.receipt.state).toBe('succeeded');
    expect(readOwnedModelReceipt(body.error.signedReceipt,f.issued.token,ONE)).toMatchObject({state:'succeeded'});
    expect(calls).toHaveLength(1);
    expect(Number((await counters()).usage[0]?.tokens)).toBe(13);
  });
  it('rejects the retired agent-wide model token without selecting a different Room’s command',async()=>{
    const response=await call(input,ONE,'bfm_retired');expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({error:{code:'owned_model_required'}});expect(calls).toHaveLength(0);
  });

  it('pins actual command model, strips private identity headers, settles real quota once and replays outcome only', async () => {
    const first = await call({ ...input, model: 'attacker/model', models: ['attacker/fallback'], n: 5, provider: { order: ['attacker'] } });
    expect(first.status).toBe(200); expect(await first.text()).toContain('SYNTHETIC_PRIVATE_ANSWER'); expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body)).toEqual({ ...input, model: MODEL, usage: { include: true } });
    expect([...calls[0]!.headers.keys()].sort()).toEqual(['authorization', 'content-type', 'http-referer', 'x-title']);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer SYNTHETIC_SERVER_PROVIDER_KEY');
    expect(calls[0]!.body).not.toContain(f.issued.token); expect(freeAgentModelTakesImages).not.toHaveBeenCalled();
    expect((await counters()).usage.map(row => Number(row.tokens))).toEqual([13]);
    expect(Number((await counters()).budget[0]?.usd)).toBeCloseTo(0.00002);
    expect((await f.db.query(`SELECT kind FROM free_agent_events WHERE kind='model_usage'`)).rowCount).toBe(1);
    const before = await counters(), replay = await call(); expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ receipt: { requestId: ONE, state: 'succeeded', evidence: { kind: 'usage', tokens: 13 } } });
    expect(calls).toHaveLength(1); expect(await counters()).toEqual(before);
    const stored = JSON.stringify((await f.db.query('SELECT * FROM owned_model_attempts')).rows);
    for (const secret of ['SYNTHETIC_PRIVATE_HISTORY', 'SYNTHETIC_PRIVATE_ANSWER', 'SYNTHETIC_SERVER_PROVIDER_KEY', f.issued.token]) expect(stored).not.toContain(secret);
  });

  it('delivers an owned stream beyond the former window without spending preparation time', async () => {
    const originalNow = Date.now;
    let wall = originalNow();
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    options.config.limits = { ...DEFAULT_FREE_AGENT_LIMITS };
    let part = 0;
    const frames=[
      'data: '+JSON.stringify({choices:[{delta:{content:'AUTHORIZED_CHUNK'}}]})+'\n\n',
      'data: '+JSON.stringify({choices:[{delta:{content:'LATE_CHUNK'}}]})+'\n\n',
      'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:3,cost:0.00002}})+'\n\ndata: [DONE]\n\n',
    ];
    reply=()=>new Response(new ReadableStream({async pull(controller){
      if(part===1){
        wall+=2*60*60_000;
        // Advancing PGlite's clock must include the real source-renewal event.
        // Ownership remains live throughout execution; only elapsed execution limits are gone.
        await f.db.query('UPDATE live_server_instances SET renewed_at=clock_timestamp()');
      }
      if(part<frames.length) controller.enqueue(new TextEncoder().encode(frames[part++]));else controller.close();
    }},{highWaterMark:0}),{headers:{'content-type':'text/event-stream'}});
    let received = '';
    try {
      const response = await call({ ...input, stream: true });
      const reader = response.body!.getReader(), decoder = new TextDecoder();
      try { for (;;) { const next = await reader.read(); if (next.done) break; received += decoder.decode(next.value); } }
      catch { /* Expiry closes the stream before the provider's next frame. */ }
    } catch { /* The transport may observe the close before its first packet. */ }
    finally { vi.mocked(Date.now).mockRestore(); }
    expect(received).toContain('LATE_CHUNK');
    expect(calls).toHaveLength(1);
    expect((await f.db.query(`SELECT state FROM owned_model_attempts`)).rows).toEqual([{ state: 'succeeded' }]);
    expect(Number((await counters()).usage[0]?.tokens)).toBeGreaterThan(0);
  });

  it('retains actual allowance on lost transport and refuses same-ID and new-UUID retries without duplicate accounting', async () => {
    reply = () => Promise.reject(new Error('SYNTHETIC_PRIVATE_PROVIDER_FAILURE'));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const first = await call(); expect(first.status).toBe(409); expect(await first.json()).toMatchObject({ error: { code: 'owned_model_unknown' } });
    const before = await counters(); expect(Number(before.usage[0]?.tokens)).toBeGreaterThan(0);
    const replay = await call(); expect(await replay.json()).toMatchObject({ receipt: { state: 'unknown' } });
    const changedId = await call(input, TWO); expect(await changedId.json()).toMatchObject({ error: { code: 'owned_model_unknown' } });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000); vi.useRealTimers();
    expect(calls).toHaveLength(1); expect(await counters()).toEqual(before);
  });

  it.each([402, 429, 500])('makes one actual upstream attempt for HTTP%s without Retry-After resubmission', async status => {
    reply = () => Response.json({ error: { metadata: { reason: 'in_flight_budget_exhausted' } } }, { status, headers: { 'retry-after': '1' } });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const first = await call(); expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ receipt: { state: status === 500 ? 'unknown' : 'refused' } });
    if (status === 500) expect(Number((await counters()).usage[0]?.tokens)).toBeGreaterThan(0);
    else expect(Number((await counters()).usage[0]?.tokens)).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000); vi.useRealTimers(); expect(calls).toHaveLength(1);
  });

  it('uses the actual fetch transport once on a transient response and once on a lost response, without timer redispatch', async () => {
    let requests = 0, drop = false; const forwarded: { url: string | undefined; headers: IncomingHttpHeaders; body: string }[] = [];
    const upstream = createServer((request, response) => {
      let body = ''; request.on('data', chunk => { body += String(chunk); }); request.on('end', () => {
        requests++; forwarded.push({ url: request.url, headers: request.headers, body });
        if (drop) { response.destroy(); return; }
        response.writeHead(402, { 'content-type': 'application/json', 'retry-after': '1' });
        response.end(JSON.stringify({ error: { metadata: { reason: 'in_flight_budget_exhausted' } } }));
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    options.fetchImpl = undefined; options.upstreamBaseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
    try {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      const refused = await call(); expect(await refused.json()).toMatchObject({ receipt: { state: 'refused' } }); expect(requests).toBe(1);
      expect(forwarded[0]?.url).toBe('/v1/chat/completions'); expect(forwarded[0]?.headers.authorization).toBe('Bearer SYNTHETIC_SERVER_PROVIDER_KEY');
      expect(forwarded[0]?.headers['x-beeline-model-request']).toBeUndefined(); expect(forwarded[0]?.body).not.toContain(f.issued.token);
      drop = true; const unknown = await call(input, TWO); expect(await unknown.json()).toMatchObject({ receipt: { state: 'unknown' } });
      expect(requests).toBe(2); expect(Number((await counters()).usage[0]?.tokens)).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000); vi.useRealTimers(); expect(requests).toBe(2);
      const replay = await call(input, TWO); expect(await replay.json()).toMatchObject({ receipt: { state: 'unknown' } }); expect(requests).toBe(2);
    } finally { vi.useRealTimers(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
  });

  it('keeps a partial stream UNKNOWN with the original reservation even when usage arrives before the lost terminal delimiter', async () => {
    let next = 0; const encoder = new TextEncoder();
    reply = () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (!next++) controller.enqueue(encoder.encode('data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"cost":0.00001}}\n\n'));
      else controller.error(new Error('synthetic partial stream loss'));
    } }), { headers: { 'content-type': 'text/event-stream' } });
    const wire = { ...input, stream: true };
    await call(wire).then(response => response.text()).catch(() => {});
    expect((await f.db.query('SELECT state,evidence FROM owned_model_attempts')).rows).toEqual([
      { state: 'unknown', evidence: null },
    ]);
    expect(Number((await counters()).usage[0]?.tokens)).toBeGreaterThan(5);
    expect((await f.db.query(`SELECT kind FROM free_agent_events WHERE kind='model_usage'`)).rowCount).toBe(0);
    const before = await counters(); const replay = await call(wire); expect(await replay.json()).toMatchObject({ receipt: { state: 'unknown' } });
    expect(await counters()).toEqual(before); expect(calls).toHaveLength(1);
  });

  it('keeps the conservative reservation when a complete answer has no valid usage', async () => {
    reply = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'synthetic answer without billing evidence' } }] });
    await call().then(response=>response.text()).catch(()=>{});
    expect((await f.db.query('SELECT state,evidence FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown', evidence: null }]);
    expect(Number((await counters()).usage[0]?.tokens)).toBeGreaterThan(0);
    expect((await f.db.query(`SELECT kind FROM free_agent_events WHERE kind='model_usage'`)).rowCount).toBe(0);
  });

  it('withholds SDK terminal evidence until the actual settlement transaction commits and strips every upstream ID', async () => {
    const entered=deferred<void>(), release=deferred<void>();
    options.database={query:(sql,args)=>f.db.query(sql,args),transaction:work=>f.db.transaction(tx=>work({
      transaction:nested=>tx.transaction(nested),query:async(sql,args)=>{
        const result=await tx.query(sql,args);
        if(sql.includes('UPDATE owned_model_attempts SET')){entered.resolve();await release.promise;}
        return result;
      },
    }))};
    reply=()=>new Response('data: {"id":"forged-first","choices":[{"delta":{"content":"synthetic"},"finish_reason":null}]}\n\n'+
      'data: {"id":"forged-last","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"cost":0.00002}}\n\n'+
      'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    const response=await call({...input,stream:true}),reader=response.body!.getReader();
    try{
      const first=await reader.read();const before=new TextDecoder().decode(first.value);await entered.promise;
      expect(before).not.toContain('forged');expect(before).not.toContain('bfmr_');expect(before).not.toContain('[DONE]');
      release.resolve();let tail='';for(;;){const next=await reader.read();if(next.done)break;tail+=new TextDecoder().decode(next.value);}
      const frames=tail.split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)));
      const receipt=frames.find(frame=>frame.id)?.id;
      expect(readOwnedModelReceipt(receipt,f.issued.token,ONE)).toMatchObject({requestId:ONE,state:'succeeded',evidence:{kind:'usage',tokens:13}});
      expect(readOwnedModelReceipt(receipt,f.issued.token,TWO)).toBeNull();expect(tail).toContain('[DONE]');
    }finally{release.resolve();reader.releaseLock();}
  });

  it.each(['missing-done','settlement-failure'])('emits no terminal receipt for %s even after a provider finish',async mode=>{
    if(mode==='settlement-failure')options.database={query:(sql,args)=>f.db.query(sql,args),transaction:work=>f.db.transaction(tx=>work({
      transaction:nested=>tx.transaction(nested),query:(sql,args)=>sql.includes('UPDATE owned_model_attempts SET')?
        Promise.reject(new Error('synthetic settlement rollback')):tx.query(sql,args),
    }))};
    reply=()=>new Response('data: {"id":"forged","choices":[{"delta":{"content":"synthetic"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"cost":0.00002}}\n\n'+
      (mode==='missing-done'?'':'data: [DONE]\n\n'),{headers:{'content-type':'text/event-stream'}});
    let observed='';await call({...input,stream:true}).then(async response=>{const reader=response.body!.getReader();
      try{for(;;){const next=await reader.read();if(next.done)break;observed+=new TextDecoder().decode(next.value);}}finally{reader.releaseLock();}
    }).catch(()=>{});
    expect(observed).not.toContain('bfmr_');expect(observed).not.toContain('[DONE]');expect(observed).not.toContain('forged');
    expect((await f.db.query('SELECT state,evidence FROM owned_model_attempts')).rows).toEqual([{state:'unknown',evidence:null}]);
    expect(calls).toHaveLength(1);
  });

  it('settles a large provider event without a 256 KiB refusal or losing terminal receipt evidence',async()=>{
    const content='large provider output '.repeat(30_000);
    reply=()=>new Response('data: '+JSON.stringify({id:'untrusted-provider',choices:[{index:0,delta:{content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:3,cost:0.00002}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    const response=await call({...input,stream:true}),text=await response.text();
    expect(response.status).toBe(200);expect(text).toContain(content);expect(text).not.toContain('untrusted-provider');expect(text).toContain('bfmr_v1.');expect(text).toContain('[DONE]');
    expect((await f.db.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{state:'succeeded'}]);expect(calls).toHaveLength(1);
  });
  it('allows image input by default without extra model metadata admission', async () => {
    options.config = {...options.config,dailyTokenCap:1_000_000,firstDayTokenCap:1_000_000};
    const image = await call({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://synthetic.invalid/image.png' } }] }] });
    expect(image.status).toBe(200); await image.text(); expect(calls).toHaveLength(1);
    expect(freeAgentModelTakesImages).not.toHaveBeenCalled(); expect((await counters()).usage).toHaveLength(1);
  });

  it('rolls actual token/budget/rate reservation back when the attempt insert cannot commit', async () => {
    const wrap = (tx: SqlDatabase): SqlDatabase => ({ transaction: work => tx.transaction(inner => work(wrap(inner))), query: (sql, values) => {
      if (sql.includes('INSERT INTO owned_model_attempts(')) return Promise.reject(new Error('synthetic attempt insert failure'));
      return tx.query(sql, values);
    } });
    options.database = { query: (sql, values) => f.db.query(sql, values), transaction: work => f.db.transaction(tx => work(wrap(tx))) };
    const response = await call(); expect(response.status).toBe(503); await response.text(); expect(calls).toHaveLength(0);
    expect(await counters()).toEqual({ usage: [], budget: [], rate: [] });
    expect((await f.db.query('SELECT * FROM owned_model_attempts')).rowCount).toBe(0);
  });

  it('stops on the first chunk after authorization is revoked, without a timer', async () => {
    reply = () => new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        await f.db.query('UPDATE owned_model_credentials SET revoked_at=clock_timestamp()');
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"EXPIRED_PRIVATE_CHUNK"}}]}\n\n'));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
    let received = '';
    try { const response = await call({ ...input, stream: true }); received = await response.text(); } catch {}
    expect(received).not.toContain('EXPIRED_PRIVATE_CHUNK');
    expect(calls).toHaveLength(1);
    expect((await f.db.query('SELECT state FROM owned_model_attempts WHERE model_request_id=$1', [ONE])).rows[0]).toEqual({ state: 'unknown' });
  });

  it('refuses default-off and every malformed owned namespace before legacy lookup or model metadata work', async () => {
    const queries: string[] = [], base = options.database;
    options.database = { query: (sql, values) => { queries.push(sql); return base.query(sql, values); }, transaction: work => base.transaction(work) };
    options.ownedModel = { credentials: f.credentials, ready: () => false };
    const disabled = await call(); expect(disabled.status).toBe(401); await disabled.text(); expect(queries).toEqual([]);
    options.ownedModel = { credentials: f.credentials, ready: () => true };
    for (const token of ['bfmc_v1.invalid', f.issued.token.replace('bfmc_v1.', 'bfmc_v2.'), 'bfmc_bfm_legacy']) {
      const invalid = await call(input, ONE, token); expect(invalid.status).toBe(401); await invalid.text();
    }
    expect(queries).toEqual([]); expect(calls).toHaveLength(0); expect(freeAgentModelTakesImages).not.toHaveBeenCalled();
  });

  it('rechecks current token rotation after authentication before quota or provider work', async () => {
    const authenticated = deferred<void>(), release = deferred<void>(); let pause = true;
    options.database = { transaction: work => f.db.transaction(work), query: async (sql, values) => {
      const result = await f.db.query(sql, values);
      if (pause && sql.startsWith('SELECT command.agent_id')) { pause = false; authenticated.resolve(); await release.promise; }
      return result;
    } };
    const pending = call(); await authenticated.promise;
    await f.db.query('UPDATE free_agents SET model_token_hash=$2 WHERE agent_id=$1', [MODEL_AGENT, 'd'.repeat(64)]);
    release.resolve(); const response = await pending; expect(response.status).toBe(403); await response.text();
    expect(calls).toHaveLength(0); expect(await counters()).toEqual({ usage: [], budget: [], rate: [] });
    expect(freeAgentModelTakesImages).not.toHaveBeenCalled();
  });
});
