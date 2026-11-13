import React from 'react';
import { WorkspaceSetup } from '@/ui/screens/onboarding/WorkspaceSetup';

/** Create a Workspace: the setup flow opened on its name, then invites and #general. */
export default function CreateWorkspace() {
  return <WorkspaceSetup route="/beeline/create-workspace" entry="create" />;
}
