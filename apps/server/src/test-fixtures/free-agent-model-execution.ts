import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  executeFreeAgentModel,
  type FreeAgentModelProxyOptions,
} from '../free-agent-model-proxy.js';
import { tokenHash } from '../free-agents.js';
import { commandOwnerLiveSql } from '../turn-ownership.js';
import { freeAgentModelTakesImages, imageInput } from '../free-agent-image-input.js';

/** Synthetic caller of the shared server-owned model execution leaf. Production
 * HTTP accepts only invocation credentials; this fixture keeps accounting,
 * payload, image and warning tests independent of retired bearer routing. */
export async function handleModelExecutionFixture(
  request: IncomingMessage,
  response: ServerResponse,
  _pathname: string,
  options: FreeAgentModelProxyOptions,
): Promise<boolean> {
  const header = request.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  const agent = token.startsWith('bfm_')
    ? (
        await options.database.query<{ agent_id: string; owner_id: string; model: string | null }>(
          `SELECT agent_id,owner_id,model FROM free_agents
           WHERE model_token_hash=$1 AND removed_at IS NULL AND state NOT IN ('failed','destroyed')`,
          [tokenHash(token)],
        )
      ).rows[0]
    : undefined;
  if (!agent) {
    sendJson(response, 401, { error: { message: 'invalid free agent model token' } });
    return true;
  }
  // Only the server-stored choice can select a model; request bodies cannot.
  options = {
    ...options,
    config: { ...options.config, model: agent.model ?? options.config.model },
  };
  let body: Record<string, unknown>;
  try {
    body = JSON.parse((await readBody(request)).toString('utf8')) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages))
      throw new Error('messages required');
    const hasImages = body.messages.some(
      (message) =>
        Array.isArray(message?.content) &&
        message.content.some((part: { type?: string }) => part?.type === 'image_url'),
    );
    imageInput(body, hasImages && (await freeAgentModelTakesImages(options.config.model)));
  } catch (error) {
    sendJson(response, 400, {
      error: { message: error instanceof Error ? error.message : 'invalid request' },
    });
    return true;
  }
  const turn = (
    await options.database.query<{
      id: string;
      generation_id: string | null;
      started: Date;
      room_id: string;
      turn_request_id: string;
    }>(
      `SELECT command.id,command.generation_id,command.room_id,command.turn_request_id,COALESCE(turn.started_at,command.claimed_at) started FROM agent_commands command LEFT JOIN agent_turns turn
       ON turn.agent_id=command.agent_id AND turn.room_id=command.room_id
         AND turn.request_id=command.turn_request_id
       WHERE command.agent_id=$1 AND command.state='claimed'
         AND command.action IN ('input','resume') AND ${commandOwnerLiveSql('command')}
       ORDER BY started DESC LIMIT 1`,
      [agent.agent_id],
    )
  ).rows[0];
  if (!turn) {
    sendJson(response, 403, { error: { message: 'free agent model access requires a live turn' } });
    return true;
  }
  return executeFreeAgentModel(response, body, agent, turn, options);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}
function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}
