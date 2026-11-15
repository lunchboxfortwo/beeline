import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

const appearance = vi.hoisted(() => ({name:'light_brass'}));
const workOperation=vi.hoisted(()=>vi.fn(async()=>undefined));
vi.mock('@/sync/transport/monolith-operation',()=>({monolithPhoneOperation:workOperation}));
vi.mock('@/ui/screens/tags/WorkBoard',()=>({WorkAvatar:(props:any)=>React.createElement('WorkAvatar',props),WorkAssigneePicker:(props:any)=>React.createElement('WorkAssigneePicker',props)}));
vi.mock('@/ui/screens/tags/WorkMarks',()=>({WorkStateMark:'WorkStateMark'}));
vi.mock('@/components/buzz/RepositoryMark', () => ({ RepositoryMark: (props: any) => React.createElement('RepositoryMark', props) }));
vi.mock('tamagui', () => ({ ListItem: 'ListItem', XStack: 'XStack', YStack: 'YStack', useThemeName: () => appearance.name }));
vi.mock('lucide-react-native', () => ({ ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Users: 'Users', CornerDownRight: 'CornerDownRight', GitPullRequest: 'GitPullRequest', MoreHorizontal: 'MoreHorizontal' }));
vi.mock('@/ui/grammar', () => ({ Btn: 'Btn', Glyph: 'Glyph', T: 'T', SafeTop: 'SafeTop', HEIGHT: { control: 44 }, useTextSize: () => 'medium', typeStyle: (v:string) => ({lineHeight:v === 'title' ? 31 : 19}) }));
import { ThreadBar, ThreadTitleBlock, type ThreadHeaderData } from './ThreadHeader';

const byTestID = (tree: any, testID: string) => tree.root.findAll((node: any) => node.props?.testID === testID && typeof node.type === 'string');
const reconnect: ThreadHeaderData = {
  chatTag: '#beeline', title: 'Reconnect keeps place', state: 'review',
  prLine: '#4181 · Open · All 14 checks passed',
  objective: 'Keep the transcript still when the connection returns.',
};

