import type { Credentials } from '../../credentials.js';
import type { MailConnector, MailMessage } from '../integrations/contracts.js';
import { OAuthAccount, OAuthLogin, type OAuthConfiguration } from '../integrations/oauth.js';
import { SCOPES } from './settings.js';
import { hash } from '../../store.js';

export const googleOAuth = (clientId:string,scopes:string[]=[SCOPES.mailRead],listener:OAuthConfiguration['listener']={}):OAuthConfiguration => ({clientId,credentialKey:'gmail',secretName:'gmail.clientSecret',authorizationEndpoint:'https://accounts.google.com/o/oauth2/v2/auth',tokenEndpoint:'https://oauth2.googleapis.com/token',scopes,scopeAlternatives:{[SCOPES.docsRead]:[SCOPES.docsWrite],[SCOPES.driveMetadata]:[SCOPES.driveRead],[SCOPES.sheetsRead]:[SCOPES.sheetsWrite],[SCOPES.tasksRead]:[SCOPES.tasksWrite]},listener});
// Compatibility for the existing read-only Gmail login; the Google extension uses the same PKCE implementation.
export class GmailLogin extends OAuthLogin {
  constructor(credentials:Pick<Credentials,'secret'|'modify'>,clientId:string,listener:OAuthConfiguration['listener']={}){super(credentials,googleOAuth(clientId,[SCOPES.mailRead],listener));}
}
interface GmailPart {partId?:string;mimeType:string;filename?:string;headers?:{name:string;value:string}[];body?:{data?:string;attachmentId?:string;size?:number};parts?:GmailPart[]}
export interface GmailRaw {id:string;threadId:string;internalDate:string;labelIds?:string[];payload:GmailPart}
// Gmail's download token can rotate; the immutable MIME part is scoped to its message.
const attachmentReference=(messageId:string,part:GmailPart):string=>typeof part.partId==='string'?`part_${hash(JSON.stringify([messageId,part.partId]))}`:part.body!.attachmentId!;
function flatten(part:GmailPart,depth=0):GmailPart[]{if(depth>30)throw new Error('Mail MIME nesting limit exceeded');return [part,...(part.parts??[]).flatMap(child=>flatten(child,depth+1))];}
function htmlText(html:string):string{
  let text='',position=0,hidden:string|undefined;
  // Scan once; regex removal of repeated unclosed script/style tags can stall the daemon.
  while(position<html.length){
    const open=html.indexOf('<',position);if(open===-1){if(!hidden)text+=html.slice(position);break;}if(!hidden)text+=html.slice(position,open);
    if(html.startsWith('<!--',open)){const close=html.indexOf('-->',open+4);if(close===-1)break;position=close+3;continue;}
    const close=html.indexOf('>',open+1);if(close===-1){if(!hidden)text+=html.slice(open);break;}
    const tag=html.slice(open+1,close).trim().toLowerCase(),start=/^(script|style)(?:\s|$)/.exec(tag),end=/^\/(script|style)(?:\s|$)/.exec(tag);
    if(!hidden&&start)hidden=start[1];else if(end?.[1]===hidden)hidden=undefined;if(!hidden)text+=' ';position=close+1;
  }
  return text.replace(/&nbsp;/g,' ').replace(/&amp;/g,'&');
}
export function normalizeMail(raw:GmailRaw):MailMessage{
  const header=(name:string)=>(raw.payload.headers?.find(value=>value.name.toLowerCase()===name)?.value??'').slice(0,4000),parts=flatten(raw.payload);
  const plain=parts.filter(part=>part.mimeType==='text/plain'&&!part.filename).map(part=>Buffer.from(part.body?.data??'','base64url').toString('utf8')).join('\n');
  const html=parts.filter(part=>part.mimeType==='text/html'&&!part.filename).map(part=>Buffer.from(part.body?.data??'','base64url').toString('utf8')).join('\n');
  const text=plain.trim()?plain:htmlText(html.slice(0,200_000)),truncated=text.length>100_000||!plain.trim()&&html.length>200_000||!!raw.payload.headers?.some(header=>header.value.length>4000);
  return {id:raw.id,threadId:raw.threadId,eventAt:Number(raw.internalDate),from:header('from'),to:header('to'),cc:header('cc'),replyTo:header('reply-to'),messageId:header('message-id'),references:header('references'),subject:header('subject'),text:text.slice(0,100_000),truncated,labels:raw.labelIds??[],link:`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(raw.threadId)}`,attachments:parts.filter(part=>part.filename&&part.body?.attachmentId).map(part=>({id:attachmentReference(raw.id,part),name:part.filename!,mime:part.mimeType,bytes:part.body?.size??0}))};
}
export class Gmail implements MailConnector {
  readonly account:OAuthAccount;
  private readonly scopes:string[];
  constructor(credentials:Pick<Credentials,'secret'|'modify'>,clientId:string,readonly baselineMax:number,readonly endpoint='https://gmail.googleapis.com/gmail/v1/users/me',account?:OAuthAccount){this.account=account??new OAuthAccount(credentials,googleOAuth(clientId));this.scopes=account?[SCOPES.mailRead]:[];}
  private get<T>(path:string,signal?:AbortSignal):Promise<T>{return this.account.request(`${this.endpoint}/${path}`,this.scopes,signal);}
  async search(query:string,signal?:AbortSignal):Promise<string[]>{return (await this.page(query,undefined,50,signal)).ids;}
  async page(query:string,pageToken?:string,limit=50,signal?:AbortSignal):Promise<{ids:string[];nextPageToken:string|null}>{
    const data=await this.get<{messages?:{id:string}[];nextPageToken?:string}>(`messages?${new URLSearchParams({q:query,maxResults:String(limit),...(pageToken?{pageToken}:{})})}`,signal);
    return {ids:(data.messages??[]).map(message=>message.id),nextPageToken:data.nextPageToken??null};
  }
  async read(messageId:string,signal?:AbortSignal):Promise<MailMessage>{return normalizeMail(await this.get<GmailRaw>(`messages/${encodeURIComponent(messageId)}?format=full`,signal));}
  async thread(threadId:string,signal?:AbortSignal):Promise<MailMessage[]>{const data=await this.get<{messages?:GmailRaw[]}>(`threads/${encodeURIComponent(threadId)}?format=full`,signal);if((data.messages?.length??0)>1000)throw new Error('Mail thread exceeds 1000-message read limit');return (data.messages??[]).map(normalizeMail);}
  async selectAttachment(messageId:string,reference:string,signal?:AbortSignal){
    const raw=await this.get<GmailRaw>(`messages/${encodeURIComponent(messageId)}?format=full`,signal);
    if(raw.id!==messageId)throw new Error('Gmail returned a different message than the selected message');
    const parts=flatten(raw.payload).filter(part=>part.filename&&part.body?.attachmentId&&(attachmentReference(raw.id,part)===reference||part.body.attachmentId===reference));
    if(parts.length!==1)throw new Error('Attachment reference is stale or ambiguous for the selected message; reread the message and use its listed attachment ID');
    const part=parts[0]!,message=normalizeMail(raw),attachments=message.attachments.filter(attachment=>attachment.id===attachmentReference(raw.id,part));
    if(attachments.length!==1)throw new Error('Attachment reference is ambiguous for the selected message');
    return {message,attachment:attachments[0]!,download:()=>this.attachment(messageId,part.body!.attachmentId!,signal)};
  }
  async attachment(messageId:string,attachmentId:string,signal?:AbortSignal):Promise<Uint8Array>{const data=await this.get<{data:string}>(`messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,signal);return Buffer.from(data.data,'base64url');}
  async changes(cursor?:string,signal?:AbortSignal):Promise<{ids:string[];deleted:string[];cursor:string;baseline:boolean}>{
    if(!cursor){
      const profile=await this.get<{historyId:string}>('profile',signal),ids:string[]=[];let page='';
      do{const data=await this.get<{messages?:{id:string}[];nextPageToken?:string}>(`messages?${new URLSearchParams({maxResults:String(Math.min(100,this.baselineMax-ids.length)),...(page?{pageToken:page}:{})})}`,signal);ids.push(...(data.messages??[]).map(message=>message.id));page=data.nextPageToken??'';}while(page&&ids.length<this.baselineMax);
      return {ids,deleted:[],cursor:profile.historyId,baseline:true};
    }
    try{
      const ids=new Set<string>(),deleted=new Set<string>();let page='',next=cursor,pages=0;
      do{
        const data=await this.get<{historyId:string;nextPageToken?:string;history?:{messagesAdded?:{message:{id:string}}[];messagesDeleted?:{message:{id:string}}[]}[]}>(`history?${new URLSearchParams({startHistoryId:cursor,maxResults:'100',...(page?{pageToken:page}:{})})}`,signal);
        for(const event of data.history??[]){for(const added of event.messagesAdded??[])ids.add(added.message.id);for(const removed of event.messagesDeleted??[])deleted.add(removed.message.id);}
        next=data.historyId;page=data.nextPageToken??'';if(++pages>100)throw new Error('Incremental sync bounded at 100 pages; cursor preserved');
      }while(page);
      return {ids:[...ids].filter(value=>!deleted.has(value)),deleted:[...deleted],cursor:next,baseline:false};
    }catch(error){if((error as {status?:number}).status===404)return this.changes(undefined,signal);throw error;}
  }
}
