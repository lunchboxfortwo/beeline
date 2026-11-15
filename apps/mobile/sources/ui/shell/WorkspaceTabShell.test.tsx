import React,{useEffect} from 'react';
// @ts-expect-error Renderer declarations are absent in this workspace.
import {act,create} from 'react-test-renderer';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';

const f=vi.hoisted(()=>({path:'/beeline/people',desktop:false,titleRenders:0,identity:vi.fn(),read:vi.fn(),replace:vi.fn()}));
vi.mock('react-native',()=>({Platform:{OS:'ios',select:(choices:any)=>choices.ios??choices.default}}));
vi.mock('tamagui',async()=> (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native',async()=> (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context',()=>({useSafeAreaInsets:()=>({top:24,right:0,bottom:0,left:0})}));
vi.mock('expo-router',()=>({usePathname:()=>f.path,router:{replace:f.replace,push:vi.fn()}}));
vi.mock('@/utils/responsive',()=>({useIsDesktop:()=>f.desktop}));
vi.mock('@/buzz/use-active-community',()=>({useActiveCommunityId:()=> 'ws'}));
vi.mock('@/buzz/needs-you-store',()=>({useNeedsYouCount:()=>0}));
vi.mock('@/auth/buzz-identity-storage',()=>({loadBuzzIdentity:f.identity,getEffectiveRelayUrl:async()=> 'https://test.invalid'}));
vi.mock('@/buzz/surface-storage',()=>({mobileSurfaceCache:{read:f.read},surfaceAddress:()=> 'workspaces'}));
vi.mock('@/buzz/use-shared-surface',()=>({useSurfaceSnapshot:()=>({workspaces:[{id:'ws',name:'Tubing Crew'}]})}));
vi.mock('@/ui/grammar',async()=>{
    const actual=await vi.importActual<any>('@/ui/grammar');
    return {...actual,T:(props:any)=>{if(props.children==='Tubing Crew')f.titleRenders++;return React.createElement('Text',props,props.children);}};
});

import {WorkspaceTabShell} from './WorkspaceTabShell';
import {TabHeader} from './TabHeader';
import {ChatListHeader} from '@/ui/screens/chats/ChatListHeader';
import {SafeTop} from '@/ui/grammar';

let tree:any;
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;f.path='/beeline/people';f.desktop=false;f.titleRenders=0;
    f.identity.mockReset().mockResolvedValue({publicKey:'viewer'});f.read.mockReset().mockResolvedValue(null);});
afterEach(()=>{if(tree)act(()=>tree.unmount());tree=undefined;});
function Tab({label}:{label:string}){return <><TabHeader workspaceName={label} scrolled={false}/><span>{label}</span></>;}
const app=(label:string)=><WorkspaceTabShell><Tab key={f.path} label={label}/></WorkspaceTabShell>;

function headerDisplay() {
    let node=tree.root.findByType(SafeTop).parent;
    while(node && node.props.display===undefined)node=node.parent;
    return node?.props.display;
}

it.each([
    '/', '/index', '/beeline', '/beeline/', '/beeline/index',
    ...['channels','tray','people','settings'].flatMap(tab=>[
        `/beeline/${tab}`, `/beeline/${tab}/`, `/beeline/${tab}/index`, `/beeline/${tab}/index/`,
    ]),
])('shows the pinned header and safe area on the phone tab root %s',async(path)=>{
    f.path=path;
    await act(async()=>{tree=create(app('Workspace'));});
    expect(headerDisplay()).toBe('flex');
    expect(tree.root.findByType(SafeTop).findByType('YStack').props.height).toBe(24);
});

it('shows the header on cold launch and when returning to Chats after every other tab',async()=>{
    f.path='/';
    await act(async()=>{tree=create(app('Workspace'));});
    expect(headerDisplay()).toBe('flex');
    for(const path of ['/beeline/tray','/beeline/channels','/beeline/people','/beeline/channels','/beeline/settings','/beeline/channels','/']){
        f.path=path;await act(async()=>tree.update(app('Workspace')));
        expect(headerDisplay()).toBe('flex');
    }
});

it('keeps Chats controls above its list and connected on the saved-session landing',async()=>{
    f.path='/';
    const onNew=vi.fn();const onSearch=vi.fn();
    await act(async()=>{tree=create(<WorkspaceTabShell>
        <TabHeader workspaceName="Workspace" scrolled={false} onNew={onNew}
            search={{open:false,query:'',chips:[]}} onSearch={onSearch}/>
        <span>Chat list</span>
    </WorkspaceTabShell>);});
    expect(headerDisplay()).toBe('flex');
    const header=tree.root.findByType(ChatListHeader);
    expect(header.props.workspaceName).toBe('Tubing Crew');
    const control=(id:string)=>tree.root.find((node:any)=>typeof node.type==='string'&&node.props.testID===id);
    act(()=>control('room-search-open').props.onPress());
    expect(onSearch).toHaveBeenCalledWith({open:true,query:'',chips:[]});
    act(()=>control('new-chat').props.onPress());
    expect(onNew).toHaveBeenCalledOnce();
    expect(tree.root.findByType('span').props.children).toBe('Chat list');
});

