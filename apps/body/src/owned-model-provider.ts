import { randomUUID } from 'node:crypto';
import type { streamSimple as OpenAIStream } from '@earendil-works/pi-ai/api/openai-completions';
import { openAICompletionsApi } from '@earendil-works/pi-ai/compat';

// Use the host's embedded transport; compiled Pi does not expose API subpaths.
const streamSimple = openAICompletionsApi().streamSimple as typeof OpenAIStream;

export default function install(pi: {
  registerProvider(
    name: string,
    configuration: { api: 'openai-completions'; streamSimple: typeof streamSimple },
  ): void;
}): void {
  pi.registerProvider('beeline', { api: 'openai-completions', streamSimple: ownedModelStream });
}

export const ownedModelStream: typeof streamSimple = (model, context, options) =>
  streamSimple(model, context, {
    ...options,
    maxRetries: 0,
    apiKey: process.env.BEELINE_FREE_AGENT_MODEL_TOKEN,
    headers: {
      ...options?.headers,
      'x-beeline-model-room': process.env.BEELINE_MODEL_ROOM_ID!,
      'x-beeline-model-request': randomUUID(),
    },
  });
