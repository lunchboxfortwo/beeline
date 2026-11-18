import { expect,it } from 'vitest';
import { replyCompletesTurn } from './claude-reply-completion-hook.js';
const hook=(tool_response:unknown)=>({hook_event_name:'PostToolUse',tool_name:'mcp__beeline-agent__reply',tool_response});
const receipt={_meta:{beeline:{turnComplete:true}}};
it('requires the server completion flag on the successful Beeline reply result',()=>{
 expect(replyCompletesTurn(hook(receipt))).toBe(true);
 expect(replyCompletesTurn(hook([{type:'text',text:JSON.stringify(receipt)}]))).toBe(true);
 expect(replyCompletesTurn(hook({content:[{type:'text',text:JSON.stringify(receipt)}]}))).toBe(true);
 for(const result of [{},{_meta:{beeline:{turnComplete:false}}},{isError:true,...receipt},'invalid'])
  expect(replyCompletesTurn(hook(result))).toBe(false);
 expect(replyCompletesTurn({...hook(receipt),tool_name:'other'})).toBe(false);
});
