import type { DiagnosticAck, DiagnosticBatch, DiagnosticDescriptor, DiagnosticEvent, DiagnosticStep } from './diagnostics.js';
import { installationIdentity } from './installation-identity.js';

type Store = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  removeItem(key: string): Promise<void>;
  multiRemove?(keys: readonly string[]): Promise<void>;
};
type Pending = { batch: Omit<DiagnosticBatch,'events'>; owner: string | null; events: DiagnosticEvent[] };
type Stored = { batch: Pending['batch']; owner: string | null; event: DiagnosticEvent };
const EVENT_KEY = 'beeline.diagnostics.event.v1:';
const IDLE = 30 * 60_000;
const MAX_EVENTS = 256;
const MAX_BYTES = 256 * 1024;

/** Bounded best-effort observations. Never compete with credentials or unsent messages. */
export function createDiagnosticClient(input: {
  storage: Store; uuid(): string; descriptor: DiagnosticDescriptor; now?(): number;
  send(batch: DiagnosticBatch, authenticated: boolean, owner: string | null): Promise<DiagnosticAck>;
}) {
  const now = input.now ?? Date.now;
  const viewId = input.uuid();
  let pending: Pending[] = [], current: Pending | undefined;
  let owner: string | null = null, deviceId: string, lastAt = 0, sequence = 0;
  let chain: Promise<unknown> = Promise.resolve(), flight: Promise<void> | undefined;
  let persistent = true, initialized = false, writable = true;
  const dirty=new Map<string,Stored>();
  const sizes=new Map<string,number>();
  const discarded=new Set<string>();
  let bytes=0;
  const forget=(id:string)=>{
    bytes-=sizes.get(id) ?? 0; sizes.delete(id); dirty.delete(id);
  };
  const mark=(item:Pending,event:DiagnosticEvent)=>{
    const record={batch:item.batch,owner:item.owner,event};
    // Three bytes per UTF-16 code unit bounds UTF-8 even for malformed local input.
    const size=JSON.stringify(record).length*3;
    bytes+=size-(sizes.get(event.eventId) ?? 0);sizes.set(event.eventId,size);
    if(writable)dirty.set(event.eventId,record);
  };
  const bound=()=>{
    while(sizes.size>MAX_EVENTS || bytes>MAX_BYTES){
      const item=pending.find(p=>p.events.length);
      if(!item)break;
      const event=item.events.shift()!;
      forget(event.eventId);discarded.add(event.eventId);persistent=false;
    }
    pending=pending.filter(p=>p===current || p.events.length);
  };
  const removeEvents=async(ids:readonly string[])=>{
    // A full legacy Android database can contain thousands of rows. Bound
    // native bridge handoffs as well as the retained data.
    for(let offset=0;offset<ids.length;offset+=128){
      const keys=ids.slice(offset,offset+128).map(id=>EVENT_KEY+id);
      if(input.storage.multiRemove)await input.storage.multiRemove(keys);
      else await Promise.all(keys.map(key=>input.storage.removeItem(key)));
    }
  };
  const removeDiscarded=async()=>{
    const ids=[...discarded];discarded.clear();
    await removeEvents(ids);
  };
  const serial = <T>(work: () => Promise<T>) => {
    const result = chain.then(work,work); chain = result.catch(() => undefined); return result;
  };
  const ready = (async () => {
    try {
      const keys=(await input.storage.getAllKeys()).filter(k=>k.startsWith(EVENT_KEY));
      // Free the old diagnostic backlog before even saving an installation ID:
      // the previous unbounded queue may already have filled Android SQLite.
      const kept=keys.slice(-MAX_EVENTS);
      for(const key of keys.slice(0,-MAX_EVENTS))discarded.add(key.slice(EVENT_KEY.length));
      if(discarded.size)persistent=false;
      await removeDiscarded();
      const groups=new Map<string,Pending>();
      for (const key of kept) {
        try {
          const record=JSON.parse(await input.storage.getItem(key) ?? 'null') as Stored | null;
          if (!record?.batch?.sessionId || !record.event || record.event.eventId!==key.slice(EVENT_KEY.length) ||
            (record.owner!==null && typeof record.owner!=='string')) throw new Error('invalid_local_event');
          let group=groups.get(record.batch.sessionId);
          if (!group) { group={batch:record.batch,owner:record.owner,events:[]};groups.set(record.batch.sessionId,group); }
          if(group.owner===null && record.owner!==null)group.owner=record.owner;
          if(group.owner!==null && record.owner!==null && group.owner!==record.owner)throw new Error('invalid_local_owner');
          group.events.push(record.event);mark(group,record.event);
        } catch { persistent=false;discarded.add(key.slice(EVENT_KEY.length)); }
      }
      pending=[...groups.values()];
      for(const item of pending)item.events.sort((a,b)=>a.sequence-b.sequence);
      bound();await removeDiscarded();
      deviceId = await installationIdentity(input.storage,input.uuid);
    } catch { deviceId ??= input.uuid(); persistent = false;writable=false;dirty.clear(); }
    initialized=true;
  })();
  const persist = async () => {
    bound();
    try { await removeDiscarded(); } catch { persistent=false; }
    if(!writable)return;
    // Distinct event keys prevent concurrent browser views from replacing one another's queues.
    const writes=[...dirty.entries()];
    try {
      const results=await Promise.allSettled(writes.map(([id,record])=>input.storage.setItem(EVENT_KEY+id,JSON.stringify(record))));
      if(results.some(result=>result.status==='rejected'))throw new Error('diagnostic_storage_unavailable');
      for(const [id,record] of writes)if(dirty.get(id)===record)dirty.delete(id);
    } catch {
      // Stop retrying every dirty row on every action after SQLITE_FULL. Keep
      // bounded memory observations deliverable and reclaim only diagnostics.
      persistent=false;writable=false;dirty.clear();
      try { await removeEvents([...sizes.keys()]); }
      catch { /* A storage failure never reaches the Room or its live socket. */ }
    }
  };
  const start = () => {
    current = { owner, batch: { schemaVersion: 1, deviceId, sessionId: input.uuid(), viewId,
      bindingKey: input.uuid(), descriptor: input.descriptor }, events: [] };
    pending.push(current);
    append({ name: 'session_started', ...(persistent ? {} : { code: 'storage_unavailable' as const }) });
  };
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
          // This acknowledgement deletes only accepted IDs. Retained facts
          // never move from one account to another.
          const removed=item.events.filter(e=>accepted.has(e.eventId));
          item.events = item.events.filter(e => !accepted.has(e.eventId));
          for(const event of removed)forget(event.eventId);
          try { await removeEvents(removed.map(e=>e.eventId)); }
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
