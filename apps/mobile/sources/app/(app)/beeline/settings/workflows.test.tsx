import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import { RoomViewHttpError } from '@beeline/buzz-client';

const controls = vi.hoisted(() => ({ room: vi.fn(), operation: vi.fn() }));
vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { View:host('View'), Text:host('Text'), ScrollView:host('ScrollView'), TouchableOpacity:host('TouchableOpacity') };
});
vi.mock('expo-router', () => ({
  router: { replace:vi.fn(), back:vi.fn() },
  useLocalSearchParams: () => ({roomId:'room-1'}),
  useFocusEffect: (effect:()=>void) => React.useEffect(effect,[effect]),
}));
vi.mock('react-native-safe-area-context', () => ({useSafeAreaInsets:()=>({top:0,bottom:0})}));
vi.mock('@/utils/responsive', () => ({useIsDesktop:()=>false}));
vi.mock('@/buzz/latency-route-hook', () => ({useLatencyRouteFrame:()=>undefined}));
vi.mock('@/auth/buzz-identity-storage', () => ({loadBuzzIdentity:async()=>({publicKey:'viewer'}),getEffectiveRelayUrl:async()=>'https://relay.test'}));
vi.mock('@/sync/transport/room-view-client', () => ({RoomViewClient:class { room=controls.room; }}));
vi.mock('@/sync/transport/monolith-operation', () => ({monolithPhoneOperation:controls.operation}));
vi.mock('@/constants/Typography', () => ({Typography:{default:()=>({})}}));
vi.mock('@/components/buzz/PageHeader', () => ({PageHeader:()=>null}));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => ({SurfaceGlyphLoader:()=>null}));
vi.mock('@/components/buzz/ChevronGlyph', () => ({ChevronGlyph:()=>null,CHEVRON_ROW_SIZE:16}));
vi.mock('@/components/buzz/SettingsRow', () => ({SettingsRow:(props:any)=>React.createElement('SettingsRow',props)}));
vi.mock('@/modal/ModalManager', () => ({Modal:{confirm:vi.fn()}}));

import RoomWorkflows from './workflows';

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  controls.room.mockReset().mockResolvedValue({viewer:{permissions:{manage:true}},repositoryResolution:'repository',room:{name:'beeline'}});
  controls.operation.mockReset().mockResolvedValue({workflows:[],defaultBranch:'main'});
});

it.each([
  ['network',new RoomViewHttpError(504,'surface_request_timed_out'),'',undefined],
  ['server refusal',Object.assign(new Error('Workspace admins only'),{status:403}),'Workspace admins only',undefined],
  ['unknown',new Error('opaque_diagnostic'),'',undefined],
])('R2: %s failed reads never add a local Retry; server refusals keep their reason', async (_kind,reason,title,description) => {
  controls.room.mockRejectedValueOnce(reason);
  let tree:any;
  try {
    await act(async()=>{tree=create(<RoomWorkflows />);});
    const rows=tree.root.findAllByType('SettingsRow');
    if (title) {
      expect(rows).toHaveLength(1);
      expect(rows[0].props.title).toBe(title);
      expect(rows[0].props.description).toBe(description);
      expect(rows[0].props.action).toBeUndefined();
      expect(rows[0].props.onPress).toBeUndefined();
    } else expect(rows).toHaveLength(0);
    expect(controls.room).toHaveBeenCalledTimes(1);
  } finally { if(tree) await act(async()=>tree.unmount()); }
});
