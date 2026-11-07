import { DIAGNOSTIC_UUID } from './diagnostics.js';
type Store = { getItem(key:string):Promise<string|null>;setItem(key:string,value:string):Promise<void> };
const identities=new WeakMap<Store,Promise<string>>();
/** Funnel and diagnostics in one runtime cannot race to create different installation ids. */
export function installationIdentity(storage:Store,uuid:()=>string):Promise<string> {
  const existing=identities.get(storage);if(existing)return existing;
  const promise=(async()=>{
    const saved=await storage.getItem('beeline.funnel.install.v1');
    if(saved && DIAGNOSTIC_UUID.test(saved))return saved;
    const id=uuid();await storage.setItem('beeline.funnel.install.v1',id);return id;
  })();
  identities.set(storage,promise);
  void promise.catch(()=>identities.delete(storage));
  return promise;
}
