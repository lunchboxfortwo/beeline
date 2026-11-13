import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const profile = vi.hoisted(() => ({ value: null as any, args: [] as unknown[] }));
vi.mock('tamagui', async () => {
  const hosts = (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts() as Record<string, any>;
  hosts.Switch.Thumb = () => null;
  return hosts;
});
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, AccessibilityInfo: {} }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('expo-router', () => ({ router: { push: vi.fn(), navigate: vi.fn() } }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => undefined) }));
vi.mock('@/buzz/use-active-community', () => ({ useActiveCommunityId: () => 'w-active' }));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => ({ SurfaceGlyphLoader: (props: any) => React.createElement('SurfaceGlyphLoader', props) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: (props: any) => React.createElement('IdentityMark', props) }));
vi.mock('@/components/buzz/VoicePreviewPlayer', () => ({ VoicePreviewPlayer: () => null }));
vi.mock('./usage-cell', () => ({ USAGE_REFRESH_CLIENT_TIMEOUT_MS: 25_000, usageCell: () => ({ columns: [], note: 'Claude Code', muted: false }) }));
vi.mock('@/buzz/scheduled-work', () => ({ scheduleTitle: (s: any) => s.title, scheduleTrigger: () => 'Every hour' }));
vi.mock('@/buzz/corner-navigation', () => ({ navigateToRoom: vi.fn() }));
vi.mock('./useAgentProfile', () => ({ useAgentProfile: (...args: unknown[]) => { profile.args = args; return profile.value; } }));
import { AgentProfileScreen } from './AgentProfileScreen';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const byId = (tree: any, id: string): any => tree.root.findAll((node: any) => node.props.testID === id)[0];
const text = (tree: any) => tree.root.findAll((node: any) => node.type === 'Text' && typeof node.props.children === 'string').map((node: any) => node.props.children).join(' | ');

function detail(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'w',
    agent: { identity: { pubkey: 'alan', name: 'Alan', handle: 'alan', kind: 'agent', face: 'fox' }, role: 'member' },
    owner: { pubkey: 'me', name: 'Me', handle: 'lunchboxfortwo', kind: 'human' },
    catalog: [{ id: 'model', category: 'model', currentValue: 'claude-opus-5-5', options: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }] }],
    access: { policy: 'everyone', canChange: true, owner: { id: 'me', name: 'Me', handle: 'lunchboxfortwo' } },
    yolo: { enabled: false, canChange: true },
    schedules: [{ id: 's1', workspaceId: 'w', roomId: 'r1', agentId: 'alan', creatorId: 'me', cadence: { kind: 'interval', everyMinutes: 60 }, message: 'Check dependencies', title: 'Dependency check', nextRunAt: 2_000_000_000, createdAt: 1, runCount: 0 }],
    rooms: [{ id: 'r1', name: 'beeline' }, { id: 'r2', name: 'milo' }],
    watchFilters: [],
    ...overrides,
  };
}
function agent(overrides: Record<string, unknown> = {}) {
  return {
    detail: detail(), workspaceId: 'w', loading: false, error: null, busy: false, working: null,
    canEdit: true, canRemove: true, ownerByline: 'by @lunchboxfortwo', soul: 'Alan builds Beeline’s mobile app.',
    editing: false, nameDraft: 'Alan', soulDraft: 'Alan builds', setNameDraft: vi.fn(), setSoulDraft: vi.fn(),
    beginEdit: vi.fn(), cancelEdit: vi.fn(), saveEdit: vi.fn(), close: vi.fn(), message: vi.fn(),
    modelAxes: { model: undefined, effort: undefined, fast: undefined }, openModelAxis: null, closeModelAxis: vi.fn(),
    modelSearchQuery: '', setModelSearchQuery: vi.fn(), modelAppliesNote: null, modelAxisError: null,
    toggleModelAxis: vi.fn(), setModelOption: vi.fn(), setFastMode: vi.fn(), toggleAnswersEveryone: vi.fn(),
    toggleYolo: vi.fn(), removeAgent: vi.fn(), accessError: null, yoloError: null, refreshUsage: vi.fn(),
    saveWake: vi.fn(), voiceApi: undefined,
    ...overrides,
  };
}
async function render() {
  let tree: any;
  await act(async () => { tree = create(<AgentProfileScreen agentId="alan" close={vi.fn()} />); });
  return tree;
}
beforeEach(() => { profile.value = agent(); });

