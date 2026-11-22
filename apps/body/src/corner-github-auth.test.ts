import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,symlink,unlink,rm,chmod,readFile,stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {installCornerGitHubWrappers} from './corner-github-auth.js';

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

it('an existing thread git launcher follows the stable install after its original release is removed',async()=>{
  const root=await mkdtemp(join(tmpdir(),'beeline-corner-wrapper-'));roots.push(root);
  const lib=join(root,'lib'),releases=join(lib,'beeline-releases'),anchor=join(lib,'beeline');
  const entry='lib/beeline/beeline-cli.mjs';
  for(const release of ['old','new']){
    await mkdir(join(releases,release,'lib/beeline'),{recursive:true});
    await writeFile(join(releases,release,entry),`process.stdout.write('${release}-token');`);
  }
  await symlink('beeline-releases/old',anchor);
  const git=join(root,'fixture-git');
  await writeFile(git,'#!/bin/sh\nprintf "%s" "$GH_TOKEN"\n');await chmod(git,0o755);
  const session=join(root,'session');
  await installCornerGitHubWrappers({root:session,runtimeConfigPath:join(root,'runtime.json'),roomId:'room',
    cliEntrypoint:join(releases,'old',entry),gitBinary:git,featureBranch:'feature/test',targetBranch:'main'});
  const wrapper=join(session,'beeline-github-bin/git');
  const run=()=>promisify(execFile)(process.execPath,[wrapper,'fetch','origin'],{
    env:{...process.env,HOME:root,XDG_CONFIG_HOME:join(root,'config'),XDG_STATE_HOME:join(root,'state')}});
  expect((await run()).stdout).toBe('old-token');
  await unlink(anchor);await symlink('beeline-releases/new',anchor);
  await rm(join(releases,'old'),{recursive:true});
  expect((await run()).stdout).toBe('new-token');
  expect(await readFile(wrapper,'utf8')).not.toContain(join(releases,'old'));
});

it('refuses a non-implementer PR open and push, then allows both after takeover',async()=>{
  const root=await mkdtemp(join(tmpdir(),'beeline-implementer-wrapper-'));roots.push(root);
  const role=join(root,'implementer'),calls=join(root,'calls'),cli=join(root,'credential.mjs'),git=join(root,'git'),gh=join(root,'gh');
  const refusal='Call claim_thread before pushing or opening a PR for this thread.';
  await writeFile(cli,`import {existsSync} from 'node:fs';
const expectedRoom = process.argv.includes('--write') ? 'thread' : 'chat';
if (process.argv[process.argv.indexOf('--room') + 1] !== expectedRoom) throw new Error('wrong credential room');
if(process.argv.includes('--write')&&!existsSync(${JSON.stringify(role)})){
  process.stderr.write(${JSON.stringify(refusal+'\n')});process.exit(1);
}process.stdout.write(JSON.stringify({token:'fixture-token',expiresAt:Date.now()+3_600_000}));`);
  await writeFile(git,`#!/bin/sh
case "$*" in
  *symbolic-ref*) echo feature/test;;
  *show-ref*) exit 1;;
  *"get-url --push"*) echo https://github.com/acme/repo.git;;
  *"push origin"*) echo push >> '${calls}';;
esac
`);await chmod(git,0o755);
  await writeFile(gh,`#!/bin/sh
echo pr >> '${calls}'
echo https://github.com/acme/repo/pull/1
`);await chmod(gh,0o755);
  await installCornerGitHubWrappers({root,runtimeConfigPath:join(root,'runtime.json'),roomId:'chat',cornerId:'thread',
    cliEntrypoint:cli,gitBinary:git,ghBinary:gh,featureBranch:'feature/test',targetBranch:'main',originUrl:'https://github.com/acme/repo.git'});
  const run=(command:string,args:string[])=>promisify(execFile)(process.execPath,[join(root,'beeline-github-bin',command),...args],{
    env:{...process.env,HOME:root,XDG_CONFIG_HOME:join(root,'config'),XDG_STATE_HOME:join(root,'state')}});
  for(const [command,args] of [['gh',['pr','create']],['git',['push','origin','feature/test']]] as const)
    await expect(run(command,[...args])).rejects.toMatchObject({stderr:refusal+'\n'});
  await expect(readFile(calls,'utf8')).rejects.toMatchObject({code:'ENOENT'});
  await run('git',['fetch','origin']);
  // The credential path reads current server authority on each invocation.
  await writeFile(role,'this-agent');
  expect((await run('gh',['pr','create'])).stdout).toContain('https://github.com/acme/repo/pull/1');
  await run('git',['push','origin','feature/test']);
  expect(await readFile(calls,'utf8')).toBe('pr\npush\n');
  await unlink(role);
  await expect(run('git',['push','origin','feature/test'])).rejects.toMatchObject({stderr:refusal+'\n'});
  await expect(run('gh',['pr','create'])).rejects.toMatchObject({stderr:refusal+'\n'});
  expect(await readFile(calls,'utf8')).toBe('pr\npush\n');
});

