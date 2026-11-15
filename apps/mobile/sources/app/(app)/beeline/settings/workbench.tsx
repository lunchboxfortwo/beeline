import { PageLoader } from '@/ui/PageLoader';
import React, { useState } from 'react';
import { YStack } from 'tamagui';
import { router, useLocalSearchParams } from 'expo-router';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { useActiveCommunityId } from '@/buzz/use-active-community';
import { useSharedWorkbench } from '@/buzz/workbench-surface';
import { connectionViewState, useConnectCompanyApp } from '@/buzz/company-connection-actions';
import { ServiceMark } from '@/components/buzz/ServiceMark';
import { Section, T } from '@/ui/grammar';
import { ConnectorFrame, ConnectorLoading, ConnectorNote, ConnectorRow, ConnectorSearchField } from '@/ui/screens/settings/connectors/ConnectorParts';
import type { WorkbenchCompany } from '@beeline/api-contract/workbench';
import { ConnectorsSearchSheet } from './workbench/connect-app';

function first(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }
/** Connectors lists apps; logins and keys are Vault entries (build spec decision 24). */
const SECTIONS: readonly (readonly [string, string, readonly WorkbenchCompany['section'][]])[] = [
  ['attention', 'Needs attention', ['attention']],
  ['apps', 'Connected apps', ['apps']],
  ['vault', 'Vault', ['signin', 'keys']],
];

/** Owner-scoped server projection: the phone never groups or guesses provider identity. */
export default function WorkbenchScreen() {
  useLatencyRouteFrame('/beeline/settings/workbench');
  const params = useLocalSearchParams<{ workspaceId?: string | string[]; viewerId?: string | string[] }>();
  const activeWorkspaceId = useActiveCommunityId();
  const scope = { workspaceId: first(params.workspaceId) || activeWorkspaceId || '', viewerId: first(params.viewerId) ?? '' };
  const { value: view, error } = useSharedWorkbench(scope.viewerId ? scope : null);
  const index = view?.companies;
  const [searchOpen, setSearchOpen] = useState(false);
  const actions = useConnectCompanyApp(scope);
  return <>
    <ConnectorFrame title="Connectors" back={() => router.back()} backLabel="Back to Settings" scroll={Boolean(index)} scrollTestID="workbench-scroll">
      {!index && error ? <YStack padding="4"><ConnectorNote tone="danger">{error}</ConnectorNote></YStack> : !index ?
        <ConnectorLoading><PageLoader testID="workbench-loader" /></ConnectorLoading> : <>
          <ConnectorSearchField label="Search apps, keys, and logins" testID="connectors-search" onPress={() => setSearchOpen(true)} />
          {!index.hasConnections ? <YStack gap="3">
            <ConnectorNote>No connections yet. Choose a service to get started.</ConnectorNote>
            <Section title="Suggested">
              {index.suggestions.map((app, n) => <ConnectorRow key={app.providerId} title={app.name} description={app.purpose}
                leading={<ServiceMark company={app.providerName} domain={app.domain} mark={app.logo} />} value="Connect" chevron="right"
                disabled={Boolean(actions.busy)} onPress={() => void actions.connect(app)} last={n === index.suggestions.length - 1}
                testID={`connectors-suggest-${app.providerId}`} />)}
            </Section>
          </YStack> : SECTIONS.map(([key, title, sections]) => {
            const rows = index.rows.filter(row => sections.includes(row.section));
            return rows.length ? <Section key={key} title={title} testID={`connectors-${key}`}>
              {rows.map((row, n) => {
                const state = connectionViewState(row);
                return <ConnectorRow key={row.id} title={row.name}
                  description={state === 'error' && row.status ? `${row.status} · ${row.subtitle}` : row.subtitle}
                  descriptionContent={row.roomsClientId ? <AiClientSubtitle agent={view?.aiClients?.find(client => client.clientId === row.roomsClientId)?.agent?.name} /> : undefined}
                  leading={<ServiceMark company={row.name} domain={row.domain} mark={row.logo} />}
                  action={row.section === 'attention' ? 'Reconnect' : state === 'connect' ? 'Connect' : undefined}
                  value={state === 'error' ? row.status : state === 'connected' && row.kind === 'sign-in-service' ? row.status : undefined}
                  valueTone={state === 'error' ? 'danger' : undefined}
                  chevron="right" disabled={actions.busy === row.id} onPress={() => void actions.open(row, view?.apps)}
                  last={n === rows.length - 1} testID={`connectors-company-${row.id}`} />;
              })}
            </Section> : null;
          })}
          {actions.error ? <ConnectorNote tone="danger">{actions.error}</ConnectorNote> : null}
        </>}
    </ConnectorFrame>
    <ConnectorsSearchSheet visible={searchOpen} onClose={() => setSearchOpen(false)} scope={scope} view={view} />
  </>;
}
/** "Connected as <agent>", the agent name a step darker than the line. */
function AiClientSubtitle({ agent }: { agent?: string }) {
  return <T v="meta" color="secondary" numberOfLines={1}>{agent ? <>Connected as <T v="meta" color="ink">{agent}</T></> : 'Connected'}</T>;
}
