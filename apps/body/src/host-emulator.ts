import { HOST_EMULATOR_TARGET } from '@beeline/api-contract/agent-grants';

export const HOST_EMULATOR_RULE = `Emulators: request_grant(mode:request,action:"Use host emulator",kind:host,target:"${HOST_EMULATOR_TARGET}",reason,purpose); Allow: repeat for address or report unavailable/refused; never start one.`;
