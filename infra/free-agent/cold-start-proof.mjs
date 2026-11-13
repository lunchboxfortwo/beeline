import { createInterface } from 'node:readline';
// Disposable local proof: real server, fresh Workspace, real image and Pi;
// Docker stands in for Fly, and an immediate local reply stands in for the model.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import pg from 'pg';
import WebSocket from 'ws';

const image = process.env.PROOF_IMAGE ?? 'beeline-cold-start-proof';
const flyApp=process.env.PROOF_FLY_APP;
if(flyApp&&!flyApp.startsWith('beeline-lifecycle-lab-lb-'))throw new Error('A separately created disposable Fly app is required');
let flyToken;
if(flyApp){
  const input=createInterface({input:process.stdin});
  flyToken=await new Promise(resolve=>input.once('line',resolve));input.close();
}
const flyMachines=new Set();
let machinesProxy;
async function fly(path,method='GET',body){
  const response=await fetch(`https://api.machines.dev/v1/apps/${flyApp}/machines${path}`,{
    method,headers:{authorization:`Bearer ${flyToken}`,'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  if(!response.ok)throw new Error(`Disposable Fly ${method} ${path}: HTTP ${response.status}`);
  const text=await response.text();const result=text?JSON.parse(text):{};
  if(method==='POST'&&path==='')flyMachines.add(result.id);
  if(method==='DELETE')flyMachines.delete(path.split('?')[0].slice(1));
  return result;
}
const prefix = `jellybean-cold-${Date.now()}`;
const directory = `.scratch/${prefix}`;
await mkdir(directory,{recursive:true});
const children = [];
const timeline = [];
const note = (step) => {
  const event = { at: new Date().toISOString(), step };
  timeline.push(event);
  console.log(JSON.stringify(event));
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
let db;
let model;
let modelAt;
let socket;
function launch(args, env, label) {
  const child = spawn(process.execPath, args, {
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const collect = (chunk) => {
    log += chunk;
    appendFileSync(`${directory}/${label}.log`, chunk);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  children.push({ child, label, log: () => log });
  return child;
}
async function waitFor(check, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(100);
  }
  throw new Error('proof deadline exceeded');
}
try {
  docker(
    'run',
    '-d',
    '--name',
    `${prefix}-pg`,
    '--memory',
    '512m',
    '-e',
    'POSTGRES_PASSWORD=proof',
    '-p',
    '127.0.0.1::5432',
    'pgvector/pgvector:pg17',
  );
  const binding = docker('port', `${prefix}-pg`, '5432/tcp');
  const databaseUrl = `postgres://postgres:proof@${binding}/postgres`;
  await waitFor(async () => {
    try {
      docker('exec', `${prefix}-pg`, 'pg_isready', '-U', 'postgres');
      return true;
    } catch {
      return false;
    }
  });
  const migration = launch(
    ['apps/server/dist/index.js', '--migrate'],
    { MIGRATION_DATABASE_URL: databaseUrl },
    'migration',
  );
  await new Promise((resolve, reject) =>
    migration.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('migration failed')),
    ),
  );
  db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  model = createServer(async (req, res) => {
    for await (const _ of req) {
      /* Consume the bounded local prompt. */
    }
    modelAt ??= Date.now();
    note('first-model-call');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = {
      id: 'proof',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'deepseek/deepseek-v4.1-flash-1017',
    };
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Cold start proof reply.' }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  // Allocate two loopback ports, then release them for the child services.
  const ports = [];
  for (let i = 0; i < 3; i++) {
    const socket = createServer();
    await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
    ports.push(socket.address().port);
    await new Promise((resolve) => socket.close(resolve));
  }
  const [serverPort, machinesPort, peerPort] = ports;
  const origin = `http://127.0.0.1:${serverPort}`;
  let publicOrigin=origin;
  if(flyApp){
    const tunnel=spawn('cloudflared',['tunnel','--url',origin,'--no-autoupdate'],{stdio:['ignore','pipe','pipe']});
    let output='';tunnel.stdout.on('data',chunk=>{output+=chunk;});tunnel.stderr.on('data',chunk=>{output+=chunk;});
    children.push({child:tunnel,label:'tunnel',log:()=>output});
    publicOrigin=await waitFor(()=>output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0]);
  }
  const authTenantsJson = JSON.stringify([
    { host: new URL(origin).host, community: 'proof', roomCommunityIds: ['proof'], origin },
    ...(flyApp?[{host:new URL(publicOrigin).host,community:'proof',roomCommunityIds:['proof'],origin:publicOrigin}]:[]),
  ]);
  if(!flyApp) launch(['scripts/free-agent-docker-machines.mjs',String(machinesPort),prefix],{},'machines');
  else {
    machinesProxy=createServer(async(req,res)=>{
      try{
        const path=req.url.split('/machines')[1]??'';const chunks=[];
        for await(const chunk of req)chunks.push(chunk);
        let body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;
        if(req.method==='POST'&&path==='')body.config.init={exec:['/bin/sh','-c','/bin/sh /opt/beeline/entrypoint.sh > /tmp/lifecycle-helper.log 2>&1']};
        const result=await fly(path,req.method,body);
        if(req.method!=='GET'||path.includes('/wait'))note(`Fly ${req.method} ${path.split('?')[0]} state=${result.state??'accepted'} version=${result.instance_id??''}`);
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
      }catch(error){res.writeHead(502);res.end(String(error));}
    });
    await new Promise(resolve=>machinesProxy.listen(machinesPort,'127.0.0.1',resolve));
  }
  const serverEnv = {
      DATABASE_URL: databaseUrl,
      PORT: String(serverPort),
      PUBLIC_ORIGIN: publicOrigin,
      BEELINE_AUTH_TENANTS_JSON: authTenantsJson,
      BEELINE_AUTH_OIDC_ISSUER: 'https://accounts.example',
      BEELINE_AUTH_OIDC_AUTHORIZATION_ENDPOINT: 'https://accounts.example/authorize',
      BEELINE_AUTH_OIDC_TOKEN_ENDPOINT: 'https://accounts.example/token',
      BEELINE_AUTH_OIDC_JWKS_URI: 'https://accounts.example/jwks',
      BEELINE_AUTH_OIDC_CLIENT_ID: 'proof',
      BEELINE_FREE_AGENT_SEAL_KEY: randomBytes(32).toString('hex'),
      FLY_FREE_AGENT_IMAGE: image,
      FLY_FREE_AGENT_API_TOKEN: 'local-proof',
      FLY_FREE_AGENT_API_ORIGIN: `http://127.0.0.1:${machinesPort}`,
      BEELINE_FREE_AGENT_MODEL_KEY: 'local-proof',
      BEELINE_FREE_AGENT_MODEL_UPSTREAM: `http://127.0.0.1:${model.address().port}/v1`,
    };
  launch(['apps/server/dist/index.js'],serverEnv,'server');
  launch(['apps/server/dist/index.js'],{...serverEnv,PORT:String(peerPort)},'peer');
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/health`)).ok;
    } catch {
      return false;
    }
  });
  const person = randomBytes(32).toString('hex');
  const token = `bpt_${randomBytes(32).toString('base64url')}`;
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Cold proof','coldproof')`,
    [person],
  );
  await db.query(
    `INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at) VALUES($1,$2,gen_random_uuid(),now()+interval '1 hour')`,
    [createHash('sha256').update(token).digest('hex'), person],
  );
  const operation = async (name, input) => {
    const response = await fetch(`${origin}/v1/phone/operations/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  const workspace = await operation('createWorkspace', { name: 'Disposable cold-start proof' });
  const agent = (
    await db.query(
      `SELECT f.agent_id,i.handle FROM free_agents f JOIN memberships workspace_member ON workspace_member.identity_id=f.agent_id AND workspace_member.room_id IS NULL JOIN identities i ON i.id=f.agent_id WHERE workspace_member.workspace_id=$1`,
      [workspace.id],
    )
  ).rows[0];
  const messageId = randomBytes(32).toString('hex');
  let subscribed = false;
  let pushedAt;
  socket = new WebSocket(`${origin.replace('http:', 'ws:')}/v1/phone/live`, [`bearer.${token}`]);
  socket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === 'subscribed') subscribed = true;
    if (
      frame.type === 'room-commands' &&
      frame.commands?.some(command=>command.requestId===messageId)
    )
      pushedAt ??= Date.now();
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ type: 'subscribe', roomId: workspace.roomId, roomStateProjections:true }));
  await waitFor(() => subscribed, 5000);
  modelAt=undefined;
  const mentionedAt = Date.now();
  note('mention');
  await operation('sendRoomMessage', {
    roomId: workspace.roomId,
    messageId,
    text: `@${agent.handle} Reply hello.`,
  });
  const view = await (
    await fetch(`${origin}/v1/phone/rooms/${workspace.roomId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();
  if (
    !view.pendingAgentCommands?.some(command=>command.requestId===messageId)
  )
    throw new Error('indicator missing from phone read before helper pickup');
  await waitFor(() => pushedAt, 3000);
  const indicatorMs = pushedAt - mentionedAt;
  note(`phone-live indicator ${indicatorMs}ms`);
  const reply = await waitFor(
    async () =>
      (
        await db.query(
          `SELECT text FROM messages WHERE room_id=$1 AND author_id=$2 AND presentation='message' AND text='Cold start proof reply.' AND created_at>to_timestamp($3/1000.0) ORDER BY created_at LIMIT 1`,
          [workspace.roomId, agent.agent_id, mentionedAt],
        )
      ).rows[0],
  );
  const replyMs = Date.now() - mentionedAt;
  note(`reply ${replyMs}ms`);
  const machineId=(await db.query('SELECT fly_machine_id FROM free_agents WHERE agent_id=$1',[agent.agent_id])).rows[0].fly_machine_id;
  if(!flyApp&&!machineId.startsWith(prefix))throw new Error('Expected an isolated fixture machine');
  const machineState=async()=>flyApp?(await fly(`/${machineId}`)).state:docker('inspect','-f','{{.State.Status}}',machineId)==='paused'?'suspended':'other';
  const idle=()=>waitFor(async()=>await machineState()==='suspended' &&
    (await db.query('SELECT runtime_owner FROM free_agents WHERE agent_id=$1',[agent.agent_id])).rows[0].runtime_owner===null);
  await idle();
  if(!flyApp){
    docker('unpause',machineId);
    docker('exec',machineId,'sh','-c',"mkdir -p /root/.local/bin /root/.local/lib/beeline-releases/stale/bin; printf '#!/bin/sh\\nexit 99\\n' > /root/.local/bin/beeline; chmod +x /root/.local/bin/beeline; ln -sfn beeline-releases/stale /root/.local/lib/beeline; echo fixture-files-survive > /root/lifecycle-proof-file");
  }
  const cycle=async(label,oldImage=false,concurrent=false)=>{
    if(flyApp){
      const before=await fly(`/${machineId}`);
      await fly(`/${machineId}/stop`,'POST',{});
      await fly(`/${machineId}/wait?state=stopped&timeout=60&instance_id=${before.instance_id}`);
    }else{
      if(docker('inspect','-f','{{.State.Status}}',machineId)==='paused')docker('unpause',machineId);
      docker('stop','-t','5',machineId);
    }
    if(oldImage){
      const previousImage=flyApp?process.env.PROOF_PREVIOUS_IMAGE:`${image}-previous`;
      if(!previousImage)throw new Error('PROOF_PREVIOUS_IMAGE is required for Fly replacement');
      if(!flyApp)docker('tag',image,previousImage);
      const path=`http://127.0.0.1:${machinesPort}/v1/apps/lab/machines/${machineId}`;
      const before=await(await fetch(path)).json();
      const updated=await(await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({current_version:before.instance_id,skip_launch:false,config:{...before.config,image:previousImage}})})).json();
      if(flyApp){
        await fly(`/${machineId}/wait?state=stopped&timeout=60&instance_id=${updated.instance_id}`);
        updated.state=(await fly(`/${machineId}`)).state;
      }
      if(updated.state!=='stopped')throw new Error('Fixture image update did not preserve stopped');
    }
    const requestId=randomBytes(32).toString('hex');note(label);
    await Promise.all([operation('sendRoomMessage',{roomId:workspace.roomId,messageId:requestId,text:`@${agent.handle} Reply hello for ${label}.`}),
      ...(concurrent?[db.query("SELECT pg_notify('beeline_live_v1',$1)",[JSON.stringify({table:'free_agents',operation:'RELEASE',roomId:''})])]:[])]);
    await waitFor(async()=> (await db.query("SELECT 1 FROM agent_commands WHERE source_message_id=$1 AND state='complete'",[requestId])).rowCount);
    if(!(await db.query("SELECT 1 FROM messages WHERE room_id=$1 AND author_id=$2 AND created_at>=(SELECT created_at FROM messages WHERE id=$3) AND presentation='message' AND text='Cold start proof reply.' AND id<>$3",[workspace.roomId,agent.agent_id,requestId])).rowCount)throw new Error('No answer for '+label);
    if(!flyApp){
      docker('cp',`${machineId}:/root/lifecycle-proof-file`,`${directory}/persisted-file`);
      if((await readFile(`${directory}/persisted-file`,'utf8')).trim()!=='fixture-files-survive')throw new Error('Lost persistent files');
    }
    await idle();note(label+' answered');
  };
  await cycle('stopped-current-image');
  await cycle('image-update-while-stopped',true);
  await cycle('concurrent-command-release',false,true);
  const paid=(await db.query('SELECT count(*) FROM owned_model_attempts')).rows[0].count;
  if(Number(paid)!==4)throw new Error(`Expected one paid-attempt receipt per command; got ${paid}`);
  note('four commands answered with four paid-attempt receipts');
  await writeFile(
    `${directory}/result.json`,
    JSON.stringify(
      {
        reproduction: 'cold-beebee-first-reply',
        standIn: flyApp?'Disposable Fly app, deterministic local model':'Docker Machines with persistent HOME, deterministic local model',
        flyApp,
        workspaceId: workspace.id,
        roomId: workspace.roomId,
        image,
        helperSourceSha:(await db.query("SELECT body->>'sourceSha' sha FROM live_outputs WHERE agent_id=$1 AND kind='presence'",[agent.agent_id])).rows[0]?.sha,
        indicatorMs,
        firstModelMs: modelAt - mentionedAt,
        replyMs,
        reply: reply.text,
        timeline,
        paidAttempts:Number(paid),
        twoServerProcesses:true,
      },
      null,
      2,
    ),
  );
  if (indicatorMs > 3000) throw new Error('pending command was not projected promptly');
} finally {
  socket?.terminate();
  await db?.end();
  db=undefined;
  for (const { child, label, log } of children) {
    child.kill('SIGTERM');
    await writeFile(`${directory}/${label}.log`, log());
  }
  const containers = docker('ps', '-a', '--filter', `name=${prefix}`, '--format', '{{.Names}}')
    .split('\n')
    .filter(Boolean);
  for (const name of containers) {
    if (!name.endsWith('-pg')) {
      try {
        await writeFile(`${directory}/${name}.log`, docker('logs', '--timestamps', name));
      } catch {}
    }
    docker('rm', '-f', name);
    if(!name.endsWith('-pg'))docker('volume','rm',`${name}-home`);
  }
  if(flyApp)for(const id of flyMachines)await fly(`/${id}?force=true`,'DELETE');
  machinesProxy?.closeAllConnections();machinesProxy?.close();
  await db?.end();
  model?.closeAllConnections();
  model?.close();
  console.log(`proof artifacts: ${directory}`);
}
