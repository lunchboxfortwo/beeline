import React from 'react';
// @ts-expect-error Renderer declarations are absent in this workspace.
import {act,create} from 'react-test-renderer';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {RoomRosterParticipant} from '@/buzz/room-participants';
import {AGENT_PRESENCE_DORMANT_MS} from '@beeline/buzz-client';
import {agentPresenceTier,mergeAgentPresenceBatch,type RoomAgentPresence} from '@/buzz/agent-presence';

vi.mock('@/sync/transport',()=>({BuzzRigTransport:vi.fn()}));
vi.mock('@/auth/buzz-identity-storage',()=>({loadBuzzIdentity:vi.fn()}));
vi.mock('expo-haptics',()=>({selectionAsync:vi.fn(),notificationAsync:vi.fn()}));
vi.mock('@/buzz/use-room-corners',()=>({useRoomCorners:()=>({view:null,record:null})}));
vi.mock('@/buzz/room-corner-store',()=>({roomOpenCornerRows:()=>[]}));
vi.mock('@/components/buzz/StarPromptCard',()=>({useStarPrompt:()=>null}));
vi.mock('./chat-surface-values',()=>({
  CHANNEL_MENTION_OPTION:{pubkey:'@channel',name:'Everyone',handle:'channel',kind:'agent'},
  SYSTEM_MENTION_OPTION:{pubkey:'@system',name:'System',handle:'system',kind:'agent'},
}));
import {useChatComposerSuggestions} from './useChatComposerSuggestions';
import {useChatComposerCommandController} from './useChatComposerCommandController';
import {useChatRoster} from './useChatRoster';

const claude:RoomRosterParticipant={pubkey:'b'.repeat(64),name:'Claude',handle:'claude',kind:'agent'};
const observedAt=1000,now=observedAt*1000+2*AGENT_PRESENCE_DORMANT_MS;
let tree:ReturnType<typeof create>;
let current:ReturnType<typeof useChatComposerSuggestions>;
let commands:ReturnType<typeof useChatComposerCommandController>;
const no=()=>undefined;
function Composer({text='@claude',members=[claude],presences={}}:{text?:string;members?:RoomRosterParticipant[];presences?:Record<string,RoomAgentPresence>}){
  const room={room:{id:'room',workspaceId:'workspace'},members:members.map(member=>({
    identity:{pubkey:member.pubkey,kind:'agent',name:member.name,handle:member.handle},role:'member'})),
    latestAgentTurns:[],viewer:{permissions:{send:true}}};
  const [participants,,described]=useChatRoster([room as never,new Map(),[],null,'viewer',null,presences]);
  const args=[{start:text.length,end:text.length},text,described,true,null,false,undefined,'room',null,[],
    room,{},[],true,false,[],null];
  current=useChatComposerSuggestions(args as Parameters<typeof useChatComposerSuggestions>[0]);
  commands=useChatComposerCommandController({
    roomParticipants:participants,inputText:text,decodedId:'room',viewerPubkey:'viewer',roomClient:null,
    activeCommunityId:'workspace',transport:null,setSessionTransport:no,inputTextRef:React.useRef(text),
    setInputText:no,setInputSelection:no,setComposerHeight:no,isCorner:false,isDirectMessage:false,
    viewerIsAgent:false,roomSurface:room as never,canManageWorkspace:false,pendingCornerRequest:undefined,
    pendingTargetBranchProposal:undefined,targetBranchActionId:null,composerFocused:true,
    dismissedSlashText:null,setHighlightedSlashVerbIndex:no,
  });
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
  expect(current[11]).toBe(true);
  expect(current[12].matches).toMatchObject([claude]);
  act(()=>tree.update(<Composer members={[]} presences={presences}/>));
  expect(current[11]).toBe(false);
  expect(current[12].matches).toEqual([]);
});

it.each(['online','offline'] as const)('keeps a member addressable with old %s presence',status=>{
  act(()=>{tree=create(<Composer presences={{[claude.pubkey]:{agentPubkey:claude.pubkey,status,observedAt}}}/>);});
  expect(current[12].matches).toMatchObject([claude]);
});

it('resolves the same @claude member for its command palette while its session is offline',()=>{
  act(()=>{tree=create(<Composer text="@claude /help" presences={{[claude.pubkey]:{agentPubkey:claude.pubkey,status:'offline',observedAt}}}/>);});
  expect(commands.mentionSlashAgentPubkey).toBe(claude.pubkey);
});

it.each(['online','offline'] as const)('offers login before any profile or command catalog read with %s presence',status=>{
  act(()=>{tree=create(<Composer text="@claude /login" presences={{[claude.pubkey]:{agentPubkey:claude.pubkey,status,observedAt}}}/>);});
  expect(commands.mentionAgentCommands).toEqual([{name:'login',description:'Sign in to this agent’s provider'}]);
});
