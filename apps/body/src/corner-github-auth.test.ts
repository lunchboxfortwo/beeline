import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,symlink,unlink,rm,chmod,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
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
if(process.argv.includes('--write')&&!existsSync(${JSON.stringify(role)})){
  process.stderr.write(${JSON.stringify(refusal+'\n')});process.exit(1);
}process.stdout.write('fixture-token');`);
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
  await installCornerGitHubWrappers({root,runtimeConfigPath:join(root,'runtime.json'),roomId:'thread',
    cliEntrypoint:cli,gitBinary:git,ghBinary:gh,featureBranch:'feature/test',targetBranch:'main',originUrl:'https://github.com/acme/repo.git'});
  const run=(command:string,args:string[])=>promisify(execFile)(process.execPath,[join(root,'beeline-github-bin',command),...args],{
    env:{...process.env,HOME:root,XDG_CONFIG_HOME:join(root,'config'),XDG_STATE_HOME:join(root,'state')}});
  for(const [command,args] of [['gh',['pr','create']],['git',['push','origin','feature/test']]] as const)
    await expect(run(command,[...args])).rejects.toMatchObject({stderr:refusal+'\n'});
  await expect(readFile(calls,'utf8')).rejects.toMatchObject({code:'ENOENT'});
  // The credential path reads current server authority on each invocation.
  await writeFile(role,'this-agent');
  expect((await run('gh',['pr','create'])).stdout).toContain('https://github.com/acme/repo/pull/1');
  await run('git',['push','origin','feature/test']);
  expect(await readFile(calls,'utf8')).toBe('pr\npush\n');
});