it.each(['/beeline/chat/room','/beeline/settings/workbench','/beeline/members','/beeline/community','/artifact-viewer'])
('leaves the screen header in charge on %s',async(path)=>{
    f.path=path;
    await act(async()=>{tree=create(app('Workspace'));});
    expect(headerDisplay()).toBe('none');
});

it('keeps one named header across tab mounts, with no placeholder or repeated cache reads',async()=>{
    await act(async()=>{tree=create(app('Workspace'));});
    const button=tree.root.find((node:any)=>typeof node.type==='string'&&node.props.testID==='workspace-switcher');
    const times:number[]=[];
    for(let i=0;i<40;i++){
        f.path=['/beeline/channels','/beeline/tray','/beeline/people','/beeline/settings'][i%4]!;
        const start=performance.now();await act(async()=>tree.update(app('Workspace')));times.push(performance.now()-start);
        expect(tree.root.find((node:any)=>typeof node.type==='string'&&node.props.testID==='workspace-switcher')).toBe(button);
        expect(tree.root.findAll((node:any)=>node.type==='Text'&&node.props.children==='Workspace')).toHaveLength(0);
    }
    expect(f.titleRenders).toBe(1);expect(f.identity).toHaveBeenCalledTimes(1);expect(f.read).toHaveBeenCalledTimes(1);
    expect(Math.max(...times)).toBeLessThan(150);
    console.log(`Persistent workspace header: 40 tab changes; title renders=${f.titleRenders}; cache reads=${f.read.mock.calls.length}; max=${Math.max(...times).toFixed(2)}ms (renderer, budget 150ms)`);
    await act(async()=>button.props.onPress());
    expect(tree.root.findAll((node:any)=>typeof node.type==='string'&&node.props.testID==='community-drawer-overlay')).toHaveLength(1);
});

it('keeps one tab bar mounted across the four tabs and hides it over a pushed chat',async()=>{
    await act(async()=>{tree=create(app('Workspace'));});
    const bar=()=>tree.root.find((node:any)=>typeof node.type==='string'&&node.props.testID==='shared-tab-bar');
    const tabs=bar().find((node:any)=>typeof node.type==='string'&&node.props.testID==='tab-bar');
    for(const [path,active] of [['/beeline/tray','tags'],['/beeline/people','people'],['/beeline/settings','settings'],['/beeline/channels','chats']] as const){
        f.path=path;await act(async()=>tree.update(app('Workspace')));
        expect(bar().find((node:any)=>typeof node.type==='string'&&node.props.testID==='tab-bar')).toBe(tabs);
        expect(bar().props.display).toBe('flex');
        expect(tabs.props.value).toBe(active);
    }
    f.path='/beeline/chat/room';await act(async()=>tree.update(app('Workspace')));
    expect(bar().props.display).toBe('none');
});

it('keeps the navigation stack mounted while hiding its header on a chat route',async()=>{
    let mounts=0;
    function Stack(){useEffect(()=>{mounts++;},[]);return <span>Stack</span>;}
    const render=()=><WorkspaceTabShell><Stack/></WorkspaceTabShell>;
    await act(async()=>{tree=create(render());});
    f.path='/beeline/chat/room';await act(async()=>tree.update(render()));
    f.path='/beeline/people';await act(async()=>tree.update(render()));
    expect(mounts).toBe(1);
});

it('keeps the existing desktop shell and memoizes its workspace title across controls',()=>{
    f.desktop=true;
    act(()=>{tree=create(<WorkspaceTabShell><span>Desktop sidebar</span></WorkspaceTabShell>);});
    expect(tree.root.findAllByType(ChatListHeader)).toHaveLength(0);
    act(()=>tree.update(<ChatListHeader workspaceName="Tubing Crew" onWorkspace={()=>undefined}/>));
    for(let i=0;i<40;i++)act(()=>tree.update(<ChatListHeader workspaceName="Tubing Crew" onWorkspace={()=>undefined} onNew={()=>undefined}/>));
    expect(f.titleRenders).toBe(1);
});

it('records the previous per-tab header mounts and placeholder renders for comparison',()=>{
    for(let i=0;i<4;i++){
        act(()=>{tree=create(<TabHeader workspaceName="Workspace" scrolled={false}/>);});
        act(()=>tree.update(<TabHeader workspaceName="Tubing Crew" scrolled={false}/>));
        act(()=>tree.unmount());tree=undefined;
    }
    expect(f.titleRenders).toBe(4);
    console.log('Previous workspace header: 4 tab mounts; 4 placeholder paints; 4 resolved title renders');
});
