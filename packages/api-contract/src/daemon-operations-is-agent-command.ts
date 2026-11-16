import { isOwnedModelCredential } from './helper-model.js';
import { AgentCommand } from './daemon-operations.js';



/** Shape validation only. Target matching and claiming happen before execution. */
export function isAgentCommand(value: unknown): value is AgentCommand {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  if (
    ![
      'id',
      'roomId',
      'agentId',
      'sourceMessageId',
      'turnRequestId',
      'rootCommandId',
      'rootSourceMessageId',
      'reason',
    ].every((key) => typeof c[key] === 'string' && (c[key] as string).length > 0)
  )
    return false;
  if (
    !['input', 'resume', 'restart'].includes(String(c.action)) ||
    !Number.isInteger(c.agentDepth) ||
    Number(c.agentDepth) < 0 ||
    Number(c.agentDepth) > 3
  )
    return false;
  if (c.offlineSeconds !== undefined && (typeof c.offlineSeconds !== 'number' ||
      !Number.isFinite(c.offlineSeconds) || c.offlineSeconds < 0)) return false;
  if (c.modelCredential !== undefined && !isOwnedModelCredential(c.modelCredential)) return false;
  for (const key of ['roomName', 'returnRoomName'])
    if (c[key] !== undefined && typeof c[key] !== 'string') return false;
  if (c.from !== undefined) {
    const from=c.from as Record<string,unknown> | null;
    if (!from || typeof from.agent!=='string' || typeof from.place!=='string') return false;
  }
  const source = c.source as Record<string, unknown> | undefined;
  return Boolean(
    source &&
    typeof source.id === 'string' &&
    typeof source.authorId === 'string' &&
    typeof source.body === 'string' &&
    typeof source.createdAt === 'number' &&
    Array.isArray(source.attachments),
  );
}
