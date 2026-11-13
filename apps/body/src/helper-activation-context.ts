import type { CommandActivationInput,CommandActivationSnapshot,CommandActivationSource } from '@beeline/api-contract/helper-activation';

export interface ActivationTransport {
  /** Independent negotiated source; capability loss cannot select legacy. */
  scope():{origin:string;source:CommandActivationSource;generation:number}|undefined;
  machine():boolean;
  ready():Promise<void>;
  read(input:CommandActivationInput):Promise<CommandActivationSnapshot>;
}

/** One in-memory setup value for the actual claimed command. It is keyed by
 * the authenticated origin and the durable command generation, never by the
 * socket that carried the request: a reconnect keeps a pending or settled
 * capture. Concurrent setup helpers join one capture; a refused capture is not
 * kept, so the next setup step asks again. No payload is persisted in the
 * command context file, runtime journal or provider cache. */
export class CommandActivationContext {
  private held?:{key:string;origin:string;result:Promise<CommandActivationSnapshot>};
  constructor(private readonly transport:ActivationTransport,private readonly now=()=>Date.now()/1000){}
  async read(input:Omit<CommandActivationInput,'source'>):Promise<CommandActivationSnapshot|undefined>{
    let scope=this.transport.scope();
    if(!scope){
      if(!this.transport.machine())return undefined;
      await this.transport.ready();
      scope=this.transport.scope();
      if(!scope)throw new Error('Activation capability unavailable');
    }
    const origin=scope.origin;
    const key=JSON.stringify([origin,input.agentId,input.workspaceId,input.roomId,input.commandId,input.generationId]);
    if(this.held?.key!==key){
      // The wire request names the socket it travels on; the answer does not depend on it.
      const held={key,origin,result:undefined as unknown as Promise<CommandActivationSnapshot>};
      held.result=this.transport.read({...input,source:scope.source}).then(snapshot=>{
        if(this.held!==held||snapshot.v!==1||snapshot.agentId!==input.agentId||snapshot.workspaceId!==input.workspaceId||
          snapshot.roomId!==input.roomId||snapshot.commandId!==input.commandId||snapshot.generationId!==input.generationId)
          throw new Error('Activation command ownership changed');
        return snapshot;
      },error=>{
        if(this.held===held)this.held=undefined;
        throw error;
      });
      this.held=held;
    }
    // Expiry is a refusal, never a new admission or observation timer.
    const held=this.held!;
    return held.result.then(snapshot=>{
      const current=this.transport.scope();
      if(this.held!==held||(current&&current.origin!==held.origin))throw new Error('Activation command ownership changed');
      if(snapshot.validUntil!==undefined&&snapshot.validUntil<=this.now())throw new Error('Activation grant context expired');
      return snapshot;
    });
  }
}
