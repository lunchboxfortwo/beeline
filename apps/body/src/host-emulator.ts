import { HOST_EMULATOR_TARGET } from '@beeline/api-contract/agent-grants';

export const HOST_EMULATOR_RULE = `Emulators: request_grant(mode:request,action:"Use host emulator",kind:host,target:"${HOST_EMULATOR_TARGET}",reason,purpose); returns the existing shared emulator address without approval, or reports unavailable; never start one.`;
