import { Type } from 'typebox';
import { object, validate } from '../../contracts.js';
import { instant, dayRange } from '../../time.js';
import type { AgendaContribution } from '../../extensions.js';
import type { OAuthAccount } from '../integrations/oauth.js';
import { SCOPES, toolSchema, type GoogleSettings } from './settings.js';

const remoteId=Type.String({minLength:1,maxLength:200}),date=Type.String({minLength:10,maxLength:40});
const fields={title:Type.String({minLength:1,maxLength:300}),start:date,end:date,timezone:Type.Optional(Type.String({maxLength:100})),location:Type.Optional(Type.String({maxLength:1000})),notes:Type.Optional(Type.String({maxLength:4000}))};
const target={calendarId:remoteId,eventId:remoteId,expectedEtag:Type.String({minLength:1,maxLength:1000,pattern:'^[^\\r\\n]+$'})};
export const GoogleCalendarSchema=Type.Union([
  object({action:Type.Literal('calendars')}),
  object({action:Type.Literal('list'),calendarId:remoteId,from:date,to:date,pageToken:Type.Optional(Type.String({maxLength:2000})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))}),
  object({action:Type.Literal('read'),calendarId:remoteId,eventId:remoteId}),
  object({action:Type.Literal('freebusy'),from:date,to:date}),
  object({action:Type.Literal('create'),calendarId:remoteId,...fields}),
  object({action:Type.Literal('update'),...target,...Type.Partial(object(fields)).properties}),
  object({action:Type.Literal('delete'),...target})
]);
export const GoogleCalendarToolSchema=toolSchema(GoogleCalendarSchema.anyOf);
interface CalendarTime {date?:string;dateTime?:string;timeZone?:string}
interface GoogleEvent {id:string;etag:string;summary?:string;description?:string;location?:string;status?:string;start?:CalendarTime;end?:CalendarTime;htmlLink?:string;recurrence?:string[];recurringEventId?:string;attendees?:unknown[];attendeesOmitted?:boolean;organizer?:unknown}
function range(from:string,to:string):void{const start=instant(from),end=instant(to);if(end<=start||end-start>367*86_400_000)throw new Error('Calendar query range must be positive and at most 367 days');}
export function eventBody(payload:Record<string,any>,defaultTimezone:string):Record<string,unknown>{
  const body:Record<string,unknown>={};if(payload.title!==undefined){if(!payload.title.trim())throw new Error('Event title cannot be blank');body.summary=payload.title;}
  if(payload.location!==undefined)body.location=payload.location;if(payload.notes!==undefined)body.description=payload.notes;
  if(payload.start!==undefined||payload.end!==undefined){
    if(payload.start===undefined||payload.end===undefined)throw new Error('Supply both start and end when changing event time');
    const allDay=/^\d{4}-\d{2}-\d{2}$/.test(payload.start);if(allDay!==/^\d{4}-\d{2}-\d{2}$/.test(payload.end))throw new Error('Do not mix all-day dates and timed events');
    const start=instant(allDay?`${payload.start}T00:00:00Z`:payload.start),end=instant(allDay?`${payload.end}T00:00:00Z`:payload.end);
    if(end<=start||end-start>366*86_400_000)throw new Error('Event must have a positive duration of at most 366 days; all-day end is exclusive');
    const timeZone=payload.timezone??defaultTimezone;new Intl.DateTimeFormat('en',{timeZone});
    body.start=allDay?{date:payload.start}:{dateTime:payload.start,timeZone};body.end=allDay?{date:payload.end}:{dateTime:payload.end,timeZone};
  }else if(payload.timezone!==undefined)throw new Error('Timezone changes require start and end');
  if(!Object.keys(body).length)throw new Error('Calendar update needs a changed field');return body;
}
export class GoogleCalendar {
  constructor(readonly account:OAuthAccount,readonly settings:GoogleSettings,readonly timezone:string){}
  private enabled():void{if(!this.settings.calendar.enabled)throw new Error('Google Calendar disabled');}
  allowed(calendarId:string):void{this.enabled();if(!this.settings.calendar.calendarIds.includes(calendarId))throw new Error('Calendar is not selected in Google extension settings');}
  private eventUrl(calendarId:string,eventId?:string):string{return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events${eventId?`/${encodeURIComponent(eventId)}`:''}`;}
  async list(calendarId:string,from:string,to:string,pageToken?:string,limit=100,signal?:AbortSignal):Promise<{items:GoogleEvent[];nextPageToken:string|null;timeZone:string}>{
    this.allowed(calendarId);range(from,to);
    const data=await this.account.request<{items?:GoogleEvent[];nextPageToken?:string;timeZone?:string}>(`${this.eventUrl(calendarId)}?${new URLSearchParams({timeMin:from,timeMax:to,singleEvents:'true',orderBy:'startTime',showDeleted:'false',maxResults:String(limit),...(pageToken?{pageToken}:{})})}`,[SCOPES.calendarRead],signal);
    return {items:data.items??[],nextPageToken:data.nextPageToken??null,timeZone:data.timeZone??this.timezone};
  }
  async get(calendarId:string,eventId:string,signal?:AbortSignal):Promise<GoogleEvent>{this.allowed(calendarId);return this.account.request(this.eventUrl(calendarId,eventId),[SCOPES.calendarRead],signal);}
  async read(raw:unknown,signal?:AbortSignal):Promise<unknown>{
    const args=validate<Record<string,any>>(GoogleCalendarSchema,raw);this.enabled();
    if(args.action==='calendars'){
      const selected:unknown[]=[];for(const calendarId of this.settings.calendar.calendarIds)selected.push(await this.account.request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`,[SCOPES.calendarRead],signal));
      return {origin:'external:google-calendar',calendars:selected};
    }
    if(args.action==='freebusy'){range(args.from,args.to);return this.account.request('https://www.googleapis.com/calendar/v3/freeBusy',[SCOPES.calendarRead],signal,{method:'POST',body:{timeMin:args.from,timeMax:args.to,timeZone:this.timezone,items:this.settings.calendar.calendarIds.map(id=>({id}))}});}
    if(args.action==='read')return {origin:'external:google-calendar',calendarId:args.calendarId,event:await this.get(args.calendarId,args.eventId,signal),retrievedAt:new Date().toISOString()};
    return {origin:'external:google-calendar',calendarId:args.calendarId,...await this.list(args.calendarId,args.from,args.to,args.pageToken,args.limit??100,signal),retrievedAt:new Date().toISOString()};
  }
  async agenda(range:{from:string;to:string;timezone:string},signal?:AbortSignal):Promise<AgendaContribution>{
    const result:AgendaContribution={items:[],warnings:[],truncated:false};if(!this.settings.calendar.enabled)return result;
    for(const calendarId of this.settings.calendar.calendarIds){let page:string|undefined,pages=0;
      do{
        const data=await this.list(calendarId,range.from,range.to,page,100,signal);
        for(const event of data.items){
          if(event.status==='cancelled'||!event.start||!event.end)continue;
          const allDay=!!event.start.date,start=allDay?new Date(dayRange(event.start.date,'today',data.timeZone).from).toISOString():event.start.dateTime,end=allDay?new Date(dayRange(event.end.date,'today',data.timeZone).from).toISOString():event.end.dateTime;
          if(!start||!end){result.truncated=true;result.warnings.push('Unsupported Google event time');continue;}
          result.items.push({id:`google:${calendarId}:${event.id}`,title:event.summary??'(untitled event)',at:start,end,origin:`google:${calendarId}`,allDay,url:event.htmlLink,location:event.location});
        }
        page=data.nextPageToken??undefined;
        if(result.items.length>=1000||++pages>=100){result.truncated=true;result.warnings.push('External agenda bounded at 1000 events');return {...result,items:result.items.slice(0,1000)};}
      }while(page);
    }
    return result;
  }
  async write(kind:string,payload:Record<string,any>,signal:AbortSignal,actionId:string):Promise<unknown>{
    this.allowed(payload.calendarId);if(!this.settings.calendar.write)throw new Error('Google Calendar writes disabled');
    if(kind==='calendar.create')return this.account.request(`${this.eventUrl(payload.calendarId)}?sendUpdates=none`,[SCOPES.calendarWrite],signal,{method:'POST',body:{...eventBody(payload,this.timezone),id:actionId.replaceAll('-','')}});
    const current=await this.get(payload.calendarId,payload.eventId,signal);
    if(current.etag!==payload.expectedEtag)throw Object.assign(new Error('Calendar revision conflict'),{status:412});
    if(current.attendeesOmitted||current.attendees?.length||current.recurrence?.length)throw Object.assign(new Error('Guest invitations and recurring-series writes are not enabled'),{status:403});
    return this.account.request(`${this.eventUrl(payload.calendarId,payload.eventId)}?sendUpdates=none`,[SCOPES.calendarWrite],signal,{method:kind==='calendar.delete'?'DELETE':'PATCH',headers:{'If-Match':payload.expectedEtag},...(kind==='calendar.delete'?{}:{body:eventBody(payload,this.timezone)})});
  }
}
