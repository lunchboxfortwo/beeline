#!/usr/bin/env node
// Local stand-in for the Fly Machines API calls free agents make
// (`apps/server/src/fly-machines.ts`), backed by Docker containers on this
// host. For proofs only: point the server at it with
// FLY_FREE_AGENT_API_ORIGIN=http://127.0.0.1:<port>.
//   node scripts/free-agent-docker-machines.mjs <port> [container-prefix]
// suspend = docker pause, stop = docker stop, start resumes either.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4280);
const prefix = process.argv[3] ?? 'free-agent-proof';
let next = 0;
const configs = new Map();
const versions = new Map();

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function state(id) {
  try {
    const status = docker('inspect', '-f', '{{.State.Status}}', id);
    return status === 'running' ? 'started' : status === 'paused' ? 'suspended' : 'stopped';
  } catch {
    return undefined;
  }
}

function log(line) {
  console.log(`${new Date().toISOString()} [machines] ${line}`);
}

createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const url = new URL(request.url, 'http://local');
  const match = /^\/v1\/apps\/[^/]+\/machines(?:\/([^/]+))?(?:\/(start|suspend|stop|wait))?$/.exec(url.pathname);
  const send = (status, value) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  if (!match) return send(404, { error: 'not found' });
  const [, id, action] = match;
  try {
    if (!id && request.method === 'POST') {
      const machine = `${prefix}-${Date.now().toString(36)}-${++next}`;
      const config = body.config;
      configs.set(machine, config);versions.set(machine,1);
      const env = Object.entries(config.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
      docker(
        'run', '-d', '--name', machine, '--network', 'host',
        '--memory', `${config.guest.memory_mb}m`, '--cpus', String(config.guest.cpus),
        '--label', `beeline_agent=${config.metadata.beeline_agent}`,
        // bwrap needs user namespaces inside the container, as on a Fly VM.
        '--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined',
        '--cap-add', 'SYS_ADMIN', '-v', `${machine}-home:/root`,
        ...env, config.image,
      );
      log(`create ${machine}`);
      return send(200, { id: machine, state: 'created',instance_id:'1',config });
    }
    if (!id && request.method === 'GET') {
      const agent = url.searchParams.get('metadata.beeline_agent');
      return send(200,[...configs].filter(([,config])=>!agent||config.metadata.beeline_agent===agent).map(([id,config])=>({
        id,state:state(id),instance_id:String(versions.get(id)),config,
      })));
    }
    if (id && !configs.has(id)) return send(404,{error:'not a fixture machine'});
    if (id && !action && request.method === 'POST') {
      if (String(body.current_version)!==String(versions.get(id))) return send(412,{error:'version changed'});
      const running=state(id)==='started',config=body.config;
      if (state(id)==='suspended') docker('unpause',id);
      docker('rm','-f',id);
      const env=Object.entries(config.env??{}).flatMap(([key,value])=>['-e',`${key}=${value}`]);
      docker('create','--name',id,'--network','host','--memory',`${config.guest.memory_mb}m`,'--cpus',String(config.guest.cpus),
        '--label',`beeline_agent=${config.metadata.beeline_agent}`,'--security-opt','seccomp=unconfined','--security-opt','apparmor=unconfined',
        '--cap-add','SYS_ADMIN','-v',`${id}-home:/root`,...env,config.image);
      if(running)docker('start',id);
      configs.set(id,config);versions.set(id,versions.get(id)+1);
      log(`update ${id}: ${state(id)}`);
      return send(200,{id,state:state(id),instance_id:String(versions.get(id)),config});
    }
    if (id && !action && request.method === 'GET') {
      const current = state(id);
      return current ? send(200, { id, state: current,instance_id:String(versions.get(id)),config:configs.get(id) }) : send(404, { error: 'not found' });
    }
    if (id && !action && request.method === 'DELETE') {
      docker('rm', '-f', id);
      docker('volume','rm',`${id}-home`);configs.delete(id);versions.delete(id);
      log(`destroy ${id}`);
      return send(200, { ok: true });
    }
    if (action === 'start') {
      const current = state(id);
      if (current === 'suspended') docker('unpause', id);
      else if (current === 'stopped') docker('start', id);
      log(`start ${id} (was ${current})`);
      return send(200, { previous_state: current });
    }
    if (action === 'wait') return send(state(id)===url.searchParams.get('state')?200:409, { state: state(id) });
    if (action === 'suspend') {
      docker('pause', id);
      log(`suspend ${id}`);
      return send(200, { ok: true });
    }
    if (action === 'stop') {
      docker('stop', '-t', '5', id);
      log(`stop ${id}`);
      return send(200, { ok: true });
    }
    return send(404, { error: 'not found' });
  } catch (error) {
    log(`${request.method} ${url.pathname} failed: ${error.message}`);
    return send(500, { error: String(error.message) });
  }
}).listen(port, '127.0.0.1', () => log(`listening on 127.0.0.1:${port}`));
