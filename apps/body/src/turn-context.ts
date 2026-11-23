import type { AgentCommand } from '@beeline/api-contract/daemon';
import { writePrivateFileAtomically } from './atomic-private-file.js';

/** The file the agent's tools read to learn which item they serve. */
export async function writeTurnContext(
  path: string,
  item:
    | Pick<
        AgentCommand,
        'id' | 'roomId' | 'turnRequestId' | 'rootCommandId' | 'reason' | 'operatorAgent'
      >
    | undefined,
  queued: readonly Pick<AgentCommand, 'turnRequestId' | 'rootCommandId' | 'reason'>[] = [],
  ownedModelDirectory?: string,
  invocation?: import('@beeline/api-contract/daemon').AgentInvocation,
): Promise<void> {
  await writePrivateFileAtomically(
    path,
    JSON.stringify(
      item
        ? {
            roomId: item.roomId,
            requestId: item.turnRequestId,
            taskId: item.rootCommandId,
            commandReason: item.reason,
            itemId: item.id,
            ...(item.operatorAgent ? { operatorAgent: true } : {}),
            commands: queued.map((command) => ({
              requestId: command.turnRequestId,
              commandReason: command.reason,
              taskId: command.rootCommandId,
            })),
            startedAt: Date.now(),
            ...(invocation ? { invocation } : {}),
            ...(ownedModelDirectory ? { ownedModelDirectory } : {}),
          }
        : {},
    ),
  );
}
