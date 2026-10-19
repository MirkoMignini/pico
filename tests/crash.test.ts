import {expect,it} from 'vitest';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialize} from '../src/config.js';
import {Client} from '../src/client.js';
import {waitFor} from './helpers.js';
const fixture=new URL('./daemon-child.mjs',import.meta.url);
async function start(root:string,scenario:string,endpoint=''){
 const child=spawn(process.execPath,[fixture.pathname,root,scenario,endpoint],{stdio:['ignore','pipe','pipe']});let output='';child.stdout!.on('data',chunk=>output+=chunk);child.stderr!.on('data',()=>{});
 await waitFor(()=>output.includes('READY')||child.exitCode!==null,10000);if(!output.includes('READY'))throw new Error('Fault fixture exited before startup');return child;
}
async function kill(child:ChildProcess|undefined,signal:NodeJS.Signals='SIGKILL'){if(!child||child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');child.kill(signal);await exited;}
function root(){const path=mkdtempSync(join(tmpdir(),'pikobot-crash-')),config=initialize(path,'synthetic-crash-owner');delete config.embeddings;writeFileSync(join(path,'config.json'),JSON.stringify(config),{mode:0o600});return path;}
it('real SIGKILL during streaming releases authority; receipt resumes without duplicating input',async()=>{
 const path=root(),client=new Client(path);let child:ChildProcess|undefined;
 try{
  child=await start(path,'stream');const conversation=await client.rpc<any>('new');const input={requestId:'killed-stream',conversationId:conversation.id,text:'Fixture only'};const run=await client.rpc<any>('input',input);
  let partial=false;
  for(let i=0;i<100&&!partial;i++){const current=await client.rpc<any>('run',{id:run.id});partial=current.partial.length>0;if(!partial)await new Promise(resolve=>setTimeout(resolve,20));}expect(partial).toBe(true);
  await kill(child);child=await start(path,'recovered');let settled:any;for(let i=0;i<100;i++){settled=await client.rpc<any>('run',{id:run.id});if(settled.status==='completed')break;await new Promise(resolve=>setTimeout(resolve,20));}
  expect(settled.status).toBe('completed');expect(settled.partial).toBe('Recovered safely');const receipt=await client.rpc<any>('input.receipt',{requestId:input.requestId});expect(receipt.id).toBe(run.id);
  const history=await client.rpc<any[]>('history',{conversationId:conversation.id});expect(history.filter(m=>m.role==='user')).toHaveLength(1);
 }finally{await kill(child);rmSync(path,{recursive:true,force:true});}
},30000);
it('real accepted external fixture effect plus SIGKILL leaves uncertain intent and is never automatically replayed',async()=>{
 const path=root(),client=new Client(path);let child:ChildProcess|undefined,count=0;
 const receiver=createServer((request,response)=>{count++;request.resume();response.writeHead(200);/* Deliberately lose the acknowledgment body. */});await new Promise<void>(resolve=>receiver.listen(0,'127.0.0.1',resolve));
 try{
  const endpoint=`http://127.0.0.1:${(receiver.address() as any).port}`;child=await start(path,'intent',endpoint);const conversation=await client.rpc<any>('new'),run=await client.rpc<any>('input',{requestId:'killed-intent',conversationId:conversation.id,text:'Fixture only'});
  await waitFor(()=>count===1);await kill(child);child=await start(path,'intent',endpoint);const recovered=await client.rpc<any>('run',{id:run.id});expect(recovered.status).toBe('interrupted');expect(recovered.error).toContain('uncertain');await new Promise(resolve=>setTimeout(resolve,300));expect(count).toBe(1);
 }finally{await kill(child);receiver.closeAllConnections();await new Promise<void>(resolve=>receiver.close(()=>resolve()));rmSync(path,{recursive:true,force:true});}
},30000);
