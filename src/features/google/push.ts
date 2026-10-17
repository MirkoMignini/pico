import { createSign } from 'node:crypto';
import type { ExtensionAPI } from '../../extensions.js';
import type { OAuthAccount } from '../integrations/oauth.js';
import { responseJson, requestSignal } from '../integrations/http.js';
import type { GoogleSettings } from './settings.js';
import { SCOPES } from './settings.js';

interface ServiceKey {type:string;client_email:string;private_key:string}
interface Watch {expiration:string;historyId:string}
interface PushMessage {ackId:string;message:{data:string}}
export class GmailPush {
  private controller?:AbortController;
  private task?:Promise<void>;
  private subscriber?:{access:string;expires:number};
  status='disabled';
  constructor(readonly pico:ExtensionAPI,readonly account:OAuthAccount,readonly config:NonNullable<GoogleSettings['mail']['push']>,readonly email:string,readonly synchronize:(historyId:string,signal:AbortSignal)=>Promise<boolean>){}
  private async token(signal:AbortSignal):Promise<string>{
    if(this.subscriber&&this.subscriber.expires>Date.now()+60_000)return this.subscriber.access;
    const raw=await this.pico.credentials.secret('extensions.google.subscriber');if(!raw)throw new Error('Pub/Sub subscriber credentials missing');
    const key=JSON.parse(raw) as ServiceKey;
    if(key.type!=='service_account'||!/^[-a-z0-9]+@[-a-z0-9]+\.iam\.gserviceaccount\.com$/.test(key.client_email)||!key.private_key)throw new Error('Invalid subscriber service account');
    const now=Math.floor(Date.now()/1000),head=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url'),claims=Buffer.from(JSON.stringify({iss:key.client_email,scope:'https://www.googleapis.com/auth/pubsub',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})).toString('base64url');
    const input=`${head}.${claims}`,signature=createSign('RSA-SHA256').update(input).sign(key.private_key).toString('base64url');
    const grant=await responseJson<{access_token:string;expires_in:number}>(await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${input}.${signature}`}),redirect:'error',signal:requestSignal(signal)}),64_000);
    if(!grant.access_token||!Number.isFinite(grant.expires_in)||grant.expires_in<=0)throw new Error('Invalid subscriber token');
    this.subscriber={access:grant.access_token,expires:Date.now()+grant.expires_in*1000};return grant.access_token;
  }
  private async pubsub<T>(method:string,body:unknown,signal:AbortSignal):Promise<T>{
    const token=await this.token(signal);
    const result=await responseJson<T>(await fetch(`https://pubsub.googleapis.com/v1/${this.config.subscription}:${method}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:requestSignal(signal,60_000)}),1_000_000);
    signal.throwIfAborted();return result;
  }
  async renew(signal:AbortSignal):Promise<void>{
    const watch=this.pico.storage.get<Watch>('watch');if(watch&&Number(watch.expiration)>Date.now()+86_400_000)return;
    const fresh=await this.account.request<Watch>('https://gmail.googleapis.com/gmail/v1/users/me/watch',[SCOPES.mailRead],signal,{method:'POST',body:{topicName:this.config.topic}});
    if(!/^\d+$/.test(fresh.historyId)||!Number.isFinite(Number(fresh.expiration))||Number(fresh.expiration)<=Date.now())throw new Error('Invalid Gmail watch response');
    this.pico.storage.set('watch',fresh);
  }
  async once(signal:AbortSignal):Promise<void>{
    await this.renew(signal);
    const response=await this.pubsub<{receivedMessages?:PushMessage[]}>('pull',{maxMessages:20},signal),acks:string[]=[];
    for(const entry of response.receivedMessages??[]){
      if(!entry.ackId||entry.ackId.length>2000)throw new Error('Invalid Pub/Sub acknowledgment');
      let hint:{emailAddress?:string;historyId?:string};
      try{if(!entry.message?.data||entry.message.data.length>16_000)throw new Error();hint=JSON.parse(Buffer.from(entry.message.data,'base64').toString('utf8'));}
      catch{acks.push(entry.ackId);this.status='invalid notification discarded';continue;}
      if(hint.emailAddress?.toLowerCase()!==this.email.toLowerCase()||!hint.historyId||!/^\d{1,30}$/.test(hint.historyId)){acks.push(entry.ackId);this.status='foreign/invalid notification discarded';continue;}
      if(await this.synchronize(hint.historyId,signal))acks.push(entry.ackId);
    }
    if(acks.length)await this.pubsub('acknowledge',{ackIds:acks},signal);
  }
  start():void{
    if(this.task)return;this.controller=new AbortController();const signal=this.controller.signal;
    this.task=(async()=>{let delay=1000;while(!signal.aborted){try{await this.once(signal);this.status='connected';delay=1000;}catch{if(signal.aborted)break;this.status='degraded; periodic Gmail reconciliation remains active';delay=Math.min(delay*2,60_000);}this.pico.setStatus('Google mail',this.status);await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();},timer=setTimeout(done,delay);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});}})();
  }
  async close():Promise<void>{this.controller?.abort();await this.task;this.task=undefined;this.status='disabled';}
}
