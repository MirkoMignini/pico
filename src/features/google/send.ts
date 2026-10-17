import { Type } from 'typebox';
import { object } from '../../contracts.js';
import { hash } from '../../store.js';
import type { Runtime } from '../../runtime.js';
import type { RemoteAction } from '../integrations/contracts.js';
import type { OAuthAccount } from '../integrations/oauth.js';
import { SCOPES, toolSchema } from './settings.js';

const identifier=Type.String({pattern:'^[A-Za-z0-9_-]{1,200}$'});
export const EmailAddressSchema=Type.String({minLength:3,maxLength:254,pattern:'^[A-Za-z0-9.!#$%&\u0027*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\\.[A-Za-z]{2,63}$'});
const addresses=Type.Array(EmailAddressSchema,{minItems:1,maxItems:50,uniqueItems:true});
export const MailSchema=Type.Union([
  object({action:Type.Literal('search'),query:Type.String({maxLength:2000}),pageToken:Type.Optional(Type.String({maxLength:2000})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))}),
  object({action:Type.Literal('thread'),threadId:identifier}),
  object({action:Type.Literal('import_attachment'),messageId:identifier,attachmentId:Type.String({pattern:'^[A-Za-z0-9_-]{1,4000}$'})}),
  object({action:Type.Literal('prepare_send'),to:addresses,cc:Type.Optional(addresses),bcc:Type.Optional(addresses),subject:Type.String({minLength:1,maxLength:300,pattern:'^[^\\r\\n\\x00]+$'}),text:Type.String({minLength:1,maxLength:100_000}),replyToMessageId:Type.Optional(identifier),attachments:Type.Optional(Type.Array(Type.Union([object({attachmentId:identifier}),object({documentId:Type.String({pattern:'^[a-f0-9-]{36}$'}),revision:Type.Optional(Type.Integer({minimum:1}))})]),{maxItems:5}))})
]);
export const MailToolSchema=toolSchema(MailSchema.anyOf);
export interface SendAttachment {attachmentId?:string;documentId?:string;revision?:number;hash:string;name:string;mime:string;bytes:number}
export async function attachmentSnapshot(core:Runtime,reference:{attachmentId?:string;documentId?:string;revision?:number}):Promise<{metadata:SendAttachment;bytes:Uint8Array;sources:string[]}>{
  if(reference.documentId){const revision=reference.revision??core.knowledge.document(reference.documentId).current_revision,original=core.knowledge.original(reference.documentId,revision);return {metadata:{documentId:reference.documentId,revision,hash:original.hash,name:original.name,mime:original.mime,bytes:original.bytes.length},bytes:original.bytes,sources:[`document:${reference.documentId}:r${revision}`]};}
  const attachment=await core.media.read(reference.attachmentId!),row=core.store.get<{source_id:string|null}>('SELECT source_id FROM attachments WHERE id=?',reference.attachmentId!);
  if(!row)throw new Error('Only retained attachments can be emailed');
  return {metadata:{attachmentId:reference.attachmentId,hash:hash(attachment.bytes),name:attachment.name,mime:attachment.mime,bytes:attachment.bytes.length},bytes:attachment.bytes,sources:row.source_id?[row.source_id]:[]};
}
const base64=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64').match(/.{1,76}/g)?.join('\r\n')??'';
function subjectHeader(subject:string):string{
  const chunks:string[]=[];let current='';for(const character of subject){if(Buffer.byteLength(current+character)>45){chunks.push(current);current='';}current+=character;}if(current)chunks.push(current);return chunks.map(chunk=>`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`).join('\r\n ');
}
export function emailMime(payload:Record<string,any>,action:Pick<RemoteAction,'id'|'createdAt'>,attachments:{metadata:SendAttachment;bytes:Uint8Array}[]):string{
  const lines=[`From: ${payload.from}`,`To: ${payload.to.join(',\r\n ')}`,...(payload.cc?.length?[`Cc: ${payload.cc.join(',\r\n ')}`]:[]),...(payload.bcc?.length?[`Bcc: ${payload.bcc.join(',\r\n ')}`]:[]),`Subject: ${subjectHeader(payload.subject)}`,`Date: ${new Date(action.createdAt).toUTCString()}`,`Message-ID: <pico-${action.id}@pico.invalid>`,'MIME-Version: 1.0'];
  if(payload.inReplyTo)lines.push(`In-Reply-To: ${payload.inReplyTo}`);if(payload.references)lines.push(`References: ${payload.references.split(' ').join('\r\n ')}`);
  const text=['Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',base64(Buffer.from(payload.text))];
  if(!attachments.length)return [...lines,...text].join('\r\n');
  const boundary=`pico-${action.id}`;lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`,'',`--${boundary}`,...text);
  for(const attachment of attachments){const mime=/^[a-z0-9!#$&^_+-]+\/[a-z0-9!#$&^_+.-]+$/i.test(attachment.metadata.mime)?attachment.metadata.mime:'application/octet-stream';
    const filename=encodeURIComponent(attachment.metadata.name).replaceAll("'",'%27'),parts=filename.match(/(?:%[A-F0-9]{2}|.){1,50}/g)??[''];
    const disposition=parts.map((part,index)=>`filename*${index}*=${index===0?"UTF-8''":''}${part}`).join(';\r\n ');
    lines.push(`--${boundary}`,`Content-Type: ${mime}`,`Content-Disposition: attachment;\r\n ${disposition}`,'Content-Transfer-Encoding: base64','',base64(attachment.bytes));}
  lines.push(`--${boundary}--`,'');return lines.join('\r\n');
}
export async function sendMail(core:Runtime,account:OAuthAccount,action:RemoteAction,signal:AbortSignal):Promise<unknown>{
  const payload=action.payload as Record<string,any>,attachments=[];
  for(const reference of (payload.attachments??[]) as SendAttachment[]){const snapshot=await attachmentSnapshot(core,reference);if(snapshot.metadata.hash!==reference.hash||snapshot.metadata.bytes!==reference.bytes||snapshot.metadata.name!==reference.name||snapshot.metadata.mime!==reference.mime)throw Object.assign(new Error('Attachment changed since approval'),{status:409});attachments.push(snapshot);}
  const raw=Buffer.from(emailMime(payload,action,attachments)).toString('base64url');
  const result=await account.request<{id:string;threadId:string}>('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',[SCOPES.mailSend],signal,{method:'POST',body:{raw,...(payload.threadId?{threadId:payload.threadId}:{})}});
  if(!result.id)throw new Error('Gmail acceptance receipt missing');return {accepted:true,messageId:result.id,threadId:result.threadId,delivery:'Accepted by Gmail; recipient delivery is not verified'};
}
