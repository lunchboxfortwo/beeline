import { expect, it } from 'vitest';
import { selectComposerAckPresentation } from './room-indicators';
import type { RoomViewAgentTurn, RoomViewIdentity } from '@beeline/api-contract/phone';
const names = ['Ruby', 'Jellybean', 'Grunt', 'Bee'];
const turns = names.map((name, index) => ({agentPubkey:name, requestId:`request-${index}`, status:'working', startedAt:100+index*20, createdAt:100+index*20}) as RoomViewAgentTurn);
const conversationIdentities = new Map(names.map(name => [name, {pubkey:name, name,kind:'agent',avatar:`/${name}.png`,face:'owl'} as RoomViewIdentity]));
const input = {isCorner:true, now:200_000, viewerPubkey:'viewer',viewerCanSend:true,conversationIdentities};
it('joins two names and carries each server receipt time and cancellation coordinates', () => {
  const ack = selectComposerAckPresentation({...input,activeTurns:turns.slice(0,2)});
  expect(ack?.label).toBe('Ruby, Jellybean brewing…');
  expect(ack?.startedAt).toBe(100);
  expect(ack?.agents?.map(agent => [agent.name,agent.startedAt,agent.stop])).toEqual([
    ['Ruby',100,{agentPubkey:'Ruby',requestId:'request-0'}],['Jellybean',120,{agentPubkey:'Jellybean',requestId:'request-1'}],
  ]);
});
it('counts three or more and keeps spectator cancellation controls absent', () => {
  const ack = selectComposerAckPresentation({...input,viewerCanSend:false,activeTurns:turns});
  expect(ack?.label).toBe('4 agents brewing…');
  expect(ack?.agents).toHaveLength(4);
  expect(ack?.agents?.every(agent => !agent.stop)).toBe(true);
});
it('keeps a single agent on its existing presentation', () => {
  const single={...input,activeTurnPubkey:'Ruby',activeTurnRequestId:'request-0',activeTurnStartedAt:100};
  expect(selectComposerAckPresentation({...single,activeTurns:turns.slice(0,1)})).toEqual(selectComposerAckPresentation(single));
});

it('keeps the server-assigned face when only membership detail is available', () => {
  const agentsByPubkey = new Map(names.map(name => [name, {pubkey:name,displayName:name,face:'owl'}]));
  const ack=selectComposerAckPresentation({...input,conversationIdentities:new Map(),agentsByPubkey,activeTurns:turns});
  expect(ack?.agents?.map(agent=>agent.face)).toEqual(['owl','owl','owl','owl']);
});
