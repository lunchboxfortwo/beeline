import React from 'react';
import { SettingsScreen } from '@/ui/screens/settings/SettingsScreen';

/**
 * Workspace settings now live in the Settings screen's workspace tab. Old
 * links render that same screen with the tab selected, without another navigation.
 */
export default function WorkspaceSettingsRoute() {
  return <SettingsScreen initialScope="workspace" />;
}
