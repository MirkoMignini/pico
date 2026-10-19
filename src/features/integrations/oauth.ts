import { createServer, type Server } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import type { Credential } from '@earendil-works/pi-ai';
import type { Credentials } from '../../credentials.js';
import { responseBytes, responseJson, requestSignal } from './http.js';

export type IntegrationCredentials = Pick<Credentials,'secret'|'read'|'modify'|'delete'>;
export interface OAuthConfiguration {
  clientId: string; credentialKey: string; secretName: string;
  authorizationEndpoint: string; tokenEndpoint: string; scopes: string[];
  scopeAlternatives?:Record<string,string[]>;
  listener?: {host?:string;port?:number};
  prepareGrant?: (access: string, signal: AbortSignal) => Promise<() => void>;
}
interface Tokens { access_token: string; refresh_token?: string; expires_in: number; scope?: string }
export const hasScope=(scopes:string[],required:string,alternatives:Record<string,string[]>={}):boolean=>scopes.includes(required)||!!alternatives[required]?.some(scope=>scopes.includes(scope));
const credentialScopes=(credential:Credential):string[]=>credential.type==='oauth'&&Array.isArray(credential.scopes)?credential.scopes.filter((scope:unknown):scope is string=>typeof scope==='string'):[];
function tokensValid(tokens: Tokens): void {
  if (typeof tokens.access_token!=='string'||!tokens.access_token||tokens.access_token.length>16_384
    ||!Number.isFinite(tokens.expires_in)||tokens.expires_in<=0||tokens.expires_in>31_536_000
    ||tokens.refresh_token!==undefined&&(typeof tokens.refresh_token!=='string'||!tokens.refresh_token||tokens.refresh_token.length>16_384)
    ||tokens.scope!==undefined&&(typeof tokens.scope!=='string'||tokens.scope.length>16_384))throw new Error('Invalid OAuth response');
}
export class OAuthAccount {
  constructor(readonly credentials: Pick<Credentials,'secret'|'modify'>, readonly config: OAuthConfiguration) {}
  async token(signal?: AbortSignal, requiredScopes: string[]=[]): Promise<string> {
    signal?.throwIfAborted();
    const secret=await this.credentials.secret(this.config.secretName);
    const credential=await this.credentials.modify(this.config.credentialKey,async current=>{
      if(current?.type!=='oauth')throw new Error('Integration not authenticated');
      if(requiredScopes.some(scope=>!hasScope(credentialScopes(current),scope,this.config.scopeAlternatives)))throw new Error('Additional consent required for this capability');
      if(current.expires>Date.now()+60_000)return undefined;
      const tokens=await responseJson<Tokens>(await fetch(this.config.tokenEndpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:this.config.clientId,refresh_token:current.refresh,...(secret?{client_secret:secret}:{})}),redirect:'error',signal:requestSignal(signal)}),64_000);
      tokensValid(tokens);signal?.throwIfAborted();
      if(tokens.scope && tokens.scope.split(/\s+/).some(scope=>!hasScope(credentialScopes(current),scope,this.config.scopeAlternatives)))throw new Error('OAuth refresh unexpectedly broadened access');
      return {...current,access:tokens.access_token,refresh:tokens.refresh_token??current.refresh,expires:Date.now()+tokens.expires_in*1000,...(tokens.scope?{scopes:tokens.scope.split(/\s+/)}:{})};
    });
    if(credential?.type!=='oauth')throw new Error('Integration credentials missing');
    if(requiredScopes.some(scope=>!hasScope(credentialScopes(credential),scope,this.config.scopeAlternatives)))throw new Error('Additional consent required');
    return credential.access;
  }
  async bytes(url:string,scopes:string[],maxBytes:number,signal?:AbortSignal):Promise<Buffer>{
    const access=await this.token(signal,scopes);signal?.throwIfAborted();
    const response=await fetch(url,{headers:{Authorization:`Bearer ${access}`},redirect:'error',signal:requestSignal(signal)});
    const bytes=await responseBytes(response,maxBytes);signal?.throwIfAborted();return bytes;
  }
  async request<T>(url: string, scopes: string[], signal?: AbortSignal, options: {method?:string;body?:unknown;headers?:Record<string,string>}={}): Promise<T> {
    const access=await this.token(signal,scopes);signal?.throwIfAborted();
    const response=await fetch(url,{method:options.method??'GET',headers:{...options.headers,Authorization:`Bearer ${access}`,...(options.body!==undefined?{'content-type':'application/json'}:{})},...(options.body!==undefined?{body:JSON.stringify(options.body)}:{}),redirect:'error',signal:requestSignal(signal)});
    if(response.status===204)return undefined as T;
    const result=await responseJson<T>(response);signal?.throwIfAborted();return result;
  }
}
export class OAuthLogin {
  private server?: Server;
  private abort?: AbortController;
  private timeout?: NodeJS.Timeout;
  status='idle';
  failure?:{stage:string;code?:string;httpStatus?:number};
  constructor(readonly credentials: Pick<Credentials,'secret'|'modify'>, readonly config: OAuthConfiguration) {}
  async start(): Promise<{url:string;redirectUri:string}> {
    if(this.abort)throw new Error('Integration login already pending');
    this.failure=undefined;
    const controller=new AbortController();this.abort=controller;
    const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
    let redirectUri='',consumed=false;
    const server=createServer(async(request,response)=>{
      let url:URL;try{url=new URL(request.url??'/',redirectUri);}catch{response.writeHead(400).end('Unverified callback');return;}
      if(url.pathname!=='/oauth/callback'||url.searchParams.get('state')!==state||consumed){response.writeHead(400).end('Unverified callback');return;}
      consumed=true;
      const failure:{stage:string;code?:string;httpStatus?:number}={stage:'authorization'};
      try{
        if(url.searchParams.has('error')||!url.searchParams.get('code'))throw new Error('Authorization declined');
        failure.stage='client-credentials';
        const secret=await this.credentials.secret(this.config.secretName);
        failure.stage='token-exchange';
        const tokenResponse=await fetch(this.config.tokenEndpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:this.config.clientId,...(secret?{client_secret:secret}:{}),code:url.searchParams.get('code')!,code_verifier:verifier,redirect_uri:redirectUri}),redirect:'error',signal:requestSignal(controller.signal)});
        if(!tokenResponse.ok){
          failure.httpStatus=tokenResponse.status;
          // Report only standard error codes, never provider descriptions, tokens or callback URLs.
          const detail=await responseJson<{error?:unknown}>(new Response(tokenResponse.body,{headers:tokenResponse.headers}),64_000).catch(()=>undefined);
          if(typeof detail?.error==='string'&&['invalid_request','invalid_client','invalid_grant','unauthorized_client','unsupported_grant_type','invalid_scope','access_denied','temporarily_unavailable','server_error'].includes(detail.error))failure.code=detail.error;
          throw new Error('Token exchange rejected');
        }
        failure.stage='token-response';
        const tokens=await responseJson<Tokens>(tokenResponse,64_000);
        tokensValid(tokens);const scopes=tokens.scope?.split(/\s+/)??[];
        failure.stage='offline-grant';
        if(!tokens.refresh_token){failure.code='missing_refresh_token';throw new Error('Offline grant required');}
        failure.stage='consent-scopes';
        if(this.config.scopes.some(scope=>!scopes.includes(scope))||scopes.some(scope=>!this.config.scopes.includes(scope))){failure.code='scope_mismatch';throw new Error('Exact scopes required');}
        failure.stage='account-validation';
        const commit=await this.config.prepareGrant?.(tokens.access_token,controller.signal);
        failure.stage='credential-storage';
        await this.credentials.modify(this.config.credentialKey,async()=>{controller.signal.throwIfAborted();commit?.();return {type:'oauth',access:tokens.access_token,refresh:tokens.refresh_token!,expires:Date.now()+tokens.expires_in*1000,scopes} satisfies Credential;});
        controller.signal.throwIfAborted();this.status='completed';response.end('Pikobot integration connected. You can close this page.');
      }catch{
        if(!controller.signal.aborted){this.status='failed';this.failure=failure;}
        response.writeHead(400,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}).end(`Integration login failed at ${failure.stage}${failure.code?`: ${failure.code}`:''}${failure.httpStatus?` (HTTP ${failure.httpStatus})`:''}. Inspect integration status in Pikobot. Existing credentials were not intentionally replaced.`);
      }
      finally{if(this.abort===controller)this.close();}
    });
    this.server=server;
    try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(this.config.listener?.port??0,this.config.listener?.host??'127.0.0.1',resolve);});controller.signal.throwIfAborted();}
    catch(error){if(this.abort===controller)this.close();throw error;}
    const address=server.address();if(!address||typeof address==='string')throw new Error('Callback unavailable');
    redirectUri=`http://127.0.0.1:${address.port}/oauth/callback`;
    const url=new URL(this.config.authorizationEndpoint);url.search=new URLSearchParams({client_id:this.config.clientId,redirect_uri:redirectUri,response_type:'code',scope:this.config.scopes.join(' '),access_type:'offline',prompt:'consent',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',include_granted_scopes:'false'}).toString();
    this.status='pending';this.timeout=setTimeout(()=>{if(this.server===server){this.status='expired';this.close();}},600_000);this.timeout.unref();
    return {url:url.toString(),redirectUri};
  }
  close(): void {if(this.status==='pending')this.status='cancelled';if(this.timeout)clearTimeout(this.timeout);this.abort?.abort();this.abort=undefined;this.server?.close();this.server?.closeAllConnections();this.server=undefined;}
}