it('keeps the issued read credential across git and gh until near expiry or repository change', async () => {
  const root=await mkdtemp(join(tmpdir(),'beeline-credential-lifetime-')); roots.push(root);
  const cli=join(root,'credential.mjs'),git=join(root,'git'),gh=join(root,'gh'),origin=join(root,'origin');
  await writeFile(origin,'https://github.com/acme/first.git');
  let requests=0;
  const server=createServer((_request,response)=>{
    requests++;
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify({token:`issued-${requests}`,expiresAt:Date.now()+3_600_000}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  await writeFile(cli,`process.stdout.write(await (await fetch(${JSON.stringify(url)})).text());`);
  await writeFile(git,`#!/bin/sh\ncase "$*" in *"remote get-url origin"*) cat '${origin}';; *) printf "%s" "$GH_TOKEN";; esac\n`);
  await writeFile(gh,'#!/bin/sh\nprintf "%s" "$GH_TOKEN"\n');
  await Promise.all([chmod(git,0o755),chmod(gh,0o755)]);
  await installCornerGitHubWrappers({root,runtimeConfigPath:join(root,'runtime.json'),roomId:'chat',cornerId:'thread',
    cliEntrypoint:cli,gitBinary:git,ghBinary:gh,featureBranch:'feature/test',targetBranch:'main'});
  const run=(command:string,args:string[])=>promisify(execFile)(process.execPath,[join(root,'beeline-github-bin',command),...args],{
    env:{...process.env,HOME:root,XDG_CONFIG_HOME:join(root,'config'),XDG_STATE_HOME:join(root,'state')}});
  try {
    const values:string[]=[];
    for(let index=0;index<12;index++) {
      const result=index%2?await run('gh',['pr','view','1']):await run('git',['fetch','origin']);
      values.push(result.stdout);
    }
    expect(requests).toBe(1);
    expect(new Set(values)).toEqual(new Set(['issued-1']));
    const path=join(root,'beeline-github-bin/repository-credential.json');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const issued=JSON.parse(await readFile(path,'utf8'));
    await writeFile(path,JSON.stringify({...issued,expiresAt:Date.now()+30_000}));
    expect((await run('git',['fetch','origin'])).stdout).toBe('issued-2');
    expect(requests).toBe(2);
    await writeFile(origin,'https://github.com/acme/second.git');
    expect((await run('gh',['pr','view','1'])).stdout).toBe('issued-3');
    expect(requests).toBe(3);
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});

it('local repository URL inspection and CLI help make no credential request', async () => {
  const root=await mkdtemp(join(tmpdir(),'beeline-local-git-')); roots.push(root);
  const cli=join(root,'credential.mjs'),binary=join(root,'binary'),calls=join(root,'calls');
  await writeFile(cli,`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(calls)},${JSON.stringify('request\n')});process.stdout.write('fixture-token');`);
  await writeFile(binary,'#!/bin/sh\nexit 0\n'); await chmod(binary,0o755);
  await installCornerGitHubWrappers({root,runtimeConfigPath:join(root,'runtime.json'),roomId:'chat',
    cliEntrypoint:cli,gitBinary:binary,ghBinary:binary,featureBranch:'feature/test',targetBranch:'main'});
  const run=(command:string,args:string[])=>promisify(execFile)(process.execPath,[join(root,'beeline-github-bin',command),...args]);
  for(const args of [['remote','-v'],['-C',root,'remote','get-url','origin'],['ls-remote','--get-url','origin']])
    await run('git',args);
  await run('gh',['pr','view','--help']);
  await expect(readFile(calls,'utf8')).rejects.toMatchObject({code:'ENOENT'});
  await run('git',['remote','update']);
  expect(await readFile(calls,'utf8')).toBe('request\n');
});

it('reports a GitHub CLI refusal once without replaying the request through REST', async () => {
  const root=await mkdtemp(join(tmpdir(),'beeline-github-refusal-')); roots.push(root);
  const cli=join(root,'credential.mjs'),git=join(root,'git'),gh=join(root,'gh'),calls=join(root,'calls');
  await writeFile(cli,"process.stdout.write('fixture-token');");
  await writeFile(git,'#!/bin/sh\necho https://github.com/acme/repo.git\n'); await chmod(git,0o755);
  await writeFile(gh,`#!/bin/sh\necho call >> '${calls}'\necho 'HTTP 403: Bad credentials' >&2\nexit 1\n`); await chmod(gh,0o755);
  let requests=0;
  const server=createServer((_request,response)=>{requests++;response.end(JSON.stringify({html_url:'unexpected fallback'}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    await installCornerGitHubWrappers({root,runtimeConfigPath:join(root,'runtime.json'),roomId:'chat',
      cliEntrypoint:cli,gitBinary:git,ghBinary:gh,featureBranch:'feature/test',targetBranch:'main'});
    await expect(promisify(execFile)(process.execPath,[join(root,'beeline-github-bin/gh'),'pr','view','1','--repo','acme/repo'],{
      env:{...process.env,GITHUB_API_URL:`http://127.0.0.1:${(server.address() as {port:number}).port}`},
    })).rejects.toMatchObject({code:1,stderr:'HTTP 403: Bad credentials\n'});
    expect(await readFile(calls,'utf8')).toBe('call\n');
    expect(requests).toBe(0);
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});

it('routes launcher credentials through the real CLI command parser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-wrapper-cli-')); roots.push(root);
  const cli = join(root, 'credential.mjs'), binary = join(root, 'git');
  // Use the real CLI routing, replacing only its network credential reader.
  await writeFile(cli, `
    import { DaemonApiClient } from ${JSON.stringify(new URL('./daemon-api-client.ts', import.meta.url).href)};
    DaemonApiClient.readRepositoryCredential = async (config, room, unused, write) => {
      if (room !== 'thread' || !write) throw new Error('wrong credential request');
      return { token: 'fixture-token' };
    };
    await import(${JSON.stringify(new URL('./cli.ts', import.meta.url).href)});
  `);
  await writeFile(binary, '#!/bin/sh\ncase "$*" in *show-ref*) exit 1;; *symbolic-ref*) echo feature/test;; *) printf "%s" "$GH_TOKEN";; esac\n'); await chmod(binary, 0o755);
  await installCornerGitHubWrappers({ root, runtimeConfigPath: join(root, 'runtime.json'), roomId: 'chat', cornerId: 'thread',
    cliEntrypoint: cli, gitBinary: binary, featureBranch: 'feature/test', targetBranch: 'main' });
  const result = await promisify(execFile)(process.execPath, [join(root, 'beeline-github-bin/git'), 'push', 'origin', 'feature/test'], {
    env: { ...process.env, NODE_OPTIONS: `--import ${createRequire(import.meta.url).resolve('tsx')}`,
      HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') },
  });
  expect(result.stdout).toBe('fixture-token');
});

it('sends gh writes through thread authority and never stores a write credential', async () => {
  const root=await mkdtemp(join(tmpdir(),'beeline-gh-writes-')); roots.push(root);
  const cli=join(root,'credential.mjs'),gh=join(root,'gh'),git=join(root,'git'),requests=join(root,'requests');
  await writeFile(cli,`import {appendFileSync} from 'node:fs';
const write=process.argv.includes('--write');
appendFileSync(${JSON.stringify(requests)},(write?'write ':'read ')+process.argv[process.argv.indexOf('--room')+1]+'\\n');
process.stdout.write(JSON.stringify({token:write?'write-token':'read-token',expiresAt:Date.now()+3_600_000}));`);
  await writeFile(gh,'#!/bin/sh\nprintf "%s" "$GH_TOKEN"\n'); await writeFile(git,'#!/bin/sh\nprintf "%s" "$GH_TOKEN"\n');
  await Promise.all([chmod(gh,0o755),chmod(git,0o755)]);
  await installCornerGitHubWrappers({root,runtimeConfigPath:join(root,'runtime.json'),roomId:'chat',cornerId:'thread',
    cliEntrypoint:cli,gitBinary:git,ghBinary:gh,featureBranch:'feature/test',targetBranch:'main'});
  const run=(args:string[])=>promisify(execFile)(process.execPath,[join(root,'beeline-github-bin/gh'),...args],{
    env:{...process.env,HOME:root,XDG_CONFIG_HOME:join(root,'config'),XDG_STATE_HOME:join(root,'state')}});
  for (const args of [['pr','ready','1'],['pr','comment','1','--body','b'],['pr','merge','1'],
    ['api','-X','POST','/repos/acme/repo/issues'],['api','/repos/acme/repo/issues','-f','title=x'],['issue','create']])
    expect((await run(args)).stdout).toBe('write-token');
  for (const args of [['pr','view','1'],['pr','checks','1'],['api','/repos/acme/repo/pulls'],['run','view','9'],['pr','view','1','-R','acme/repo']])
    expect((await run(args)).stdout).toBe('read-token');
  expect(await readFile(requests,'utf8')).toBe('write thread\n'.repeat(6)+'read chat\n');
  // Only the read credential is kept on disk for later commands.
  expect(JSON.parse(await readFile(join(root,'beeline-github-bin/repository-credential.json'),'utf8')).token).toBe('read-token');
});

it('passes the thread-session refusal through to the agent in plain words', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-wrapper-session-')); roots.push(root);
  const cli = join(root, 'credential.mjs'), binary = join(root, 'git');
  const refusal = 'Work on thread host-grant-truth from its own session; only that session can push to its branch or open its PR.';
  await writeFile(cli, `
    import { DaemonApiClient, DaemonApiError } from ${JSON.stringify(new URL('./daemon-api-client.ts', import.meta.url).href)};
    DaemonApiClient.readRepositoryCredential = async () => { throw new DaemonApiError('refused', 409, false, ${JSON.stringify(refusal)}); };
    await import(${JSON.stringify(new URL('./cli.ts', import.meta.url).href)});
  `);
  await writeFile(binary, '#!/bin/sh\ncase "$*" in *show-ref*) exit 1;; *symbolic-ref*) echo feature/test;; *) echo pushed;; esac\n'); await chmod(binary, 0o755);
  await installCornerGitHubWrappers({ root, runtimeConfigPath: join(root, 'runtime.json'), roomId: 'chat', cornerId: 'thread',
    cliEntrypoint: cli, gitBinary: binary, featureBranch: 'feature/test', targetBranch: 'main' });
  await expect(promisify(execFile)(process.execPath, [join(root, 'beeline-github-bin/git'), 'push', 'origin', 'feature/test'], {
    env: { ...process.env, NODE_OPTIONS: `--import ${createRequire(import.meta.url).resolve('tsx')}`,
      HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') },
  })).rejects.toMatchObject({ stderr: refusal + '\n', stdout: '' });
});
