import type { DiagnosticAck, DiagnosticBatch, DiagnosticDescriptor, DiagnosticEvent, DiagnosticStep } from './diagnostics.js';
import { installationIdentity } from './installation-identity.js';

type Store = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  removeItem(key: string): Promise<void>;
};
type Pending = { batch: Omit<DiagnosticBatch,'events'>; owner: string | null; events: DiagnosticEvent[] };
type Stored = { batch: Pending['batch']; owner: string | null; event: DiagnosticEvent };
const EVENT_KEY = 'beeline.diagnostics.event.v1:';
const IDLE = 30 * 60_000;

/** Uncapped persistent queue. Event/lifecycle driven; no retries, polling or intervals. */
export function createDiagnosticClient(input: {
  storage: Store; uuid(): string; descriptor: DiagnosticDescriptor; now?(): number;
  send(batch: DiagnosticBatch, authenticated: boolean, owner: string | null): Promise<DiagnosticAck>;
}) {
  const now = input.now ?? Date.now;
  const viewId = input.uuid();
  let pending: Pending[] = [], current: Pending | undefined;
  let owner: string | null = null, deviceId: string, lastAt = 0, sequence = 0;
  let chain: Promise<unknown> = Promise.resolve(), flight: Promise<void> | undefined;
  let persistent = true, initialized = false;
  const dirty=new Map<string,Stored>();
  const serial = <T>(work: () => Promise<T>) => {
    const result = chain.then(work,work); chain = result.catch(() => undefined); return result;
  };
  const ready = (async () => {
    try {
      deviceId = await installationIdentity(input.storage,input.uuid);
      const keys=(await input.storage.getAllKeys()).filter(k=>k.startsWith(EVENT_KEY));
      const groups=new Map<string,Pending>();
      for (const key of keys) {
        try {
          const record=JSON.parse(await input.storage.getItem(key) ?? 'null') as Stored | null;
          if (!record?.batch?.sessionId || !record.event || record.event.eventId!==key.slice(EVENT_KEY.length) ||
            (record.owner!==null && typeof record.owner!=='string')) throw new Error('invalid_local_event');
          let group=groups.get(record.batch.sessionId);
          if (!group) { group={batch:record.batch,owner:record.owner,events:[]};groups.set(record.batch.sessionId,group); }
          if(group.owner===null && record.owner!==null)group.owner=record.owner;
          if(group.owner!==null && record.owner!==null && group.owner!==record.owner)throw new Error('invalid_local_owner');
          group.events.push(record.event);
        } catch { persistent=false; }
      }
      pending=[...groups.values()];
      for(const item of pending)item.events.sort((a,b)=>a.sequence-b.sequence);
    } catch { deviceId ??= input.uuid(); persistent = false; }
    initialized=true;
  })();
  const persist = async () => {
    // Distinct event keys prevent concurrent browser views from replacing one another's queues.
    const writes=[...dirty.entries()];
    try {
      await Promise.all(writes.map(([id,record])=>input.storage.setItem(EVENT_KEY+id,JSON.stringify(record))));
      for(const [id,record] of writes)if(dirty.get(id)===record)dirty.delete(id);
    } catch { persistent = false; }
  };
  const start = () => {
    current = { owner, batch: { schemaVersion: 1, deviceId, sessionId: input.uuid(), viewId,
      bindingKey: input.uuid(), descriptor: input.descriptor }, events: [] };
    pending.push(current);
    append({ name: 'session_started', ...(persistent ? {} : { code: 'storage_unavailable' as const }) });
  };
  const mark=(item:Pending,event:DiagnosticEvent)=>dirty.set(event.eventId,{batch:item.batch,owner:item.owner,event});
  const append = (step: DiagnosticStep) => {
    const event={ ...step,eventId: input.uuid(),sequence: ++sequence,occurredAt: new Date(now()).toISOString() };
    current!.events.push(event);mark(current!,event);
  };
  const flush = (): Promise<void> => {
    if (flight) return flight;
    flight = (async () => {
      await ready;
      for (;;) {
        const item = await serial(async () => pending.find(p => p.events.length && (p.owner === owner || p.owner === null)));
        if (!item) return;
        const events = item.events.slice(0,32);
        const sendingOwner = item.owner;
        let ack: DiagnosticAck;
        try { ack = await input.send({ ...item.batch,events },sendingOwner !== null,sendingOwner); }
        catch { return; } // A real future event/connectivity change drives another attempt.
        const accepted = new Set(ack.accepted);
        if (!events.some(e => accepted.has(e.eventId))) return;
        await serial(async () => {
          // Never delete unacknowledged events or move an account's queued facts to another account.
          const removed=item.events.filter(e=>accepted.has(e.eventId));
          item.events = item.events.filter(e => !accepted.has(e.eventId));
          for(const event of removed)dirty.delete(event.eventId);
          try { await Promise.all(removed.map(e=>input.storage.removeItem(EVENT_KEY+e.eventId))); }
          catch { persistent=false; }
          if (sendingOwner !== null && item.owner === null) item.owner = sendingOwner;
          pending = pending.filter(p => p === current || p.events.length);
          await persist();
        });
      }
    })().finally(() => { flight = undefined; });
    return flight;
  };
  return {
    record: (step: DiagnosticStep) => serial(async () => {
      await ready;
      if (!current || now()-lastAt >= IDLE) start();
      append(step); lastAt = now(); await persist();
    }).then(() => { void flush(); }),
    identify: (identity: string | null, attemptId?: string) => serial(async () => {
      await ready;
      if (owner === identity) return;
      // First authentication claims only this runtime's anonymous session. An account switch rotates it.
      if (owner === null && identity !== null && current) { current.owner = identity;for(const event of current.events)mark(current,event); }
      else current = undefined;
      owner = identity;
      if (identity !== null && attemptId) {
        for (const item of pending) if (item.owner === null && item.events.some(e=>e.attemptId===attemptId)) { item.owner=identity;for(const event of item.events)mark(item,event); }
      }
      if (!current) start();
      append({ name: 'session_bound',outcome: identity ? 'success' : 'unknown' });
      lastAt=now();
      await persist();
    }),
    flush,
    contextNow: () => {
      if (!initialized) return undefined;
      if (!current || now()-lastAt >= IDLE) { start(); lastAt=now(); void serial(persist); }
      return { deviceId,sessionId:current!.batch.sessionId,viewId,actionId:input.uuid() };
    },
    context: () => serial(async () => {
      await ready; if (!current || now()-lastAt >= IDLE) { start(); lastAt=now(); await persist(); }
      return { deviceId,sessionId: current!.batch.sessionId,viewId,actionId: input.uuid() };
    }),
  };
}
