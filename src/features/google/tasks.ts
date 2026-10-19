import { Type } from 'typebox';
import { object, validate } from '../../contracts.js';
import { instant } from '../../time.js';
import type { OAuthAccount } from '../integrations/oauth.js';
import { SCOPES, toolSchema, type GoogleSettings } from './settings.js';

const taskId=Type.String({minLength:1,maxLength:1000,pattern:'^(?!\\.{1,2}$)[A-Za-z0-9_@=+.-]+$'}),taskListId=taskId;
const target={taskListId,taskId},versioned={...target,expectedEtag:Type.String({minLength:1,maxLength:1000,pattern:'^[^\\r\\n]+$'})};
const fields={title:Type.String({minLength:1,maxLength:1024}),notes:Type.Optional(Type.String({maxLength:8192})),dueDate:Type.Optional(Type.Union([Type.String({pattern:'^\\d{4}-\\d{2}-\\d{2}$'}),Type.Null()]))};
const page={pageToken:Type.Optional(Type.String({maxLength:2000})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))};
export const TasksSchema=Type.Union([
  object({action:Type.Literal('lists'),...page}),
  object({action:Type.Literal('list'),taskListId,includeCompleted:Type.Optional(Type.Boolean()),...page}),
  object({action:Type.Literal('read'),...target}),
  object({action:Type.Literal('create'),taskListId,...fields}),
  object({action:Type.Literal('update'),...versioned,...Type.Partial(object(fields)).properties}),
  object({action:Type.Literal('complete'),...versioned}),
  object({action:Type.Literal('reopen'),...versioned}),
  object({action:Type.Literal('delete'),...versioned})
]);
export const TasksToolSchema=toolSchema(TasksSchema.anyOf);
interface Task {id:string;etag:string;title?:string;notes?:string;due?:string;status?:string;assignmentInfo?:unknown;deleted?:boolean}
export class GoogleTasks {
  constructor(readonly account:OAuthAccount,readonly settings:GoogleSettings){}
  private scope(write=false):string[]{
    if(!this.settings.tasks?.enabled)throw new Error('Google Tasks disabled');
    if(write&&!this.settings.tasks.write)throw new Error('Google Tasks writes disabled');
    return [this.settings.tasks.write?SCOPES.tasksWrite:SCOPES.tasksRead];
  }
  private url(list:string,id?:string):string{validate(taskListId,list);if(id!==undefined)validate(taskId,id);return `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(list)}/tasks${id===undefined?'':`/${encodeURIComponent(id)}`}`;}
  private async get(list:string,id:string,signal?:AbortSignal):Promise<Task>{
    const task=await this.account.request<Task>(this.url(list,id),this.scope(),signal);
    if(task.id!==id||typeof task.etag!=='string'||!task.etag||task.deleted)throw new Error('Invalid or deleted Google task');return task;
  }
  async read(raw:unknown,signal?:AbortSignal):Promise<unknown>{
    const args=validate<Record<string,any>>(TasksSchema,raw),scopes=this.scope();
    if(args.action==='read')return {origin:'external:google-tasks',taskListId:args.taskListId,task:await this.get(args.taskListId,args.taskId,signal)};
    if(!['lists','list'].includes(args.action))throw new Error('Task mutations must be prepared for approval');
    const params={maxResults:String(args.limit??100),...(args.pageToken?{pageToken:args.pageToken}:{})};
    const url=args.action==='lists'?`https://tasks.googleapis.com/tasks/v1/users/@me/lists?${new URLSearchParams(params)}`:`${this.url(args.taskListId)}?${new URLSearchParams({...params,showCompleted:String(args.includeCompleted??false),showHidden:String(args.includeCompleted??false),showDeleted:'false'})}`;
    const data=await this.account.request<{items?:unknown[];nextPageToken?:string}>(url,scopes,signal);
    return {origin:'external:google-tasks',items:data.items??[],nextPageToken:data.nextPageToken??null,note:'Google Tasks due values are dates, not timed alarms or Pikobot reminders'};
  }
  private body(args:Record<string,any>):Record<string,unknown>{
    const body:Record<string,unknown>={};
    if(args.title!==undefined){if(!args.title.trim())throw new Error('Task title cannot be blank');body.title=args.title;}
    if(args.notes!==undefined)body.notes=args.notes;
    if(args.dueDate!==undefined){if(args.dueDate!==null)instant(`${args.dueDate}T00:00:00Z`);body.due=args.dueDate===null?null:`${args.dueDate}T00:00:00.000Z`;}
    if(!Object.keys(body).length)throw new Error('Task update needs a changed field');return body;
  }
  async prepare(raw:unknown,signal?:AbortSignal):Promise<{kind:string;payload:Record<string,unknown>}>{
    const args=validate<Record<string,any>>(TasksSchema,raw);this.scope(true);
    if(!['create','update','complete','reopen','delete'].includes(args.action))throw new Error('Expected a task mutation');
    await this.account.token(signal,this.scope(true));
    const body=args.action==='create'||args.action==='update'?this.body(args):args.action==='complete'?{status:'completed'}:args.action==='reopen'?{status:'needsAction',completed:null}:undefined;
    if(args.action==='create')return {kind:'tasks.create',payload:{taskListId:args.taskListId,body}};
    const current=await this.get(args.taskListId,args.taskId,signal);
    if(current.etag!==args.expectedEtag)throw Object.assign(new Error('Task revision conflict'),{status:412});
    if(current.assignmentInfo)throw Object.assign(new Error('Assigned Docs/Chat tasks must be managed in their source application'),{status:403});
    return {kind:`tasks.${args.action}`,payload:{taskListId:args.taskListId,taskId:args.taskId,expectedEtag:args.expectedEtag,before:current,...(body?{body}:{})}};
  }
  async write(kind:string,payload:Record<string,any>,signal:AbortSignal):Promise<unknown>{
    const scopes=this.scope(true);if(!['tasks.create','tasks.update','tasks.complete','tasks.reopen','tasks.delete'].includes(kind))throw Object.assign(new Error('Unsupported task mutation'),{status:400});
    if(kind==='tasks.create'){
      const task=await this.account.request<Task>(this.url(payload.taskListId),scopes,signal,{method:'POST',body:payload.body});if(!task.id)throw new Error('Task acceptance receipt missing');return {accepted:true,task};
    }
    const current=await this.get(payload.taskListId,payload.taskId,signal);
    if(current.etag!==payload.expectedEtag)throw Object.assign(new Error('Task revision conflict'),{status:412});
    if(current.assignmentInfo)throw Object.assign(new Error('Assigned task mutation refused'),{status:403});
    const task=await this.account.request<Task|undefined>(this.url(payload.taskListId,payload.taskId),scopes,signal,{method:kind==='tasks.delete'?'DELETE':'PATCH',headers:{'If-Match':payload.expectedEtag},...(kind==='tasks.delete'?{}:{body:payload.body})});
    if(kind!=='tasks.delete'&&task?.id!==payload.taskId)throw new Error('Task acceptance receipt missing');return {accepted:true,deleted:kind==='tasks.delete',task:task??null};
  }
}
