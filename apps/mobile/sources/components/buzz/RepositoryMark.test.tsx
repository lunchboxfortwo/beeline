import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ Image: 'NativeImage' }));
vi.mock('tamagui',async()=>(await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native',async()=>(await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context',()=>({useSafeAreaInsets:()=>({top:0,bottom:0,left:0,right:0})}));
import { RepositoryMark } from './RepositoryMark';
it('shows the stored owner photo, falls back to the favicon on failure, then the generic mark',async()=>{
  let tree:any;
  await act(async()=>{tree=create(<RepositoryMark avatarUrl="https://avatars.githubusercontent.com/u/42" faviconUrl="https://github.githubassets.com/favicons/favicon.png" size={28}/>);});
  const image=()=>tree.root.find((node:any)=>node.type==='NativeImage');
  expect(image().props.source.uri).toBe('https://avatars.githubusercontent.com/u/42');
  expect(image().props.style).toEqual({width:'100%',height:'100%'});
  await act(async()=>image().props.onError());
  expect(image().props.source.uri).toBe('https://github.githubassets.com/favicons/favicon.png');
  await act(async()=>image().props.onError());
  expect(tree.root.findAll((node:any)=>node.type==='NativeImage')).toHaveLength(0);
  expect(tree.root.findAll((node:any)=>node.type==='Icon.Hash')).toHaveLength(1);
  await act(async()=>tree.unmount());
});
