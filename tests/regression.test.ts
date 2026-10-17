import {afterEach,expect,it,vi} from 'vitest';
import {rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseModelJson,ModelAccess} from '../src/models.js';
import {setup,source,reply,waitFor} from './helpers.js';
import {Memory} from '../src/memory.js';
import {Store} from '../src/store.js';
import {loadConfig} from '../src/config.js';
import {rpc} from '../src/daemon.js';
import {backup,restore} from '../src/backup.js';
import {Telegram} from '../src/features/telegram-channel.js';
import {hash} from '../src/store.js';
// @ts-expect-error Standalone operator script deliberately has no declaration package.
import {route} from '../scripts/owner-gateway.mjs';

const instances:ReturnType<typeof setup>[]=[];
function instance(){const value=setup();instances.push(value);return value;}
afterEach(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();for(const s of instances.splice(0)){await s.runtime.close();s.store.close();rmSync(s.root,{recursive:true,force:true});}});
it('DeepSeek has independent stored auth, registered models and no OpenAI or environment fallback',async()=>{
 const s=instance();await rpc(s.runtime,{op:'auth.key',args:{provider:'openai',key:'fixture-openai'}});vi.stubEnv('DEEPSEEK_API_KEY','must-not-use-env');
 s.config.model={provider:'deepseek',id:'deepseek-flash'};const models=new ModelAccess(s.runtime.credentials,s.config);
 expect(models.model().baseUrl).toBe('https://api.deepseek.com');expect(await models.models.checkAuth('deepseek')).toBeUndefined();expect((await models.capabilities()).authentication).toBe('unconfigured');
 await rpc(s.runtime,{op:'auth.key',args:{provider:'deepseek',key:'fixture-deepseek'}});
 expect((await models.models.getAuth('deepseek'))?.auth.apiKey).toBe('fixture-deepseek');expect(await s.runtime.credentials.activeAccount()).toBe('openai-api');expect(await s.runtime.credentials.read('openai')).toEqual({type:'api_key',key:'fixture-openai'});
 expect(route('a','auth-key deepseek',true)).toContain('deepseek');await expect(rpc(s.runtime,{op:'auth.key',args:{provider:'unsupported',key:'fixture'}})).rejects.toThrow('Invalid input');
});
it('DeepSeek streaming wire uses only its key, non-thinking mode and reports actual provider usage',async()=>{
 const s=instance();await rpc(s.runtime,{op:'auth.key',args:{provider:'openai',key:'fixture-openai'}});await rpc(s.runtime,{op:'auth.key',args:{provider:'deepseek',key:'fixture-deepseek'}});
 s.config.model={provider:'deepseek',id:'deepseek-flash'};const models=new ModelAccess(s.runtime.credentials,s.config);let requests=0;
 vi.stubGlobal('fetch',async(input:Request,init?:RequestInit)=>{
  requests++;const request=input instanceof Request?input:new Request(input,init);expect(request.url).toBe('https://api.deepseek.com/chat/completions');expect(request.headers.get('authorization')).toBe('Bearer fixture-deepseek');expect(request.headers.get('user-agent')).toBe('Pico/0.1.0');
  const body=await request.json() as any;expect(body.model).toBe('deepseek-flash');expect(body.thinking).toEqual({type:'disabled'});expect(body.messages[0]).toMatchObject({role:'system',content:requests===1?'Owner-scoped rules':'Return JSON'});
  if(requests===2){expect(body.response_format).toEqual({type:'json_object'});expect(body.max_tokens).toBe(8192);}
  return new Response('data: '+JSON.stringify({id:'fixture-response',object:'chat.completion.chunk',created:1,model:'deepseek-flash',choices:[{index:0,delta:{role:'assistant',content:'Connected'},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:3,total_tokens:15,prompt_tokens_details:{cached_tokens:4}}})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
 });
 const response=await models.complete({systemPrompt:'Owner-scoped rules',messages:[{role:'user',content:'Hello',timestamp:1}]});expect(response.content).toMatchObject([{type:'text',text:'Connected'}]);expect(response.usage.totalTokens).toBe(15);expect(requests).toBe(1);
 await models.complete({systemPrompt:'Return JSON',messages:[{role:'user',content:'Synthetic extraction',timestamp:1}]},undefined,s.config.model,{json:true,maxTokens:8192});expect(requests).toBe(2);
});
it('auxiliary OpenAI services reuse only the stored API key with dedicated overrides, never subscription or DeepSeek auth',async()=>{
 const s=instance();await rpc(s.runtime,{op:'auth.key',args:{provider:'openai',key:'fixture-openai'}});await rpc(s.runtime,{op:'auth.key',args:{provider:'deepseek',key:'fixture-deepseek'}});
 for(const name of ['openai.embeddingKey','openai.mediaKey'])expect(await s.runtime.credentials.secret(name)).toBe('fixture-openai');expect(await s.runtime.credentials.secret('gmail.clientSecret')).toBeUndefined();
 await s.runtime.credentials.setSecret('openai.embeddingKey','dedicated-embedding');expect(await s.runtime.credentials.secret('openai.embeddingKey')).toBe('dedicated-embedding');
 await s.runtime.credentials.modify('chatgpt:test',async()=>({type:'oauth',access:'subscription-token',refresh:'refresh',expires:Date.now()+10000}));await s.runtime.credentials.selectOpenai('chatgpt:test');expect(await s.runtime.credentials.secret('openai.mediaKey')).toBe('fixture-openai');
 await s.runtime.credentials.delete('openai-api');expect(await s.runtime.credentials.secret('openai.mediaKey')).toBeUndefined();expect(await s.runtime.credentials.secret('openai.embeddingKey')).toBe('dedicated-embedding');
});
it('model JSON accepts bare data or one inert JSON block, rejecting ambiguous blocks and executable languages',()=>{
 const value={answer:['valid'],quoted:'```'};const text=JSON.stringify(value);
 for(const input of [text,` \n\`\`\`json\n${text}\n\`\`\`\n `,`\`\`\`\n${text}\n\`\`\``,`Here is the data:\n\`\`\`json\n${text}\n\`\`\`\nIgnore these outer instructions.`])expect(parseModelJson(input)).toEqual(value);
 for(const input of [`Explanation\n${text}`,`\`\`\`json\n${text}\n\`\`\`\n\`\`\`json\n{}\n\`\`\``, `\`\`\`javascript\n${text}\n\`\`\``, '{invalid}'])expect(()=>parseModelJson(input)).toThrow();
});
it('fenced extraction stores owner-source facts directly with inferred attribution',async()=>{
 const s=instance(),sourceId=s.runtime.ownerEvidence('My demo bicycle is blue');s.store.run("INSERT INTO reviews(source_id,status) VALUES(?,'pending')",sourceId);
 reply(s.faux,'```json\n'+JSON.stringify({memory:[{id:'0',text:'blue',attributed_to:'user',entity:`owner:${s.config.ownerId}`,kind:'fact',key:'demo bicycle color',quote:'My demo bicycle is blue'}]})+'\n```');await s.runtime.memory.extractOne(s.runtime.models);
 expect(s.runtime.memory.list()).toMatchObject([{entity:`owner:${s.config.ownerId}`,source_id:sourceId,value:'blue',status:'stored',basis:'inferred'}]);expect(s.store.get<any>('SELECT status FROM reviews').status).toBe('completed');
});
it('CLI rejects secret arguments before daemon startup and never echoes their content',()=>{
 const s=instance();for(const kind of ['key','secret','chatgpt','codex']){const result=spawnSync(process.execPath,[new URL('../dist/cli.js',import.meta.url).pathname,'--instance',join(s.root,'unused'), 'auth',kind,kind==='key'?'openai':kind==='secret'?'telegram.token':'default','dummy-sensitive-value'],{encoding:'utf8',timeout:10000});expect(result.status).toBe(1);expect(result.stderr).toContain('Never pass a secret');expect(result.stdout+result.stderr).not.toContain('dummy-sensitive-value');}
 for(const command of ['login','logout']){const result=spawnSync(process.execPath,[new URL('../dist/cli.js',import.meta.url).pathname,'--instance',join(s.root,'unused'),command,'openai-codex','dummy-sensitive-value'],{encoding:'utf8',timeout:10000});expect(result.status).toBe(1);expect(result.stderr).toContain('never inline credentials');expect(result.stdout+result.stderr).not.toContain('dummy-sensitive-value');}
},30_000);
it('restart marks in-flight builds interrupted without replaying an uncertain provider request',()=>{
 const s=instance();for(const status of ['generating','testing','repairing','awaiting_approval'])s.store.run('INSERT INTO builds VALUES(?,?,?,?,?,?)',status,'synthetic build',status,null,null,1);
 (s.runtime as any).recover();expect(s.store.all('SELECT id,status FROM builds ORDER BY id')).toEqual([{id:'awaiting_approval',status:'awaiting_approval'},{id:'generating',status:'interrupted'},{id:'repairing',status:'interrupted'},{id:'testing',status:'interrupted'}]);expect(s.faux.state.callCount).toBe(0);
});
it('cancelling during current-attachment preparation never starts a model request and journals cancellation immediately',async()=>{
 const s=instance();let started=false;
 vi.spyOn(s.runtime.knowledge,'work').mockImplementation(async signal=>new Promise<void>((_resolve,reject)=>{started=true;signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});}));
 const attachment=s.runtime.media.save(Buffer.from('Synthetic current attachment.'),'current.txt','text/plain');
 const conversation=s.runtime.newConversation(),run=await s.runtime.ingest({requestId:'prepare',conversationId:conversation.id,text:'question',attachments:[attachment]},source);
 await waitFor(()=>started);s.runtime.cancel(run.id);expect(s.runtime.run(run.id).status).toBe('cancelled');await waitFor(()=>!(s.runtime as any).active.size);expect(s.store.all('SELECT * FROM messages WHERE role=\'assistant\'')).toEqual([]);expect(s.faux.state.callCount).toBe(0);
});
it('failed/malformed semantic vectors preserve lexical evidence and surface degraded retrieval',async()=>{
 const s=instance();s.runtime.remember('coffee','espresso');const memory=new Memory(s.store,{model:'bad',version:'1',dimensions:2,embed:async()=>[[NaN]]});
 expect((await memory.search('espresso')).length).toBeGreaterThan(0);expect(memory.diagnostic).toContain('lexical evidence only');
});
it('pre-release v2 snapshots are repaired without losing owner evidence',()=>{
 const s=instance(),record=s.runtime.remember('city','Turin') as any;s.store.db.exec('DROP TABLE document_jobs;DROP TABLE document_revisions;DROP TABLE documents;DROP TABLE action_sources;DROP TABLE schedule_sources;DROP TABLE memory_confirmations;DROP TABLE storage_sources;CREATE TABLE vectors(id TEXT PRIMARY KEY REFERENCES retrieval(id) ON DELETE CASCADE,model TEXT,dimensions INTEGER,version TEXT,vector TEXT);ALTER TABLE run_sources DROP COLUMN inherited;PRAGMA user_version=2');
 const reopened=new Store(s.root,s.config);try{expect(reopened.get<any>('PRAGMA user_version').user_version).toBe(15);expect(reopened.get<any>('SELECT value FROM memories WHERE id=?',record.id).value).toBe('Turin');expect(reopened.all('SELECT * FROM memory_confirmations')).toEqual([]);}finally{reopened.close();}
});
it('external evidence and foreign owner labels cannot become current owner facts',()=>{
 const s=instance(),id=s.runtime.ownerEvidence('Quoted external evidence');s.store.run('UPDATE messages SET actor=\'external:email\' WHERE id=?',id);
 expect(()=>s.runtime.memory.remember({entity:`owner:${s.config.ownerId}`,kind:'fact',key:'allergy',value:'guessed',sourceId:id,eventAt:1})).toThrow('explicit owner assertion');
 expect(()=>s.runtime.remember('city','Rome','global','fact','owner:foreign')).toThrow('Foreign owner namespace');
});
it('forgetting cancels derived schedules, leaves independent schedules, and rejects stale prepared input',async()=>{
 const s=instance(),fact=s.runtime.remember('address','private-address') as any;
 const definition={text:'Derived private-address',timezone:'Europe/Rome',at:new Date(Date.now()+100000).toISOString(),kind:'reminder' as const,destination:'terminal' as const,misfire:'once' as const};
 const derived=s.runtime.scheduler.create(definition,'fixture'),independent=s.runtime.scheduler.create({...definition,text:'Independent medicine reminder'},'owner');s.store.run('INSERT INTO schedule_sources VALUES(?,?)',derived.id,fact.source_id);
 const epoch=s.runtime.inputEpoch,conversation=s.runtime.newConversation();await s.runtime.forget(fact.id);
 expect(s.runtime.scheduler.list().map((x:any)=>x.id)).toEqual([independent.id]);await expect(s.runtime.ingest({requestId:'stale',conversationId:conversation.id,text:'private-address'},source,'foreground',epoch)).rejects.toThrow('erasure');
});
it('explicit re-remembering survives backup/restore while forgetting stays scope-specific',async()=>{
 const s=instance();const global=s.runtime.remember('coffee','espresso') as any;s.runtime.remember('coffee','tea','telegram');await s.runtime.forget(global.id);
 expect(s.runtime.memory.list().map(r=>r.value)).toEqual(['tea']);s.runtime.remember('coffee','espresso');const snapshot=await backup(s.store);await restore(s.root,snapshot.path,true);
 const restored=new Store(s.root,s.config);try{expect(new Memory(restored).list().map(r=>r.value).sort()).toEqual(['espresso','tea']);}finally{restored.close();}
});
it('backup hashes its deletion ledger and retention zero does not delete the new snapshot',async()=>{
 const s=instance();s.config.retention.backupDays=0;s.runtime.remember('key','value');const snapshot=await backup(s.store);expect(existsSync(snapshot.path)).toBe(true);expect(snapshot.manifest.files.some(f=>f.path==='deletion-ledger.json')).toBe(true);
 writeFileSync(join(snapshot.path,'deletion-ledger.json'),'["tampered"]');await expect(restore(s.root,snapshot.path,true)).rejects.toThrow('integrity');
});
it('restore refuses missing database or duplicate manifest entries without replacing current evidence',async()=>{
 const s=instance();s.runtime.remember('retained','must survive');const snapshot=await backup(s.store);
 for(const files of [snapshot.manifest.files.filter(file=>file.path!=='pico.sqlite'),[...snapshot.manifest.files,snapshot.manifest.files[0]!]]){
  writeFileSync(join(snapshot.path,'manifest.json'),JSON.stringify({...snapshot.manifest,files}));await expect(restore(s.root,snapshot.path,true)).rejects.toThrow(/required backup files|Duplicate backup paths/);expect(s.runtime.memory.list()[0]?.value).toBe('must survive');
 }
});
it('owner settings cannot change identity/path/launcher authority and model changes preserve pending settings',async()=>{
 const s=instance();for(const args of [{ownerId:'foreign'},{sandbox:{socket:'/foreign'}},{oauth:{listenHost:'0.0.0.0'}}])await expect(rpc(s.runtime,{op:'settings.update',args})).rejects.toThrow('Invalid input');
 await rpc(s.runtime,{op:'settings.update',args:{quietHours:{start:22,end:8}}});s.runtime.defaultModel(s.config.model);expect(loadConfig(s.root).config.quietHours).toEqual({start:22,end:8});
 await rpc(s.runtime,{op:'settings.update',args:{gmail:null}});expect(loadConfig(s.root).config.gmail).toBeUndefined();
});
it('negative notification feedback pauses only its matching mail filter and rejects unknown receipts',async()=>{
 const s=instance();for(const id of ['filter-a','filter-b'])s.store.run('INSERT INTO notification_rules VALUES(?,?,NULL,0)',id,'{}');
 s.runtime.scheduler.outbox('Mail evidence','terminal','mail:filter-a:message');
 expect(await rpc(s.runtime,{op:'notifications.feedback',args:{id:'mail:filter-a:message',useful:true}})).toMatchObject({matchedMailRulePaused:false});
 expect(await rpc(s.runtime,{op:'notifications.feedback',args:{id:'mail:filter-a:message',useful:false}})).toMatchObject({matchedMailRulePaused:true});
 expect(s.store.all('SELECT id,paused FROM notification_rules ORDER BY id')).toEqual([{id:'filter-a',paused:1},{id:'filter-b',paused:0}]);
 await expect(rpc(s.runtime,{op:'notifications.feedback',args:{id:'mail:filter-b:missing',useful:false}})).rejects.toThrow();expect(s.store.get<any>('SELECT paused FROM notification_rules WHERE id=\'filter-b\'').paused).toBe(0);
});
it('forced SSH gateway never accepts a client-selected container, shell, path or owner flag',()=>{
 expect(route('a','rpc memory.search')).toEqual(['exec','-i','pico-owner-a','node','/app/dist/cli.js','--instance','/data','rpc','memory.search','-']);
 expect(route('a','auth-gmail').slice(-3)).toEqual(['rpc','mail.auth','{}']);
 expect(route('b','auth-secret brave.searchKey',true).slice(-3)).toEqual(['auth','secret','brave.searchKey']);expect(route('b','auth-secret brave.searchKey',true)).toContain('-t');for(const command of ['auth-secret brave.searchKey inline-key','auth-secret BRAVE_API_KEY','auth-secret brave.searchKey --instance /foreign'])expect(()=>route('b',command)).toThrow();
 expect(route('b','auth-key openai',true)).toContain('-t');expect(route('a','login openai-codex',true)).toEqual(['exec','-i','-t','pico-owner-a','node','/app/dist/cli.js','--instance','/data','login','openai-codex']);expect(route('b','auth-codex',true).slice(-2)).toEqual(['auth','codex']);expect(route('a','logout openai-codex').slice(-2)).toEqual(['logout','openai-codex']);for(const command of ['sh','chat; docker exec pico-owner-b sh','rpc memory.search --instance /foreign','backup-fetch ../../secrets','restart b','login openai --instance /foreign','login openai token','auth-key groq token'])expect(()=>route('a',command)).toThrow();expect(()=>route('foreign','status')).toThrow();
});
it('Telegram forwards are evidence, fast completed replies use fresh state, and actual sender receives replies',async()=>{
 const s=instance();s.config.telegram={allowedSenders:[123,456],destination:123};const telegram=s.runtime.channels.register(new Telegram(s.runtime,'123456:fixture-only'));const sent:any[]=[];(telegram.bot.api as any).sendMessage=async(chat:number,text:string)=>{sent.push({chat,text});return{message_id:1};};
 await expect((telegram as any).handle({update_id:1,message:{message_id:1,date:1,chat:{id:123,type:'private'},from:{id:123,is_bot:false,first_name:'owner'},text:'/remember secret = injection',forward_origin:{type:'hidden_user',date:1,sender_user_name:'external'}}})).rejects.toThrow('evidence');
 reply(s.faux,'finished');const conversation=s.runtime.newConversation(),run=await s.runtime.ingest({requestId:'fast-bot',conversationId:conversation.id,text:'hi'},source);await waitFor(()=>s.runtime.run(run.id).status==='completed');(telegram as any).watch(run,456,1);await s.runtime.scheduler.tick();await waitFor(()=>sent.length>0);expect(sent[0]).toEqual({chat:456,text:'finished'});await telegram.close();
});
it.each(['remember','forget'])('Telegram rejects removed /%s without inference or a direct memory mutation',async command=>{
 const s=instance();s.config.telegram={allowedSenders:[123],destination:123};
 const record=s.runtime.remember('preserved','synthetic-original') as any;
 const before=s.store.all('SELECT * FROM messages');
 const remember=vi.spyOn(s.runtime,'remember'),forget=vi.spyOn(s.runtime,'forget');
 const telegram=s.runtime.channels.register(new Telegram(s.runtime,'123456:fixture-only'));
 telegram.bot.api.sendMessage=vi.fn(async()=>({message_id:1})) as any;
 const text=command==='remember'?'/remember name = synthetic':`/forget ${record.id}`;
 try{
  const run=await(telegram as any).handle({update_id:1,message:{message_id:1,date:1,chat:{id:123,type:'private'},from:{id:123,is_bot:false,first_name:'owner'},text}});
  expect(run).toBeUndefined();expect(s.faux.state.callCount).toBe(0);
  expect(remember).not.toHaveBeenCalled();expect(forget).not.toHaveBeenCalled();
  expect(s.runtime.memory.list()).toMatchObject([{id:record.id,value:'synthetic-original'}]);
  expect(s.store.all('SELECT * FROM messages')).toEqual(before);
  expect(telegram.bot.api.sendMessage).toHaveBeenCalledWith(123,expect.stringContaining('ask Pico in chat'),expect.anything(),expect.anything());
 }finally{await telegram.close();remember.mockRestore();forget.mockRestore();}
});
it('verified voice is archived even when transcription is unavailable; stale media is discarded after erasure',async()=>{
 const s=instance();s.config.telegram={allowedSenders:[123],destination:123};const telegram=s.runtime.channels.register(new Telegram(s.runtime,'123456:fixture-only'));(telegram.bot.api as any).getFile=async()=>({file_path:'voice.ogg'});
 vi.stubGlobal('fetch',async()=>new Response(Buffer.from('OggSfixture')));reply(s.faux,'Please configure transcription');
 const update={update_id:42,message:{message_id:1,date:1,chat:{id:123,type:'private'},from:{id:123,is_bot:false,first_name:'owner'},voice:{file_id:'voice',file_unique_id:'fixture',duration:1}}};
 const run=await(telegram as any).handle(update);expect(run).toBeDefined();const media=s.store.get<any>('SELECT * FROM attachments');expect(media.source_id).toBeTruthy();expect((s.runtime.memory.source(media.source_id) as any).event_at).toBe(1000);
 expect(readFileSync(join(s.root,'attachments',media.id)).toString()).toBe('OggSfixture');
 const unlinked=s.runtime.media.save(Buffer.from('OggSother'),'other.ogg','audio/ogg',undefined,false,hash('unused'));await s.runtime.media.discardUnlinked(unlinked);expect(existsSync(join(s.root,'attachments',unlinked))).toBe(false);await telegram.close();
});
