import { subscribeClientReset } from '@/sync/client-reset';
import { CHAT_LINK_TOKEN_LIMIT, type ChatLinkView, type ChatLinksView } from '@beeline/api-contract/phone';

/**
 * What the server said one `↳thread` / `¶author-N` token in one chat points
 * to. `null` means it resolved to nothing, so the token stays plain text.
 * A failed read is not an answer: the token stays unknown and is asked again.
 * The server owns the answer (`resolveChatLinks`); this only remembers it for
 * the session and batches the asks, one read per chat per frame.
 */
export type ChatLinkEntry = ChatLinkView | null;

export type ChatLinkResolver = (roomId: string, tokens: readonly string[]) => Promise<ChatLinksView>;

export type ChatLinkStore = {
  /** The answer for one token's key, or undefined while unknown. */
  read(roomId: string, key: string): ChatLinkEntry | undefined;
  /** Ask the server about a token written in this chat, once per session. */
  request(roomId: string, token: { readonly text: string; readonly key: string }): void;
  /** Ask again about tokens whose last read failed, e.g. after reconnect. */
  retryFailed(): void;
  /** Forget every answer and drop answers still in flight (account change). */
  reset(): void;
  subscribe(listener: () => void): () => void;
};

export function createChatLinkStore(
  resolve: ChatLinkResolver,
  schedule: (flush: () => void) => void = (flush) => { void Promise.resolve().then(flush); },
): ChatLinkStore {
  const entries = new Map<string, ChatLinkEntry>();
  const asked = new Set<string>();
  const queued = new Map<string, Map<string, string>>();
  // Tokens whose read failed. They stay unknown (plain text), not no-match,
  // so a reconnect or a later request asks again.
  const failed = new Map<string, { roomId: string; key: string; text: string }>();
  const listeners = new Set<() => void>();
  let flushScheduled = false;
  let generation = 0;
  const id = (roomId: string, key: string) => `${roomId}\0${key}`;
  const notify = () => { for (const listener of [...listeners]) listener(); };

  const enqueue = (roomId: string, key: string, text: string) => {
    const entryId = id(roomId, key);
    if (asked.has(entryId)) return;
    asked.add(entryId);
    failed.delete(entryId);
    let tokens = queued.get(roomId);
    if (!tokens) queued.set(roomId, tokens = new Map());
    tokens.set(key, text);
    if (flushScheduled) return;
    flushScheduled = true;
    schedule(flush);
  };

  const flush = () => {
    flushScheduled = false;
    const batches = [...queued.entries()];
    queued.clear();
    const started = generation;
    for (const [roomId, tokens] of batches) {
      const all = [...tokens.entries()];
      for (let start = 0; start < all.length; start += CHAT_LINK_TOKEN_LIMIT) {
        const slice = all.slice(start, start + CHAT_LINK_TOKEN_LIMIT);
        resolve(roomId, slice.map(([, text]) => text)).then(
          (view) => {
            // An answer read for the previous account is dropped.
            if (started !== generation) return;
            const byKey = new Map(view.links.map((link) => [link.key, link]));
            for (const [key] of slice) entries.set(id(roomId, key), byKey.get(key) ?? null);
            notify();
          },
          () => {
            if (started !== generation) return;
            for (const [key, text] of slice) {
              const entryId = id(roomId, key);
              asked.delete(entryId);
              failed.set(entryId, { roomId, key, text });
            }
          },
        );
      }
    }
  };

  return {
    read: (roomId, key) => entries.get(id(roomId, key)),
    request: (roomId, token) => enqueue(roomId, token.key, token.text),
    retryFailed() {
      for (const { roomId, key, text } of [...failed.values()]) enqueue(roomId, key, text);
    },
    reset() {
      generation += 1;
      entries.clear();
      asked.clear();
      queued.clear();
      failed.clear();
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

let shared: ChatLinkStore | null = null;

/** The app's one store, reading through the main live connection. */
export function sharedChatLinkStore(): ChatLinkStore {
  if (shared) return shared;
  const store = createChatLinkStore(async (roomId, tokens) => {
    const [{ loadBuzzIdentity, getEffectiveRelayUrl }, { RoomViewClient }] = await Promise.all([
      import('@/auth/buzz-identity-storage'),
      import('@/sync/transport/room-view-client'),
    ]);
    const identity = await loadBuzzIdentity();
    if (!identity) return { links: [] };
    return new RoomViewClient({ identity, baseUrl: await getEffectiveRelayUrl() }).resolveChatLinks(roomId, tokens);
  });
  // Answers belong to one account; a reconnect retries failed reads.
  subscribeClientReset(() => store.reset());
  void import('@/sync/transport/live-connection').then(({ sharedLiveConnection }) => {
    sharedLiveConnection().subscribeConnected(() => store.retryFailed());
  });
  return shared = store;
}
