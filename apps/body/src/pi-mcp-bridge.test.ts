import { EventEmitter } from 'node:events';
import { expect,it,vi } from 'vitest';
import { piMcpBridgeSource } from './pi-mcp-bridge.js';

it('loads the Pi extension and permits prompts without contacting an unresponsive MCP child', async () => {
  const child=Object.assign(new EventEmitter(),{
    stdout:Object.assign(new EventEmitter(),{setEncoding:vi.fn()}),
    stderr:Object.assign(new EventEmitter(),{setEncoding:vi.fn()}),
    stdin:{write:vi.fn()},kill:vi.fn(),
  });
  const spawn=vi.fn(()=>child);
  const tools:Array<{execute:(id:string,args:object)=>Promise<unknown>}>=[];
  const on=vi.fn();
  const source=piMcpBridgeSource([{name:'optional',command:'fixture'}])
    .replace(/^import .* from 'node:[^']+';\n/gm,'')
    .replace('export default function','return function');
  const extension=new Function('spawn','readFile',source)(spawn,vi.fn());
  await extension({registerTool:(tool:typeof tools[number])=>tools.push(tool),on});
  expect(spawn).not.toHaveBeenCalled();
  expect(on).not.toHaveBeenCalled();
  expect(tools).toHaveLength(1);
  // Only the agent's explicit tool operation opens discovery. A hung child
  // affects that tool call, never loading the extension or starting a prompt.
  const discovery=tools[0]!.execute('list',{});
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(child.stdin.write).toHaveBeenCalledTimes(2);
  const failed=expect(discovery).rejects.toThrow('exited before answering');
  child.emit('close',1,null);
  await failed;
});
