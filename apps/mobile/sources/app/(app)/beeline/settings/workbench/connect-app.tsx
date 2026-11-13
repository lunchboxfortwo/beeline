import React, { useEffect, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { Input, ScrollView, XStack, YStack } from 'tamagui';
import { Search } from 'lucide-react-native';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import type { WorkbenchAppSearchResult } from '@beeline/api-contract/workbench';
import { ServiceMark } from '@/components/buzz/ServiceMark';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { useSharedWorkbench, type WorkbenchScope } from '@/buzz/workbench-surface';
import { useConnectCompanyApp } from '@/buzz/company-connection-actions';
import type { WorkbenchView } from '@/buzz/workbench';
import { INSTAGRAM_SIGN_IN_REQUIREMENT } from '@/buzz/app-sign-in-copy';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { Glyph, Section, SheetFrame } from '@/ui/grammar';
import { ConnectorFrame, ConnectorNote, ConnectorRow } from '@/ui/screens/settings/connectors/ConnectorParts';

function SearchContent({ scope, view, initialQuery = '', onNavigate }: {
  scope: WorkbenchScope; view: WorkbenchView | null; initialQuery?: string; onNavigate?: () => void;
}) {
  const [showOther, setShowOther] = useState(false);
  const [query, setQuery] = useState(initialQuery);
  const [response, setResponse] = useState<{ query: string; rows: WorkbenchAppSearchResult }>({ query: '', rows: [] });
  const [error, setError] = useState<string | null>(null);
  const actions = useConnectCompanyApp(scope);
  const input = query.trim();
  useEffect(() => {
    if (!input) return;
    let live = true;
    void getWorkbenchSource().searchApps({ query: input }).then(rows => {
      if (live) { setResponse({ query: input, rows }); setError(null); }
    }, () => { if (live) { setResponse({ query: input, rows: [] }); setError('App search is unavailable right now'); } });
    return () => { live = false; };
    // Workbench invalidation refreshes in place and cancels any older answer.
  }, [input, view]);
  const results: WorkbenchAppSearchResult = input ? response.query === input ? response.rows : []
    : (view?.companies?.suggestions ?? []).map(company => ({ appKey: company.appKey, name: company.name,
      domain: company.domain, description: company.purpose, company, mark: company.logo }));
  const other = input && results.length === 1 && results[0]?.company?.flow === 'app' && results[0].company.alternativeRoutes?.length ? results[0].company : null;
  return <YStack gap="4">
    <XStack gap="2" alignItems="center">
      <Glyph icon={Search} />
      <Input flex={1} minWidth={0} size="md" borderColor="strongStroke" aria-label="Search connections" accessibilityLabel="Search connections"
        testID="connect-app-input" autoCapitalize="none" autoCorrect={false} placeholder="Search apps, keys, and logins"
        value={query} onChangeText={setQuery} />
    </XStack>
    {results.some(item => item.company?.appKey === 'instagram') ? <ConnectorNote>{INSTAGRAM_SIGN_IN_REQUIREMENT}</ConnectorNote> : null}
    {results.length ? <Section title={input ? 'Search results' : 'Suggested'}>
      {results.map((item, n) => <ConnectorRow key={item.companyId ?? item.company?.providerId ?? item.appKey}
        title={item.name} description={item.description} leading={<ServiceMark company={item.name} domain={item.domain} mark={item.mark} />}
        chevron="right" disabled={Boolean(actions.busy)} last={!other && n === results.length - 1} testID={`connect-app-${item.appKey}`} onPress={() => {
          const row = item.companyId ? view?.companies?.rows.find(company => company.id === item.companyId) : undefined;
          if (row) { onNavigate?.(); void actions.open(row, view?.apps); }
          else if (item.companyId) {
            onNavigate?.(); router.push({ pathname: '/beeline/settings/workbench/service', params: { ...scope, service: item.companyId } } as Href);
          } else if (item.company) void actions.connect(item.company);
        }} />)}
      {other ? <ConnectorRow title="Other sign-in or Trusty Squire" chevron={showOther ? 'up' : 'down'} onPress={() => setShowOther(open => !open)}
        last={!showOther} testID="connectors-other-ways" /> : null}
      {other && showOther ? other.alternativeRoutes!.map((route, n) => <ConnectorRow key={route} title={route === 'composio' ? 'Sign in another way' : 'Use Trusty Squire'} chevron="right"
        disabled={Boolean(actions.busy)} last={n === other.alternativeRoutes!.length - 1} onPress={() => void actions.connect({ ...other, preferredRoute: route })} />) : null}
    </Section> : null}
    {input && response.query === input && !results.length && !error ? <ConnectorNote testID="connect-app-empty">No connections found. Trusty Squire can connect to a website for you.</ConnectorNote> : null}
    {error || actions.error ? <ConnectorNote tone="danger">{(error ?? actions.error)!}</ConnectorNote> : null}
  </YStack>;
}

export function ConnectorsSearchSheet({ visible, onClose, scope, view }: {
  visible: boolean; onClose: () => void; scope: WorkbenchScope; view: WorkbenchView | null;
}) {
  const { height } = useWindowDimensions();
  return <SheetFrame open={visible} close={onClose} title="Search" testID="connectors-search-sheet">
    {visible ? <ScrollView maxHeight={Math.round(height * 0.7)} keyboardShouldPersistTaps="handled">
      <SearchContent scope={scope} view={view} onNavigate={onClose} />
    </ScrollView> : null}
  </SheetFrame>;
}
/** Existing deep-link/search flow stays available; the list itself opens the shared search sheet. */
export default function ConnectAppScreen() {
  useLatencyRouteFrame('/beeline/settings/workbench/connect-app');
  const params = useLocalSearchParams<{ workspaceId?: string; viewerId?: string; query?: string }>();
  const scope = { workspaceId: params.workspaceId ?? '', viewerId: params.viewerId ?? '' };
  const { value: view, error } = useSharedWorkbench(scope.viewerId ? scope : null);
  return <ConnectorFrame title="Search" back={() => router.back()} backLabel="Back to Connectors" scrollTestID="connect-app-scroll">
    {error ? <ConnectorNote tone="danger">Connections are unavailable right now</ConnectorNote> : null}
    <SearchContent scope={scope} view={view} initialQuery={params.query} />
  </ConnectorFrame>;
}
