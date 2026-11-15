import React,{useCallback,useEffect,useMemo,useState,useSyncExternalStore} from 'react';
import {router,usePathname} from 'expo-router';
import {YStack} from 'tamagui';
import {isWorkspaceListView} from '@beeline/buzz-client';
import {getEffectiveRelayUrl,loadBuzzIdentity} from '@/auth/buzz-identity-storage';
import {saveActiveCommunityId} from '@/buzz/community-storage';
import {useActiveCommunityId} from '@/buzz/use-active-community';
import {mobileSurfaceCache,surfaceAddress} from '@/buzz/surface-storage';
import {useSurfaceSnapshot} from '@/buzz/use-shared-surface';
import {workspaceRailItem} from '@/buzz/room-view-presentation';
import {clientResetGeneration,subscribeClientReset} from '@/sync/client-reset';
import {BuzzCommunityShell} from '@/components/buzz/CommunityRail';
import {useIsDesktop} from '@/utils/responsive';
import {TabHeaderHost} from './TabHeader';
import {TAB_ROUTES,isTabRootPath,tabForPath} from './tab-routes';
import {PhoneTabBar,SharedTabBarHeight} from './PhoneTabScreen';

/** Mounted above the phone stack, so changing tabs cannot reload its name. */
export function WorkspaceTabShell({children}:{children:React.ReactNode}) {
    const desktop=useIsDesktop();
    return desktop ? <>{children}</> : <PhoneWorkspaceShell>{children}</PhoneWorkspaceShell>;
}

function PhoneWorkspaceShell({children}:{children:React.ReactNode}) {
    const pathname=usePathname();
    const active=useActiveCommunityId();
    const reset=useSyncExternalStore(subscribeClientReset,clientResetGeneration);
    const [scope,setScope]=useState<{relay:string;viewer:string;reset:number}|null>(null);
    useEffect(()=>{
        let cancelled=false;
        void Promise.all([loadBuzzIdentity(),getEffectiveRelayUrl()]).then(([identity,relay])=>{
            if(!cancelled) setScope(identity?{relay,viewer:identity.publicKey,reset}:null);
        }).catch(()=>undefined);
        return ()=>{cancelled=true;};
    },[reset]);
    const address=useMemo(()=>scope?.reset===reset
        ? surfaceAddress(scope.relay,scope.viewer,'/workspaces') : null,[scope,reset]);
    const list=useSurfaceSnapshot(address,isWorkspaceListView);
    useEffect(()=>{if(address)void mobileSurfaceCache.read(address,isWorkspaceListView).catch(()=>undefined);},[address]);
    const communities=useMemo(()=>list?.workspaces.map(workspaceRailItem)??[],[list]);
    const workspace=list?.workspaces.find(item=>item.id===active);
    const select=useCallback((id:string|null)=>{
        if(!id||!scope)return;
        void saveActiveCommunityId(scope.viewer,id);
        const tab=tabForPath(pathname)??'chats';
        router.replace({pathname:TAB_ROUTES[tab],params:tab==='settings'?{workspaceId:id}:{communityId:id}} as never);
    },[scope,pathname]);
    const root=isTabRootPath(pathname);
    // A hidden bar measures zero; the roots under a pushed page keep their space.
    const [bar,setBar]=useState(0);
    return <BuzzCommunityShell communities={communities} activeCommunityId={active??null} onSelect={select}
        onAdd={()=>router.push('/beeline/community')}>
        <YStack flex={1} minHeight={0}>
            <SharedTabBarHeight.Provider value={bar}>
                <TabHeaderHost workspaceName={workspace?.name??''} visible={root}>{children}</TabHeaderHost>
            </SharedTabBarHeight.Provider>
            {/* One bar over the four tab roots: switching tabs never remounts it. */}
            <YStack position="absolute" left={0} right={0} bottom={0} display={root?'flex':'none'}
                onLayout={event=>{const height=event.nativeEvent.layout.height;if(height>0)setBar(height);}} testID="shared-tab-bar">
                <PhoneTabBar active={tabForPath(pathname)??'chats'}/>
            </YStack>
        </YStack>
    </BuzzCommunityShell>;
}
