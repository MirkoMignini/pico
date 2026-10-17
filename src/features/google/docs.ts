import { Type } from 'typebox';
import { object, validate } from '../../contracts.js';
import type { OAuthAccount } from '../integrations/oauth.js';
import { SCOPES, toolSchema, type GoogleSettings } from './settings.js';

const docId=Type.String({pattern:'^[A-Za-z0-9_-]{1,200}$'}),revision=Type.String({minLength:1,maxLength:1000}),text=Type.String({minLength:1,maxLength:100_000});
export const DocsSchema=Type.Union([
  object({action:Type.Literal('read'),documentId:docId,fromOffset:Type.Optional(Type.Integer({minimum:0})),maxChars:Type.Optional(Type.Integer({minimum:1,maximum:10_000}))}),
  object({action:Type.Literal('search'),query:Type.String({maxLength:200}),pageToken:Type.Optional(Type.String({maxLength:2000}))}),
  object({action:Type.Literal('import'),documentId:docId}),
  object({action:Type.Literal('create'),title:Type.String({minLength:1,maxLength:300})}),
  object({action:Type.Literal('append'),documentId:docId,expectedRevision:revision,tabId:docId,text}),
  object({action:Type.Literal('replace'),documentId:docId,expectedRevision:revision,tabId:docId,find:text,replace:Type.String({maxLength:100_000})})
]);
export const DocsToolSchema=toolSchema(DocsSchema.anyOf);
interface Element {paragraph?:{elements?:{textRun?:{content?:string};inlineObjectElement?:unknown}[]};table?:{tableRows?:{tableCells?:{content?:Element[]}[]}[]};tableOfContents?:{content?:Element[]}}
interface Segment {content?:Element[]}
interface DocumentTab {body?:Segment;headers?:Record<string,Segment>;footers?:Record<string,Segment>;footnotes?:Record<string,Segment>;inlineObjects?:Record<string,unknown>;positionedObjects?:Record<string,unknown>}
interface Tab {tabProperties?:{tabId?:string;title?:string};documentTab?:DocumentTab;childTabs?:Tab[]}
export interface GoogleDocument extends DocumentTab {documentId:string;title:string;revisionId?:string;tabs?:Tab[]}
export function documentText(raw:GoogleDocument):{text:string;tabs:{id:string;title:string;text:string}[];truncated:boolean;warnings:string[]}{
  let nodes=0;
  const elements=(content:Element[]=[],depth=0):string=>{
    if(depth>30||nodes>100_000)throw new Error('Google document structure exceeds bounds');
    return content.map(element=>{nodes++;if(element.paragraph)return (element.paragraph.elements??[]).map(part=>part.textRun?.content??(part.inlineObjectElement?'[embedded object]':'')).join('');if(element.table)return (element.table.tableRows??[]).map(row=>(row.tableCells??[]).map(cell=>elements(cell.content,depth+1)).join('\t')).join('\n')+'\n';if(element.tableOfContents)return elements(element.tableOfContents.content,depth+1);return '';}).join('');
  };
  const segment=(tab:DocumentTab)=>[elements(tab.body?.content),...Object.values(tab.headers??{}).map(value=>elements(value.content)),...Object.values(tab.footers??{}).map(value=>elements(value.content)),...Object.values(tab.footnotes??{}).map(value=>elements(value.content))].filter(Boolean).join('\n');
  const tabs:{id:string;title:string;text:string}[]=[];
  const walk=(values:Tab[],depth=0):void=>{if(depth>30||tabs.length>1000)throw new Error('Google document tab limit exceeded');for(const tab of values){if(tab.documentTab)tabs.push({id:tab.tabProperties?.tabId??'',title:tab.tabProperties?.title??'',text:segment(tab.documentTab)});walk(tab.childTabs??[],depth+1);}};
  walk(raw.tabs??[]);if(!tabs.length)tabs.push({id:'',title:raw.title,text:segment(raw)});
  const full=tabs.map(tab=>`${tab.title?`# ${tab.title}\n`:''}${tab.text}`).join('\n'),truncated=full.length>200_000;
  return {text:full.slice(0,200_000),tabs:tabs.map(tab=>({...tab,text:tab.text.slice(0,200_000)})),truncated,warnings:['Text snapshot only: native layout, embedded images/drawings, suggestions and comments are not fully represented',...(truncated?['Document text exceeds the 200,000-character snapshot limit']:[])]};
}
export class GoogleDocs {
  constructor(readonly account:OAuthAccount,readonly settings:GoogleSettings,readonly createdIds:()=>string[]=()=>[]){}
  private scope():string[]{if(!this.settings.docs.enabled)throw new Error('Google Docs disabled');return [this.settings.docs.write?SCOPES.docsWrite:SCOPES.docsRead];}
  allowed(documentId:string):void{if(!this.settings.docs.documentIds.includes(documentId)&&!this.createdIds().includes(documentId))throw new Error('Document is not selected in Google extension settings');}
  async raw(documentId:string,signal?:AbortSignal):Promise<GoogleDocument>{
    if(!this.settings.docs.readAll)this.allowed(documentId);const raw=await this.account.request<GoogleDocument>(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}?${new URLSearchParams({includeTabsContent:'true',suggestionsViewMode:this.settings.docs.write?'SUGGESTIONS_INLINE':'PREVIEW_WITHOUT_SUGGESTIONS'})}`,this.scope(),signal);
    if(raw.documentId!==documentId||typeof raw.title!=='string'||raw.title.length>1000)throw new Error('Invalid Google document response');return raw;
  }
  async read(rawArgs:unknown,signal?:AbortSignal):Promise<unknown>{
    const args=validate<Record<string,any>>(DocsSchema,rawArgs);
    if(args.action==='search'){
      this.scope();if(!this.settings.docs.discovery)throw new Error('Drive metadata discovery disabled');
      const query=`trashed = false and mimeType = 'application/vnd.google-apps.document' and name contains '${args.query.replaceAll('\\','\\\\').replaceAll("'","\\'")}'`;
      const data=await this.account.request<{files?:unknown[];nextPageToken?:string}>(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({q:query,fields:'files(id,name,modifiedTime,webViewLink),nextPageToken',pageSize:'50',...(args.pageToken?{pageToken:args.pageToken}:{})})}`,[SCOPES.driveMetadata],signal);
      return {origin:'external:google-drive',files:data.files??[],nextPageToken:data.nextPageToken??null,note:this.settings.docs.readAll?'Read/import any Google Doc accessible to the connected account; writes still require selected targets and approval':'Discovery grants metadata access; document bodies still require selected document IDs'};
    }
    const raw=await this.raw(args.documentId,signal),representation=documentText(raw),fromOffset=args.fromOffset??0,toOffset=Math.min(representation.text.length,fromOffset+(args.maxChars??10_000));
    if(fromOffset>representation.text.length)throw new Error('Document read offset exceeds stored representation');
    return {origin:'external:google-docs',documentId:raw.documentId,title:raw.title,revision:raw.revisionId??null,url:`https://docs.google.com/document/d/${raw.documentId}/edit`,tabs:representation.tabs.map(tab=>({id:tab.id,title:tab.title})),text:representation.text.slice(fromOffset,toOffset),fromOffset,toOffset,totalChars:representation.text.length,nextOffset:toOffset<representation.text.length?toOffset:null,completeSource:fromOffset===0&&toOffset===representation.text.length&&!representation.truncated,truncated:representation.truncated,warnings:representation.warnings,retrievedAt:new Date().toISOString()};
  }
  async write(kind:string,payload:Record<string,any>,signal:AbortSignal):Promise<unknown>{
    if(!this.settings.docs.enabled||!this.settings.docs.write)throw new Error('Google Docs writes disabled');
    if(!['docs.create','docs.append','docs.replace'].includes(kind))throw Object.assign(new Error('Unsupported document mutation'),{status:400});
    if(kind==='docs.create')return this.account.request('https://docs.googleapis.com/v1/documents',[SCOPES.docsWrite],signal,{method:'POST',body:{title:payload.title}});
    this.allowed(payload.documentId);
    const current=await this.raw(payload.documentId,signal);if(current.revisionId!==payload.expectedRevision)throw Object.assign(new Error('Document revision conflict'),{status:409});
    const representation=documentText(current),tab=representation.tabs.find(tab=>tab.id===payload.tabId);if(!tab)throw Object.assign(new Error('Document tab missing'),{status:409});
    let request:unknown;
    if(kind==='docs.append')request={insertText:{endOfSegmentLocation:{tabId:payload.tabId},text:payload.text}};
    else{if(representation.truncated||tab.text.split(payload.find).length!==2)throw Object.assign(new Error('Replacement must match one exact unique span in a complete selected tab'),{status:409});request={replaceAllText:{containsText:{text:payload.find,matchCase:true},replaceText:payload.replace,tabsCriteria:{tabIds:[payload.tabId]}}};}
    const result=await this.account.request<{replies?:{replaceAllText?:{occurrencesChanged?:number}}[]}>(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(payload.documentId)}:batchUpdate`,[SCOPES.docsWrite],signal,{method:'POST',body:{writeControl:{requiredRevisionId:payload.expectedRevision},requests:[request]}});
    if(kind==='docs.replace'&&result.replies?.[0]?.replaceAllText?.occurrencesChanged!==1)throw new Error('Accepted document request did not confirm exactly one replacement; inspect Google before retrying');
    return result;
  }
}
