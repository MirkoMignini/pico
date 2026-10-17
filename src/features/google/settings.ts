import { Type, type Static, type TSchema } from 'typebox';
const object=<T extends Record<string,TSchema>>(properties:T)=>Type.Object(properties,{additionalProperties:false});

export const SCOPES={identity:'openid',email:'https://www.googleapis.com/auth/userinfo.email',mailRead:'https://www.googleapis.com/auth/gmail.readonly',mailSend:'https://www.googleapis.com/auth/gmail.send',docsRead:'https://www.googleapis.com/auth/documents.readonly',docsWrite:'https://www.googleapis.com/auth/documents',driveMetadata:'https://www.googleapis.com/auth/drive.metadata.readonly',calendarRead:'https://www.googleapis.com/auth/calendar.readonly',calendarWrite:'https://www.googleapis.com/auth/calendar.events',contactsRead:'https://www.googleapis.com/auth/contacts.readonly',driveRead:'https://www.googleapis.com/auth/drive.readonly',sheetsRead:'https://www.googleapis.com/auth/spreadsheets.readonly',sheetsWrite:'https://www.googleapis.com/auth/spreadsheets',tasksRead:'https://www.googleapis.com/auth/tasks.readonly',tasksWrite:'https://www.googleapis.com/auth/tasks'};
const ids=Type.Array(Type.String({minLength:1,maxLength:200}),{maxItems:100,uniqueItems:true});
export const GoogleSettingsSchema=object({
  clientId:Type.String({minLength:1,maxLength:1000}),
  mail:object({enabled:Type.Boolean(),send:Type.Boolean(),intervalMs:Type.Integer({minimum:60_000,maximum:86_400_000}),baselineMax:Type.Integer({minimum:1,maximum:1000}),push:Type.Optional(object({topic:Type.String({pattern:'^projects/[a-z][a-z0-9-]{4,62}/topics/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$'}),subscription:Type.String({pattern:'^projects/[a-z][a-z0-9-]{4,62}/subscriptions/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$'})}))}),
  docs:object({enabled:Type.Boolean(),readAll:Type.Optional(Type.Boolean()),write:Type.Boolean(),discovery:Type.Boolean(),documentIds:ids}),
  calendar:object({enabled:Type.Boolean(),write:Type.Boolean(),calendarIds:ids}),
  contacts:Type.Optional(object({enabled:Type.Boolean()})),
  drive:Type.Optional(object({enabled:Type.Boolean()})),
  sheets:Type.Optional(object({enabled:Type.Boolean(),write:Type.Boolean()})),
  tasks:Type.Optional(object({enabled:Type.Boolean(),write:Type.Boolean()}))
});
export type GoogleSettings=Static<typeof GoogleSettingsSchema>;
export const defaultSettings=(clientId='YOUR_DESKTOP_CLIENT_ID'):GoogleSettings=>({clientId,mail:{enabled:true,send:false,intervalMs:60_000,baselineMax:200},docs:{enabled:false,readAll:false,write:false,discovery:false,documentIds:[]},calendar:{enabled:false,write:false,calendarIds:['primary']},contacts:{enabled:false},drive:{enabled:false},sheets:{enabled:false,write:false},tasks:{enabled:false,write:false}});
export function googleScopes(settings:GoogleSettings):string[]{
  return [SCOPES.identity,SCOPES.email,
    ...(settings.mail.enabled?[SCOPES.mailRead,...(settings.mail.send?[SCOPES.mailSend]:[])]:[]),
    ...(settings.docs.enabled?[settings.docs.write?SCOPES.docsWrite:SCOPES.docsRead,...(settings.docs.discovery&&!settings.drive?.enabled?[SCOPES.driveMetadata]:[])]:[]),
    ...(settings.calendar.enabled?[SCOPES.calendarRead,...(settings.calendar.write?[SCOPES.calendarWrite]:[])]:[]),
    ...(settings.contacts?.enabled?[SCOPES.contactsRead]:[]),...(settings.drive?.enabled?[SCOPES.driveRead]:[]),
    ...(settings.sheets?.enabled?[settings.sheets.write?SCOPES.sheetsWrite:SCOPES.sheetsRead]:[]),
    ...(settings.tasks?.enabled?[settings.tasks.write?SCOPES.tasksWrite:SCOPES.tasksRead]:[])
  ];
}
export const toolSchema = (branches: import('typebox').TObject[]): import('typebox').TObject => {
  const properties=Object.assign({},...branches.map(branch=>branch.properties));
  return object({...Type.Partial(object(properties)).properties,action:Type.Union(branches.map(branch=>branch.properties.action!))});
};
