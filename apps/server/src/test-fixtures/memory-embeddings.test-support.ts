import { afterEach, vi } from 'vitest';
import { OPENROUTER_EMBEDDINGS_URL } from '../institutional-memory-embeddings.js';

export const memoryConcept = (axis: number) => Array.from({ length: 1024 }, (_, i) => Number(i === axis));

/** Explicit semantic fixtures for authority/lifecycle tests, with no provider calls. */
export function stubMemoryEmbeddings(vectors: Record<string, number[]> = {}, fallback = memoryConcept(0), forward?: typeof fetch): void {
  vi.stubEnv('OPENROUTER_EMBEDDING_API_KEY', 'test-key');
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) !== OPENROUTER_EMBEDDINGS_URL) {
      if (forward) return forward(url, init);
      throw new Error('Unexpected test request');
    }
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(JSON.stringify({ data: body.input.map((text, index) => ({
      index, embedding: vectors[text] ?? fallback,
    })) }), { headers: { 'content-type': 'application/json' } });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
