import { join } from 'node:path';
import { atomicWrite } from '../../config.js';
import { Store, hash, id, json } from '../../store.js';
import type { Envelope } from '../../contracts.js';
import type { ExtensionAPI } from '../../extensions.js';
import type { RemoteAction } from './contracts.js';

export class RemoteActions {
  constructor(readonly provider:string,readonly storage:ExtensionAPI['storage'],readonly store:Store,readonly connection:()=>Promise<string>,readonly perform:(action:RemoteAction,signal:AbortSignal)=>Promise<unknown>){}
  private sources(context:Envelope):string[]{return [...new Set([...this.store.all<{source_id:string}>('SELECT source_id FROM run_sources WHERE run_id=?',context.runId).map(row=>row.source_id),...this.store.all<{id:string}>("SELECT id FROM messages WHERE run_id=? AND role='user'",context.runId).map(row=>row.id)])];}
  recover():void{
    for(const entry of this.storage.list('action:')){
      const action=entry.value as RemoteAction;
      if(action.status==='executing'||action.status==='pending'&&this.attempted(action.id))this.storage.set(entry.key,{...action,status:'uncertain'},this.dependencies(action.id));
    }
  }
  dependencies(actionId:string):string[]{return this.store.all<{source_id:string}>('SELECT source_id FROM storage_sources WHERE extension_id=? AND key=?',this.provider,`action:${actionId}`).map(row=>row.source_id);}
  private attempted(actionId:string):boolean{return !!this.store.get('SELECT hash FROM deletions WHERE hash=?',hash(`remote-action:${this.provider}:${actionId}`));}
  async prepare(kind:string,payload:Record<string,unknown>,context:Envelope,extraSources:string[]=[]):Promise<RemoteAction>{
    if(context.mode!=='foreground'||!context.source.trustedOwner||context.ownerId!==this.store.config.ownerId||context.instanceId!==this.store.config.instanceId)throw new Error('Remote actions require trusted retained owner foreground work');
    const open=this.storage.list('action:').filter(entry=>{const action=entry.value as RemoteAction;return action.status==='pending'&&action.expiresAt>Date.now();});
    if(open.length>=20)throw new Error('Too many pending remote actions; review or reject them first');
    const action:RemoteAction={id:id(),kind,payload,connection:await this.connection(),createdAt:Date.now(),expiresAt:Date.now()+15*60_000,status:'pending',digest:''};
    action.digest=hash(json({id:action.id,kind,payload,connection:action.connection,expiresAt:action.expiresAt}));
    this.storage.set(`action:${action.id}`,action,[...this.sources(context),...extraSources]);return action;
  }
  review(actionId:string):RemoteAction{
    const action=this.storage.get<RemoteAction>(`action:${actionId}`);if(!action)throw new Error('Remote action missing or its source was forgotten');
    if(action.digest!==hash(json({id:action.id,kind:action.kind,payload:action.payload,connection:action.connection,expiresAt:action.expiresAt})))throw new Error('Remote action integrity failure; prepare a fresh action');
    return action.status==='executing'||action.status==='pending'&&this.attempted(actionId)?{...action,status:'uncertain'}:action;
  }
  list(offset=0,limit=50):{actions:Pick<RemoteAction,'id'|'kind'|'status'|'createdAt'|'expiresAt'>[];total:number;nextOffset:number|null}{
    const total=this.store.get<{count:number}>("SELECT count(*) count FROM extension_storage WHERE extension_id=? AND key LIKE 'action:%'",this.provider)!.count;
    const rows=this.store.all<{key:string}>("SELECT key FROM extension_storage WHERE extension_id=? AND key LIKE 'action:%' ORDER BY json_extract(value,'$.createdAt') DESC,key LIMIT ? OFFSET ?",this.provider,limit,offset);
    return {actions:rows.map(row=>{const {id,kind,status,createdAt,expiresAt}=this.review(row.key.slice(7));return {id,kind,status,createdAt,expiresAt};}),total,nextOffset:offset+rows.length<total?offset+rows.length:null};
  }
  async approve(actionId:string,digest:string,decision:boolean,context:Envelope,signal:AbortSignal):Promise<RemoteAction>{
    if(context.source.channel!=='terminal'||!context.source.trustedOwner||context.mode!=='foreground'||context.ownerId!==this.store.config.ownerId||context.instanceId!==this.store.config.instanceId)throw new Error('Authenticated owner-terminal approval required');
    const action=this.review(actionId),sources=this.dependencies(actionId);
    if(action.digest!==digest||action.status!=='pending'||this.attempted(actionId))throw new Error('Changed, consumed or uncertain approval; never replayed');
    if(!decision){action.status='rejected';this.storage.set(`action:${actionId}`,action,sources);return action;}
    if(action.expiresAt<=Date.now())throw new Error('Remote approval expired; prepare a fresh action');
    if(action.connection!==await this.connection())throw new Error('Connection or permissions changed; prepare a fresh action');
    signal.throwIfAborted();
    const latest=this.review(actionId);
    if(latest.status!=='pending'||latest.digest!==action.digest||this.attempted(actionId))throw new Error('Consumed or uncertain approval; never replayed');
    action.status='executing';this.storage.set(`action:${actionId}`,action,sources);
    // Keep attempted IDs in the deletion ledger so restoring an older pending draft cannot resend it.
    this.store.run('INSERT OR REPLACE INTO deletions VALUES(?,?)',hash(`remote-action:${this.provider}:${actionId}`),Date.now());
    try{
      atomicWrite(join(this.store.root,'deletion-ledger.json'),json(this.store.all<{hash:string}>('SELECT hash FROM deletions').map(row=>row.hash)));
      action.result=await this.perform(action,signal);action.status='accepted';
    }catch(error){const status=(error as {status?:number}).status;action.status=status&&status>=400&&status<500&&![408,429].includes(status)?'rejected':'uncertain';action.result={error:action.status==='uncertain'?'Acceptance unknown; review the remote service before preparing another action':`Remote service rejected the action: HTTP ${status}`};}
    if(this.storage.get(`action:${actionId}`))this.storage.set(`action:${actionId}`,action,sources);
    return action;
  }
}
