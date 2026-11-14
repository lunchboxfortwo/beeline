import React from 'react';
// @ts-expect-error Renderer declarations are absent in this workspace.
import {act,create} from 'react-test-renderer';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {RoomRosterParticipant} from '@/buzz/room-participants';
import {AGENT_PRESENCE_DORMANT_MS} from '@beeline/buzz-client';
import {agentPresenceTier,mergeAgentPresenceBatch,type RoomAgentPresence} from '@/buzz/agent-presence';

vi.mock('@/buzz/use-room-corners',()=>({useRoomCorners:()=>({view:null,record:null})}));
vi.mock('@/buzz/room-corner-store',()=>({roomOpenCornerRows:()=>[]}));
vi.mock('@/components/buzz/StarPromptCard',()=>({useStarPrompt:()=>null}));
vi.mock('./chat-surface-values',()=>({
  CHANNEL_MENTION_OPTION:{pubkey:'@channel',name:'Everyone',handle:'channel',kind:'agent'},
  SYSTEM_MENTION_OPTION:{pubkey:'@system',name:'System',handle:'system',kind:'agent'},
}));
import {useChatComposerSuggestions} from './useChatComposerSuggestions';
import {useChatRoster} from './useChatRoster';

const claude:RoomRosterParticipant={pubkey:'b'.repeat(64),name:'Claude',handle:'claude',kind:'agent'};
const observedAt=1000,now=observedAt*1000+2*AGENT_PRESENCE_DORMANT_MS;
let tree:ReturnType<typeof create>;
let current:ReturnType<typeof useChatComposerSuggestions>;
const no=()=>undefined;
function Composer({text='@claude',members=[claude],presences={}}:{text?:string;members?:RoomRosterParticipant[];presences?:Record<string,RoomAgentPresence>}){
  const room={room:{id:'room',workspaceId:'workspace'},members:members.map(member=>({
    identity:{pubkey:member.pubkey,kind:'agent',name:member.name,handle:member.handle},role:'member'})),
    latestAgentTurns:[],viewer:{permissions:{send:true}}};
  const [participants,,described]=useChatRoster([room as never,new Map(),[],null,'viewer',null,presences]);
  const args=[participants,{start:text.length,end:text.length},text,described,true,null,false,undefined,'room',null,[],
    room,{},[],true,false,'viewer',{},{},{},[],null,'workspace',no,no,no];
  current=useChatComposerSuggestions(args as Parameters<typeof useChatComposerSuggestions>[0]);
  return null;
}
beforeEach(()=>Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true}));
afterEach(()=>{if(tree)act(()=>tree.unmount());});

it('offers @claude when an old disconnected session is cached despite a current connected server projection',()=>{
  const offline:RoomAgentPresence={agentPubkey:claude.pubkey,status:'offline',observedAt};
  // MCP delivery reconnects can reuse created_at. The retained presence merge
  // prefers its offline tie even when the current Room reports a held stream.
  const presences=mergeAgentPresenceBatch({[claude.pubkey]:offline},[{...offline,status:'online',held:true}]);
  expect(agentPresenceTier(presences[claude.pubkey],now)).toBe('dormant');
  act(()=>{tree=create(<Composer presences={presences}/>);});
  expect(current[17]).toBe(true);
  expect(current[18].matches).toMatchObject([claude]);
  act(()=>tree.update(<Composer members={[]} presences={presences}/>));
  expect(current[17]).toBe(false);
  expect(current[18].matches).toEqual([]);
});

it.each(['online','offline'] as const)('keeps a member addressable with old %s presence',status=>{
  act(()=>{tree=create(<Composer presences={{[claude.pubkey]:{agentPubkey:claude.pubkey,status,observedAt}}}/>);});
  expect(current[18].matches).toMatchObject([claude]);
});

it('resolves the same @claude member for its command palette while its session is offline',()=>{
  act(()=>{tree=create(<Composer text="@claude /help" presences={{[claude.pubkey]:{agentPubkey:claude.pubkey,status:'offline',observedAt}}}/>);});
  expect(current[8]).toBe(claude.pubkey);
});
