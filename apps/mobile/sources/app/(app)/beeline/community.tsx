import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { WorkspaceSetup, type SetupEntry } from '@/ui/screens/onboarding/WorkspaceSetup';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Where a person arrives with no Workspace (you → workspace → create →
 * invite → #general), and where the sidebar's + leads everyone else: Create
 * a Workspace, or Join with an invite link. An invite deep link never
 * reaches this screen: it goes straight to its own confirmation.
 */
export default function WorkspaceChoice() {
  const params = useLocalSearchParams<{ mode?: string | string[]; step?: string | string[] }>();
  const entry: SetupEntry = first(params.step) === 'create' ? 'create' : first(params.mode) === 'join' ? 'join' : 'workspace';
  return <WorkspaceSetup route="/beeline/community" entry={entry} />;
}