describe('agent profile', () => {
  it('reads the active workspace when none is given', async () => {
    await render();
    expect(profile.args.slice(0, 2)).toEqual(['alan', 'w-active']);
  });

  it('shows the 72 face, @handle, owner, Message and Edit, soul, model, access, schedules and chats', async () => {
    const tree = await render();
    const mark = tree.root.findAll((node: any) => node.type === 'IdentityMark')[0];
    expect(mark.props).toMatchObject({ kind: 'agent', size: 72, face: 'fox' });
    const content = text(tree);
    for (const label of ['@alan', 'owned by @lunchboxfortwo', 'Soul', 'Read full soul', 'Model / difficulty', 'Claude Opus 5.5', 'Usage', 'Voice', 'Access', 'Ask first', 'Everyone', 'Routines', 'Dependency check', 'Chats', '#beeline', '#milo'])
      expect(content).toContain(label);
    for (const cut of ['Recent work', 'Grants', 'Generate avatar', 'Skills'])
      expect(content).not.toContain(cut);
    expect(byId(tree, 'agent-profile-message')).toBeDefined();
    expect(byId(tree, 'edit-agent-soul')).toBeDefined();
    expect(byId(tree, 'agent-management')).toBeUndefined();
  });

  it('moves agent management into Edit: Answers everyone, Yolo with its copy, Remove from Workspace', async () => {
    profile.value = agent({ editing: true });
    const tree = await render();
    expect(byId(tree, 'agent-management')).toBeDefined();
    expect(byId(tree, 'agent-yolo-caption').props.children).toBe('Alan acts without stopping to ask. Two things still ask you: anything that names one of your credentials, and a script nobody has read.');
    act(() => byId(tree, 'agent-yolo-switch').props.onCheckedChange(true));
    expect(profile.value.toggleYolo).toHaveBeenCalledWith(true);
    act(() => byId(tree, 'agent-access-switch').props.onCheckedChange(false));
    expect(profile.value.toggleAnswersEveryone).toHaveBeenCalledWith(false);
    await act(async () => { byId(tree, 'remove-agent').props.onPress(); });
    expect(profile.value.removeAgent).toHaveBeenCalled();
    expect(byId(tree, 'edit-agent-soul')).toBeUndefined();
  });

  it('shows the running model and thinking level ahead of a saved next-session selection', async () => {
    profile.value = agent({ detail: detail({
      selected: { model: 'next-model', effort: 'low' },
      runtimeSelection: { model: 'running-model', effort: 'high' },
      catalog: [
        { id: 'model', category: 'model', currentValue: 'catalog-model', options: [{id:'running-model',name:'Running model'}] },
        { id: 'effort', category: 'reasoning_effort', currentValue: 'medium', options: [{id:'high',name:'High'}] },
      ],
    }) });
    const tree = await render();
    expect(byId(tree, 'model-axis-model').props.value).toBe('Running model');
    expect(byId(tree, 'model-axis-effort').props.value).toBe('High');
  });

  it('does not present a saved selection as a running model when the runtime has not reported', async () => {
    profile.value = agent({ detail: detail({ selected: {model:'next-model',effort:'high'},catalog:[] }) });
    const tree = await render();
    expect(byId(tree, 'model-axis-model').props.value).toBe('Not available');
    expect(byId(tree, 'model-axis-effort').props.value).toBe('Not available');
  });

  it('opens the model picker only while editing, and picks a model', async () => {
    const axis = { id: 'model', category: 'model', currentValue: 'claude-opus-5-5', options: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }, { id: 'gpt-5-5', name: 'GPT-5.5' }] };
    profile.value = agent({ modelAxes: { model: axis, effort: undefined, fast: undefined } });
    let tree = await render();
    expect(byId(tree, 'model-axis-model').props.onPress).toBeUndefined();
    profile.value = agent({ editing: true, modelAxes: { model: axis, effort: undefined, fast: undefined }, openModelAxis: 'model' });
    tree = await render();
    act(() => byId(tree, 'model-axis-model').props.onPress());
    expect(profile.value.toggleModelAxis).toHaveBeenCalledWith('model', true, axis);
    act(() => byId(tree, 'model-option-model-gpt-5-5').props.onPress());
    expect(profile.value.setModelOption).toHaveBeenCalledWith('model', 'gpt-5-5');
  });

  it('shows a non-owning manager only the removal', async () => {
    profile.value = agent({ canEdit: false });
    const tree = await render();
    expect(byId(tree, 'remove-agent')).toBeDefined();
    expect(byId(tree, 'agent-yolo')).toBeUndefined();
    expect(byId(tree, 'agent-usage')).toBeUndefined();
  });
});
