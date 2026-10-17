import { Type } from 'typebox';
import { object, validate } from '../../contracts.js';
import type { OAuthAccount } from '../integrations/oauth.js';
import { SCOPES, toolSchema, type GoogleSettings } from './settings.js';

const fileId=Type.String({pattern:'^[A-Za-z0-9_-]{1,200}$'}),page={pageToken:Type.Optional(Type.String({maxLength:2000})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))};
const exports={pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',csv:'text/csv',txt:'text/plain'};
export const DriveSchema=Type.Union([
  object({action:Type.Literal('search'),query:Type.String({maxLength:200}),folderId:Type.Optional(fileId),driveId:Type.Optional(fileId),mimeType:Type.Optional(Type.String({minLength:1,maxLength:200})),ownedByMe:Type.Optional(Type.Boolean()),orderBy:Type.Optional(Type.Union([Type.Literal('createdTime desc'),Type.Literal('modifiedTime desc'),Type.Literal('name')])),...page}),
  object({action:Type.Literal('drives'),...page}),
  object({action:Type.Literal('read'),fileId}),
  object({action:Type.Literal('import'),fileId,format:Type.Optional(Type.Union([Type.Literal('pdf'),Type.Literal('docx'),Type.Literal('xlsx'),Type.Literal('csv'),Type.Literal('txt')]))})
]);
export const DriveToolSchema=toolSchema(DriveSchema.anyOf);
export interface DriveFile {id:string;name:string;mimeType:string;version:string;size?:string;modifiedTime?:string;webViewLink?:string;capabilities?:{canDownload?:boolean};trashed?:boolean}
const fields='id,name,mimeType,createdTime,modifiedTime,version,size,trashed,webViewLink,parents,driveId,ownedByMe,capabilities(canDownload),shortcutDetails(targetId,targetMimeType)';
const quote=(value:string)=>`'${value.replaceAll('\\','\\\\').replaceAll("'","\\'")}'`;
export class GoogleDrive {
  constructor(readonly account:OAuthAccount,readonly settings:GoogleSettings){}
  private enabled():void{if(!this.settings.drive?.enabled)throw new Error('Google Drive disabled');}
  async metadata(id:string,signal?:AbortSignal):Promise<DriveFile>{
    this.enabled();validate(fileId,id);
    const file=await this.account.request<DriveFile>(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?${new URLSearchParams({fields,supportsAllDrives:'true'})}`,[SCOPES.driveRead],signal);
    if((file.id!==id&&(id!=='root'||file.mimeType!=='application/vnd.google-apps.folder'))||typeof file.name!=='string'||!file.name||file.name.length>1000||typeof file.mimeType!=='string'||file.mimeType.length>200||typeof file.version!=='string'||!file.version||file.version.length>200)throw new Error('Invalid Drive metadata response');
    validate(fileId,file.id);if(file.trashed)throw new Error('Drive file is trashed');return file;
  }
  async read(raw:unknown,signal?:AbortSignal):Promise<unknown>{
    const args=validate<Record<string,any>>(DriveSchema,raw);this.enabled();
    if(args.action==='read')return {origin:'external:google-drive',file:await this.metadata(args.fileId,signal)};
    if(args.action==='drives'){
      const data=await this.account.request<{drives?:unknown[];nextPageToken?:string}>(`https://www.googleapis.com/drive/v3/drives?${new URLSearchParams({pageSize:String(args.limit??50),...(args.pageToken?{pageToken:args.pageToken}:{})})}`,[SCOPES.driveRead],signal);
      return {origin:'external:google-drive',drives:data.drives??[],nextPageToken:data.nextPageToken??null};
    }
    if(args.action!=='search')throw new Error('Drive imports require retained owner execution');
    const q=['trashed = false',`name contains ${quote(args.query)}`,...(args.folderId?[`${quote(args.folderId)} in parents`]:[]),...(args.mimeType?[`mimeType = ${quote(args.mimeType)}`]:[]),...(args.ownedByMe?["'me' in owners"]:[])].join(' and ');
    const data=await this.account.request<{files?:unknown[];nextPageToken?:string;incompleteSearch?:boolean}>(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({q,fields:`files(${fields}),nextPageToken,incompleteSearch`,orderBy:args.orderBy??'modifiedTime desc',pageSize:String(args.limit??50),supportsAllDrives:'true',includeItemsFromAllDrives:'true',...(args.driveId?{driveId:args.driveId,corpora:'drive'}:{corpora:'user'}),...(args.pageToken?{pageToken:args.pageToken}:{})})}`,[SCOPES.driveRead],signal);
    return {origin:'external:google-drive',files:data.files??[],nextPageToken:data.nextPageToken??null,incompleteSearch:data.incompleteSearch===true,note:'Creation/ownership filters describe Drive metadata, not proof of original authorship. Specify driveId to search a particular shared drive.'};
  }
  async download(id:string,format:keyof typeof exports|undefined,maxBytes:number,signal?:AbortSignal):Promise<{file:DriveFile;bytes:Buffer;name:string;mime:string;sourceId:string;warnings:string[]}>{
    const file=await this.metadata(id,signal);if(file.capabilities?.canDownload===false)throw new Error('Google disallows downloading this file');
    const native=file.mimeType.startsWith('application/vnd.google-apps.');
    if(file.mimeType==='application/vnd.google-apps.folder'||file.mimeType==='application/vnd.google-apps.shortcut')throw new Error('Select an actual file, not a folder or shortcut');
    if(!native&&format)throw new Error('Export format applies only to native Google files');
    const chosen=format??(file.mimeType.endsWith('.spreadsheet')?'xlsx':'pdf'),mime=native?exports[chosen]:file.mimeType;
    const supported=file.mimeType==='application/vnd.google-apps.document'?['pdf','docx','txt']:file.mimeType==='application/vnd.google-apps.spreadsheet'?['pdf','xlsx','csv']:['application/vnd.google-apps.presentation','application/vnd.google-apps.drawing'].includes(file.mimeType)?['pdf']:[];
    if(native&&!supported.includes(chosen))throw new Error('Unsupported native Drive export type');
    if(file.size!==undefined&&(!/^\d+$/.test(file.size)||BigInt(file.size)>BigInt(maxBytes)))throw new Error('Drive file exceeds attachment byte limit');
    const url=`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}${native?`/export?${new URLSearchParams({mimeType:mime})}`:'?alt=media&supportsAllDrives=true'}`;
    const bytes=await this.account.bytes(url,[SCOPES.driveRead],maxBytes,signal),current=await this.metadata(id,signal);
    if(current.version!==file.version||current.name!==file.name||current.mimeType!==file.mimeType)throw new Error('Drive file changed during download; inspect and retry explicitly');
    return {file,bytes,name:native?`${file.name}.${chosen}`:file.name,mime,sourceId:`google:${file.mimeType==='application/vnd.google-apps.document'?'doc':'drive'}:${id}`,warnings:native?[`Google export (${chosen}), not the native editable original`,...(chosen==='csv'?['CSV export includes only the first spreadsheet tab']:[])]:[]};
  }
}