beforeEach(() => { appearance.name='light_brass'; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

it('draws the title block: title, shared work-state glyph, PR and preserved quoted objective and brief link', () => {
  const openBrief = vi.fn(), openPr = vi.fn();
  let tree: any;
  act(() => { tree = create(<ThreadTitleBlock h={reconnect} openBrief={openBrief} openPr={openPr} />); });
  expect(byTestID(tree, 'thread-title')[0].props.children).toBe('Reconnect keeps place');
  expect(byTestID(tree, 'thread-status')).toHaveLength(0);
  expect(byTestID(tree, 'thread-status-dot')).toHaveLength(0);
  expect(tree.root.findByType('WorkStateMark').props.state).toBe('in-review');
  const pr = byTestID(tree, 'thread-pr')[0];
  expect(pr.findByType('T').props.children).toBe('#4181 · Open · All 14 checks passed');
  act(() => pr.props.onPress());
  expect(openPr).toHaveBeenCalledTimes(1);
  const brief = byTestID(tree, 'thread-brief')[0];
  expect(brief.findAllByType('T').map((node: any) => node.props.children)).toEqual([reconnect.objective, 'Read the brief']);
  act(() => brief.props.onPress());
  expect(openBrief).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});

it('shows a quiet thread without a running count or PR, and its hollow idle ring', () => {
  let tree: any;
  act(() => { tree = create(<ThreadTitleBlock h={{ chatTag: '#beeline', title: 'Owed commands', state: 'idle' }} />); });
  expect(byTestID(tree, 'thread-status')).toHaveLength(0);
  expect(tree.root.findByType('WorkStateMark').props).toMatchObject({state: 'in-progress', idle: true});
  expect(byTestID(tree, 'thread-pr')).toHaveLength(0);
  expect(byTestID(tree, 'thread-brief')).toHaveLength(0);
  act(() => tree.unmount());
});

it('keeps the bar slim, and gives it the title with a work-state glyph once the block scrolls away', () => {
  const openChat = vi.fn(), openActions = vi.fn(), back = vi.fn();
  let tree: any;
  act(() => { tree = create(<ThreadBar h={{ ...reconnect, state: 'working' }} collapsed={false} back={back} openChat={openChat} openActions={openActions} />); });
  const chat = byTestID(tree, 'thread-chat-link')[0];
  expect(chat.findByType('T').props.children).toBe('#beeline');
  expect(chat.findByType('T').props.color).toBe('secondary');
  act(() => chat.props.onPress());
  expect(openChat).toHaveBeenCalledTimes(1);
  expect(byTestID(tree, 'thread-bar-title')).toHaveLength(0);
  act(() => byTestID(tree, 'corner-actions-menu')[0].props.onPress());
  expect(openActions).toHaveBeenCalledTimes(1);
  act(() => tree.update(<ThreadBar h={{ ...reconnect, state: 'working' }} collapsed back={back} openChat={openChat} openActions={openActions} />));
  const title = byTestID(tree, 'thread-bar-title')[0];
  expect(title.findByType('T').props.children).toBe('Reconnect keeps place');
  expect(title.findByType('WorkStateMark').props).toMatchObject({state: 'in-progress', idle: false});
  // A long chat name must not starve the title: both stack and wrap, never a fixed-width chat link.
  const names = byTestID(tree, 'thread-bar-names')[0];
  expect(names.findAll((n: any) => n.props.testID === 'thread-chat-link' && typeof n.type === 'string')).toHaveLength(1);
  expect(names.findAll((n: any) => n.props.testID === 'thread-bar-title' && typeof n.type === 'string')).toHaveLength(1);
  expect(byTestID(tree, 'thread-chat-link')[0].props.flexShrink).not.toBe(0);
  expect(byTestID(tree, 'thread-chat-link')[0].findByType('T').props.flexShrink).toBe(1);
  expect(title.findByType('T').props.flexShrink).toBe(1);
  act(() => tree.unmount());
});

it('expands the full header from a tap on the slim bar, and shows it under the bar', () => {
  const expand = vi.fn();
  let tree: any;
  act(() => { tree = create(<ThreadBar h={reconnect} collapsed openChat={vi.fn()} expand={expand} />); });
  act(() => byTestID(tree, 'thread-bar-title')[0].props.onPress());
  expect(expand).toHaveBeenCalledTimes(1);
  act(() => tree.update(<ThreadBar h={reconnect} collapsed openChat={vi.fn()} expand={expand} expanded={<ThreadTitleBlock h={reconnect} />} />));
  expect(byTestID(tree, 'thread-bar-title')).toHaveLength(0);
  expect(byTestID(tree, 'thread-title')[0].props.children).toBe('Reconnect keeps place');
  act(() => tree.unmount());
});

it('keeps the repository mark beside the parent chat in a thread header', () => {
  let tree: any;
  act(() => { tree = create(<ThreadBar h={{...reconnect,repositoryAvatar:'https://avatars.githubusercontent.com/u/42'}} collapsed={false} openChat={vi.fn()} />); });
  expect(tree.root.findByType('RepositoryMark').props.avatarUrl).toBe('https://avatars.githubusercontent.com/u/42');
  act(() => tree.unmount());
});

it('shows immutable opening attribution and one editable assignee for the selected task',async()=>{
  const asker={pubkey:'ruby',kind:'agent' as const,name:'Ruby'},person={pubkey:'ada',kind:'human' as const,name:'Ada'};
  const workItem={id:'question',roomId:'thread',chatId:'chat',chatName:'Milo',threadName:'request-inbox',title:'Choose the next surface',state:'needs-you' as const,assignee:person,openedBy:asker,createdAt:1,updatedAt:2};
  let tree:any;await act(async()=>{tree=create(<ThreadTitleBlock h={{...reconnect,workItem,people:[asker,person]}}/>);});
  expect(byTestID(tree,'thread-work-metadata')).toHaveLength(1);
  expect(tree.root.findAllByType('WorkAvatar').map((node:any)=>node.props.person.pubkey)).toEqual(['ruby','ada']);
  await act(async()=>tree.root.findByProps({label:'Change assignee'}).props.onPress());
  await act(async()=>tree.root.findByType('WorkAssigneePicker').props.onPick(asker));
  expect(workOperation).toHaveBeenLastCalledWith('updateWorkItem',{id:'question',roomId:'thread',assigneeId:'ruby'});
  await act(async()=>tree.unmount());
});

for (const [state, glyph, idle] of [['waiting', 'needs-you', false], ['working', 'in-progress', false], ['idle', 'in-progress', true], ['review', 'in-review', false], ['archived', 'done', false]] as const) {
  it(`maps ${state} through the shared state graph in both headers`, () => {
    let tree: any;
    act(() => { tree = create(<><ThreadTitleBlock h={{...reconnect,state,waitsOnViewer:state === 'waiting'}}/><ThreadBar h={{...reconnect,state}} collapsed openChat={() => undefined}/></>); });
    expect(tree.root.findAllByType('WorkStateMark').map((node:any) => node.props)).toEqual([{state:glyph,idle},{state:glyph,idle}]);
    expect(byTestID(tree,'thread-title')[0].props.regular).toBe(state !== 'waiting');
    expect(byTestID(tree,'thread-objective')[0].props).toMatchObject({numberOfLines:3});
    expect(byTestID(tree,'thread-title-block')[0].props.paddingHorizontal).toBe('4');
    act(() => tree.unmount());
  });
}

it('centers the glyph box on the title line in expanded and collapsed headers', () => {
  let tree:any;
  act(()=>{tree=create(<><ThreadTitleBlock h={reconnect}/><ThreadBar h={reconnect} collapsed openChat={()=>{}}/></>);});
  expect(byTestID(tree,'thread-title-row')[0].props.alignItems).toBe('center');
  expect(byTestID(tree,'thread-state-box')[0].props).toMatchObject({height:31,alignItems:'center',justifyContent:'center'});
  expect(byTestID(tree,'thread-bar-state-box')[0].props).toMatchObject({height:19,alignItems:'center',justifyContent:'center'});
  expect(byTestID(tree,'thread-state-box')[0].props.paddingTop).toBeUndefined();
  act(()=>tree.unmount());
});
for (const theme of ['light_stone','dark_stone','light_brass','dark_brass']) {
  it(`uses a neutral quoted-objective rail under ${theme} only when Stone is selected`, () => {
    appearance.name=theme;let tree:any;
    act(()=>{tree=create(<ThreadTitleBlock h={reconnect} openBrief={()=>{}}/>);});
    expect(byTestID(tree,'thread-brief')[0].props.borderColor).toBe(theme.includes('stone')?'strongStroke':'needsYou');
    expect(byTestID(tree,'thread-objective')[0].props.numberOfLines).toBe(3);
    act(()=>tree.unmount());
  });
}
