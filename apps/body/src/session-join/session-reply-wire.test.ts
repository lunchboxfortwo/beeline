import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runSessionCommand } from './command.js';
import { stateDir, updateState, type JoinedSession } from './store.js';

const root = join(process.cwd(), '.beeline-proof');
const folders: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Condition 4, joined-session half: these CLI calls send the MCP tools/call
 * that the server scenario `messaging-c4-external.test.ts` drives over HTTP. */
describe('C4: joined session reply and message use the routed MCP tools', () => {
  it('session read prints the image attached to a returned message', async () => {
    mkdirSync(root,{recursive:true});const home=mkdtempSync(join(root,'image-read-'));folders.push(home);
    const env={HOME:home,XDG_CONFIG_HOME:home,XDG_STATE_HOME:home};
    const session:JoinedSession={key:'codex:/work',agent:'codex',cwd:'/work',name:'Jane agent',server:'https://beeline.invalid',
      clientId:'client',accessToken:'token',cursor:'0',deliveredWakes:[],joinedAt:''};
    await updateState(stateDir(env),state=>state.sessions.push(session));
    const image={url:'https://files.example.test/browser-screen.jpg',name:'browser-screen.jpg',mimeType:'image/jpeg',size:176684};
    const log=vi.spyOn(console,'log').mockImplementation(()=>{});
    vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify({data:{
      items:[{messageId:'a'.repeat(64),authorHandle:'person',body:'keyboard not centered',attachments:[image]}],
    }})}]}}));
    await runSessionCommand(['session','read','--room','chat-1','--as',session.key],env);
    const output=log.mock.calls.flat().join('\n');
    expect(output).toContain(`[${'a'.repeat(64)}] @person`);
    expect(output).toContain('keyboard not centered');expect(output).toContain(image.name);expect(output).toContain(image.url);expect(output).toContain(image.mimeType);
  });
  it.each([
    [['session', 'reply', '--reply-to', 'a'.repeat(64), 'blocked: build access'], 'reply', { id: 'a'.repeat(64), text: 'blocked: build access' }],
    [['session', 'tool', 'message', JSON.stringify({ address: 'chat-1', to: { agent: 'implementer', place: 'thread-1' }, text: 'Build widget' })],
      'message', { address: 'chat-1', to: { agent: 'implementer', place: 'thread-1' }, text: 'Build widget' }],
  ] as const)('%j sends tools/call %s', async (args, name, input) => {
    mkdirSync(root, { recursive: true });
    const home = mkdtempSync(join(root, 'session-wire-'));
    folders.push(home);
    const env = { HOME: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home };
    const session: JoinedSession = { key: 'codex:/work', agent: 'codex', cwd: '/work', name: 'Jane agent', server: 'https://beeline.invalid',
      clientId: 'client', accessToken: 'token', cursor: '0', deliveredWakes: [], joinedAt: '' };
    await updateState(stateDir(env), state => state.sessions.push(session));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({ data: { messageId: 'b'.repeat(64), stored:true } }) }] } })));
    await runSessionCommand(['session', ...args.slice(1), '--as', session.key], env);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://beeline.invalid/mcp');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer token', 'mcp-protocol-version': '2026-07-28' });
    expect(JSON.parse(String(init?.body))).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } });
  });
  it('reports queued delivery and refuses to say Posted for an unstored result', async () => {
    mkdirSync(root,{recursive:true});
    const home = mkdtempSync(join(root,'reply-receipts-'));
    folders.push(home);
    const env = {HOME:home,XDG_CONFIG_HOME:home,XDG_STATE_HOME:home};
    const session:JoinedSession = {key:'codex:/work',agent:'codex',cwd:'/work',name:'Jane agent',
      server:'https://beeline.invalid',clientId:'client',accessToken:'token',cursor:'0',deliveredWakes:[],joinedAt:''};
    await updateState(stateDir(env),state=>state.sessions.push(session));
    const log = vi.spyOn(console,'log').mockImplementation(()=>{});
    const reply = (data:object) => Response.json({result:{content:[{type:'text',text:JSON.stringify({data})}]}});
    vi.spyOn(globalThis,'fetch')
      .mockResolvedValueOnce(reply({stored:false,answered:false,receipt:'The request is still queued.'}))
      .mockResolvedValueOnce(reply({queued:true,stored:true,deliveryCommandId:'delivery',destination:{agent:'ruby',place:'chat'}}));
    const args = ['session','reply','--reply-to','message','text','--as',session.key];
    await expect(runSessionCommand(args,env)).rejects.toThrow('The request is still queued.');
    expect(log).not.toHaveBeenCalled();
    await runSessionCommand(args,env);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ruby@chat (command delivery)'));
  });

  it('passes attachment content blocks through session tool', async () => {
    mkdirSync(root,{recursive:true});
    const home = mkdtempSync(join(root,'attachment-tool-'));
    folders.push(home);
    const env = {HOME:home,XDG_CONFIG_HOME:home,XDG_STATE_HOME:home};
    const session:JoinedSession = {key:'codex:/work',agent:'codex',cwd:'/work',name:'Jane agent',
      server:'https://beeline.invalid',clientId:'client',accessToken:'token',cursor:'0',deliveredWakes:[],joinedAt:''};
    await updateState(stateDir(env),state=>state.sessions.push(session));
    const log = vi.spyOn(console,'log').mockImplementation(()=>{});
    const content = [
      {type:'image',mimeType:'image/png',data:'AA=='},
      {type:'resource',resource:{uri:'/v1/media/object',mimeType:'text/plain',blob:'YQ=='}},
    ];
    vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({result:{content:[
      {type:'text',text:JSON.stringify({data:{attachmentId:'object'}})},...content,
    ]}}));
    await runSessionCommand(['session','tool','read','{"facet":"attachment"}','--as',session.key],env);
    expect(JSON.parse(log.mock.calls[0]![0])).toEqual({data:{attachmentId:'object'},content});
  });

});
