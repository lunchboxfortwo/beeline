/** Pi's existing provider transport, bound to the current claimed invocation.
 * No local proxy, request replay, provider rotation or execution deadline. */
import { readFileSync } from 'node:fs';
import type { streamSimple as OpenAIStream } from '@earendil-works/pi-ai/api/openai-completions';
import { openAICompletionsApi } from '@earendil-works/pi-ai/compat';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { OwnedModelFiles } from './owned-model-files.js';

// Use the host's embedded transport; compiled Pi does not expose API subpaths.
const streamSimple = openAICompletionsApi().streamSimple as typeof OpenAIStream;

type Provider = Parameters<typeof streamSimple>[0];
type Context = Parameters<typeof streamSimple>[1];
type Options = NonNullable<Parameters<typeof streamSimple>[2]>;
export default function install(pi: {
  registerProvider(
    name: string,
    configuration: {
      streamSimple: (
        model: Provider,
        context: Context,
        options?: Options,
      ) => ReturnType<typeof streamSimple>;
    },
  ): void;
}): void {
  pi.registerProvider('beeline', { streamSimple: ownedModelStream });
}
export function ownedModelStream(
  model: Provider,
  context: Context,
  options: Options = {},
): ReturnType<typeof streamSimple> {
  const active = JSON.parse(readFileSync(process.env.BEELINE_TURN_CONTEXT_FILE!, 'utf8')) as {
    generationId: string;
    ownedModelDirectory: string;
  };
  const owner = OwnedModelFiles.open(active.ownedModelDirectory);
  const binding = owner.binding();
  if (
    binding.generationId !== active.generationId ||
    model.provider !== 'beeline' ||
    model.baseUrl.replace(/\/$/, '') !== binding.baseUrl
  )
    throw new Error('Model request requires its current claimed invocation');
  const authorization = owner.prepareHeaders();
  const upstream = streamSimple(model, context, {
    ...options,
    maxRetries: 0,
    apiKey: options.apiKey ?? 'unused',
    headers: { ...options.headers,
      'x-beeline-model-invocation': authorization.authorization.slice('Bearer '.length),
      'x-beeline-model-request': authorization.requestId,
    },
  });
  const output = createAssistantMessageEventStream();
  let terminal = false;
  const fail = () => output.push({type:'error',reason:options.signal?.aborted ? 'aborted' : 'error',error:{
    role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
    stopReason:options.signal?.aborted ? 'aborted' : 'error',errorMessage:'Model result is unavailable; do not resubmit this request.',
  }});
  void (async () => {
    for await (const event of upstream) {
      if (event.type === 'error') {
        // The native provider preserves the server's JSON error body. Only a
        // signed, request-bound receipt can settle the private journal.
        const raw=event.error.errorMessage ?? '';
        try {
          const body=JSON.parse(raw.slice(raw.indexOf('{'))) as {error?:unknown;message?:unknown;signedReceipt?:unknown};
          const detail=(body.error && typeof body.error==='object' ? body.error : body) as typeof body;
          owner.confirmReceipt(detail.signedReceipt);
          if(typeof detail.message==='string')event.error.errorMessage=detail.message;
        } catch { /* Transport loss stays UNKNOWN; the helper never resubmits. */ }
      }
      if (event.type === 'done' && !owner.confirmReceipt(event.message.responseId)) {
        output.push({
          type: 'error',
          reason: 'error',
          error: {
            ...event.message,
            stopReason: 'error',
            errorMessage: 'Model outcome is unknown; do not resubmit this request.',
          },
        });
        output.end();
        return;
      }
      if(event.type==='done' || event.type==='error')terminal=true;
      output.push(event);
    }
    if(!terminal)fail();
    output.end();
  })().catch(() => { fail(); output.end(); });
  return output;
}
