import { Type } from 'typebox';
import { object, validate } from '../../contracts.js';
import { json } from '../../store.js';
import type { OAuthAccount } from '../integrations/oauth.js';
import { SCOPES, toolSchema, type GoogleSettings } from './settings.js';

const spreadsheetId=Type.String({pattern:'^[A-Za-z0-9_-]{1,200}$'}),range=Type.String({minLength:1,maxLength:500});
const cell=Type.Union([Type.String({maxLength:50_000}),Type.Number(),Type.Boolean()]);
const values=Type.Array(Type.Array(cell,{minItems:1,maxItems:1000}),{minItems:1,maxItems:1000});
export const SheetsSchema=Type.Union([
  object({action:Type.Literal('read'),spreadsheetId}),
  object({action:Type.Literal('values'),spreadsheetId,range,render:Type.Optional(Type.Union([Type.Literal('FORMATTED_VALUE'),Type.Literal('UNFORMATTED_VALUE'),Type.Literal('FORMULA')]))}),
  object({action:Type.Literal('update'),spreadsheetId,range,values})
]);
export const SheetsToolSchema=toolSchema(SheetsSchema.anyOf);
export function sheetRange(range:string):{sheet:string;startRow:number;endRow:number;startColumn:number;endColumn:number;rows:number;columns:number}{
  const match=/^('(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_ ]*)!([A-Z]{1,3})([1-9][0-9]{0,6})(?::([A-Z]{1,3})([1-9][0-9]{0,6}))?$/i.exec(range);
  if(!match)throw new Error('Use an explicit tab-qualified A1 cell/rectangle, for example Sheet1!A1:C20');
  const column=(text:string)=>[...text.toUpperCase()].reduce((n,char)=>n*26+char.charCodeAt(0)-64,0);
  const startRow=Number(match[3]),endRow=Number(match[5]??match[3]),startColumn=column(match[2]!),endColumn=column(match[4]??match[2]!);
  const rows=endRow-startRow+1,columns=endColumn-startColumn+1;
  if(rows<1||columns<1||endRow>1_000_000||rows*columns>1000)throw new Error('Spreadsheet ranges must be positive and at most 1000 cells');
  return {sheet:match[1]!.startsWith("'")?match[1]!.slice(1,-1).replaceAll("''","'"):match[1]!,startRow,endRow,startColumn,endColumn,rows,columns};
}
interface ValueRange {range:string;values?:(string|number|boolean|null)[][]}
export class GoogleSheets {
  constructor(readonly account:OAuthAccount,readonly settings:GoogleSettings){}
  private scope(write=false):string[]{
    if(!this.settings.sheets?.enabled)throw new Error('Google Sheets disabled');
    if(write&&!this.settings.sheets.write)throw new Error('Google Sheets writes disabled');
    return [this.settings.sheets.write?SCOPES.sheetsWrite:SCOPES.sheetsRead];
  }
  private url(id:string):string{validate(spreadsheetId,id);return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`;}
  async metadata(id:string,signal?:AbortSignal):Promise<{spreadsheetId:string;properties:{title:string;locale?:string;timeZone?:string};sheets?:unknown[]}>{
    const data=await this.account.request<{spreadsheetId:string;properties:{title:string};sheets?:unknown[]}>(`${this.url(id)}?${new URLSearchParams({includeGridData:'false',fields:'spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,gridProperties))'})}`,this.scope(),signal);
    if(data.spreadsheetId!==id||typeof data.properties?.title!=='string')throw new Error('Invalid spreadsheet metadata');return data;
  }
  private async cells(id:string,range:string,render:string,signal?:AbortSignal):Promise<{range:string;values:(string|number|boolean)[][]}>{
    const bounds=sheetRange(range),data=await this.account.request<ValueRange>(`${this.url(id)}/values/${encodeURIComponent(range)}?${new URLSearchParams({majorDimension:'ROWS',valueRenderOption:render})}`,this.scope(),signal);
    if(typeof data.range!=='string'||json(sheetRange(data.range))!==json(bounds))throw new Error('Spreadsheet response range mismatch');
    if(data.values!==undefined&&(!Array.isArray(data.values)||data.values.length>bounds.rows||data.values.some(row=>!Array.isArray(row)||row.length>bounds.columns||row.some(cell=>cell!==null&&!['string','number','boolean'].includes(typeof cell)))))throw new Error('Invalid spreadsheet cells');
    return {range:data.range,values:Array.from({length:bounds.rows},(_,r)=>Array.from({length:bounds.columns},(_,c)=>data.values?.[r]?.[c]??''))};
  }
  async read(raw:unknown,signal?:AbortSignal):Promise<unknown>{
    const args=validate<Record<string,any>>(SheetsSchema,raw);
    if(args.action==='read')return {origin:'external:google-sheets',...await this.metadata(args.spreadsheetId,signal),url:`https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`};
    if(args.action!=='values')throw new Error('Sheet updates must be prepared for approval');
    return {origin:'external:google-sheets',spreadsheetId:args.spreadsheetId,...await this.cells(args.spreadsheetId,args.range,args.render??'FORMATTED_VALUE',signal),completeRange:true,note:'Only this bounded rectangle, not the complete spreadsheet',retrievedAt:new Date().toISOString()};
  }
  async prepare(raw:unknown,signal?:AbortSignal):Promise<Record<string,unknown>>{
    const args=validate<Record<string,any>>(SheetsSchema,raw);if(args.action!=='update')throw new Error('Expected a sheet update');
    const bounds=sheetRange(args.range);this.scope(true);
    if(args.values.length!==bounds.rows||args.values.some((row:unknown[])=>row.length!==bounds.columns))throw new Error('Values must exactly fill the approved rectangle; use empty strings to clear cells');
    const metadata=await this.metadata(args.spreadsheetId,signal),before=await this.cells(args.spreadsheetId,args.range,'FORMULA',signal);
    return {spreadsheetId:args.spreadsheetId,title:metadata.properties.title,url:`https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`,range:before.range,before:before.values,values:args.values,inputMode:'RAW',concurrency:'Values are rechecked before sending, but Google Sheets provides no atomic compare-and-set for this update. Avoid concurrent edits.'};
  }
  async write(payload:Record<string,any>,signal:AbortSignal):Promise<unknown>{
    this.scope(true);validate(SheetsSchema,{action:'update',spreadsheetId:payload.spreadsheetId,range:payload.range,values:payload.values});
    const current=await this.cells(payload.spreadsheetId,payload.range,'FORMULA',signal);
    if(json(current.values)!==json(payload.before))throw Object.assign(new Error('Spreadsheet cells changed since approval'),{status:409});
    const bounds=sheetRange(payload.range);
    if(payload.values.length!==bounds.rows||payload.values.some((row:unknown[])=>row.length!==bounds.columns))throw Object.assign(new Error('Spreadsheet update shape changed'),{status:409});
    const result=await this.account.request<{spreadsheetId?:string;updatedRange?:string;updatedCells?:number}>(`${this.url(payload.spreadsheetId)}/values/${encodeURIComponent(payload.range)}?${new URLSearchParams({valueInputOption:'RAW',includeValuesInResponse:'false'})}`,this.scope(true),signal,{method:'PUT',body:{range:payload.range,majorDimension:'ROWS',values:payload.values}});
    if(result.spreadsheetId!==payload.spreadsheetId||!result.updatedRange||json(sheetRange(result.updatedRange))!==json(bounds)||result.updatedCells!==bounds.rows*bounds.columns)throw new Error('Spreadsheet acceptance receipt incomplete; inspect Google before retrying');
    return {...result,inputMode:'RAW',concurrency:'Preflight comparison, not atomic isolation from concurrent editors'};
  }
}
