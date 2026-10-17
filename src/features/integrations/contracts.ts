export interface MailMessage {
  id: string; threadId: string; eventAt: number; from: string; subject: string; text: string; link: string;
  to?: string; cc?: string; replyTo?: string; messageId?: string; references?: string; labels?: string[]; truncated?: boolean;
  attachments: {id:string;name:string;mime:string;bytes:number}[];
}
// Connectors must namespace IDs across providers/accounts; existing Gmail source IDs remain unchanged for compatibility.
export interface MailConnector {
  search(query:string,signal?:AbortSignal):Promise<string[]>;
  read(id:string,signal?:AbortSignal):Promise<MailMessage>;
  attachment(messageId:string,attachmentId:string,signal?:AbortSignal):Promise<Uint8Array>;
  changes(cursor?:string,signal?:AbortSignal):Promise<{ids:string[];deleted:string[];cursor:string;baseline:boolean}>;
}
export interface RemoteAction {
  id: string; kind: string; payload: Record<string,unknown>; digest: string; connection: string;
  createdAt: number; expiresAt: number; status: 'pending'|'executing'|'accepted'|'rejected'|'uncertain';
  result?: unknown;
}
