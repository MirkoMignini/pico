import { Type } from 'typebox';
import { object, validate } from '../../contracts.js';
import type { OAuthAccount } from '../integrations/oauth.js';
import { SCOPES, toolSchema, type GoogleSettings } from './settings.js';

const page={pageToken:Type.Optional(Type.String({maxLength:2000})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))};
export const ContactsSchema=Type.Union([
  object({action:Type.Literal('list'),...page}),
  object({action:Type.Literal('search'),query:Type.String({minLength:1,maxLength:200}),limit:Type.Optional(Type.Integer({minimum:1,maximum:30}))}),
  object({action:Type.Literal('read'),resourceName:Type.String({pattern:'^people/[A-Za-z0-9_-]{1,200}$'})})
]);
export const ContactsToolSchema=toolSchema(ContactsSchema.anyOf);
const fields='names,emailAddresses,phoneNumbers,organizations';
export class GoogleContacts {
  constructor(readonly account:OAuthAccount,readonly settings:GoogleSettings){}
  async read(raw:unknown,signal?:AbortSignal):Promise<unknown>{
    const args=validate<Record<string,any>>(ContactsSchema,raw);
    if(!this.settings.contacts?.enabled)throw new Error('Google Contacts disabled');
    const get=<T>(path:string,params:Record<string,string>)=>this.account.request<T>(`https://people.googleapis.com/v1/${path}?${new URLSearchParams(params)}`,[SCOPES.contactsRead],signal);
    if(args.action==='search'){
      // Google requires an empty-query warmup for its contact search cache.
      await get('people:searchContacts',{query:'',readMask:fields,pageSize:'1'});
      const data=await get<{results?:unknown[]}>('people:searchContacts',{query:args.query,readMask:fields,pageSize:String(args.limit??30)});
      return {origin:'external:google-contacts',results:data.results??[],complete:false,note:'Bounded prefix search, not the complete address book. Do not guess between matching people.'};
    }
    if(args.action==='read'){
      const person=await get<{resourceName:string}>(args.resourceName,{personFields:fields});if(person.resourceName!==args.resourceName)throw new Error('Contact response identity mismatch');
      return {origin:'external:google-contacts',person};
    }
    const data=await get<{connections?:unknown[];nextPageToken?:string;totalPeople?:number}>('people/me/connections',{personFields:fields,pageSize:String(args.limit??100),sortOrder:'FIRST_NAME_ASCENDING',...(args.pageToken?{pageToken:args.pageToken}:{})});
    return {origin:'external:google-contacts',people:data.connections??[],nextPageToken:data.nextPageToken??null,totalPeople:data.totalPeople??null};
  }
}
