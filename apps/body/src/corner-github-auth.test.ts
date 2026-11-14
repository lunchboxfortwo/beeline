import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,symlink,unlink,rm,chmod,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {installCornerGitHubWrappers} from './corner-github-auth.js';

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

it('an existing corner git launcher follows the stable install after its original release is removed',async()=>{
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
