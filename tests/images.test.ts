import { afterEach, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { Runtime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { backup, exportData, restore } from '../src/backup.js';
import { rpc } from '../src/daemon.js';
import { loadConfig } from '../src/config.js';
import type { Envelope } from '../src/contracts.js';
import { setup, source, waitFor, loadTools } from './helpers.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=','base64');
const instances:ReturnType<typeof setup>[]=[],directories:string[]=[];
const instance=()=>{const s=setup();instances.push(s);return s;};
afterEach(async()=>{for(const s of instances.splice(0)){await s.runtime.close();s.store.close();rmSync(s.root,{recursive:true,force:true});}for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});vi.unstubAllGlobals();vi.restoreAllMocks();});
const owner=(s:ReturnType<typeof setup>):Envelope=>({ownerId:s.config.ownerId,instanceId:s.config.instanceId,conversationId:'',runId:crypto.randomUUID(),source:{...source,identity:'owner-ipc'},mode:'foreground'});
const response=()=>Response.json({data:[{b64_json:png.toString('base64')}],usage:{input_tokens:3,output_tokens:7,total_tokens:10,untrusted:'not stored'}});
async function configured(){const s=instance();s.config.imageGeneration={provider:'openai',model:'gpt-image-1',quality:'low'};await s.runtime.credentials.modify('openai-api',async()=>({type:'api_key',key:'fixture-image-key'}));return s;}
async function invoke(s:ReturnType<typeof setup>,args:Record<string,unknown>={prompt:'A synthetic blue circle'}) {const result=await s.runtime.invokeExtension('image_generate',args,owner(s));return JSON.parse((result.content[0] as {text:string}).text);}
async function turn(s:ReturnType<typeof setup>,mode:Envelope['mode']='foreground',trustedOwner=true){
  const conversation=s.runtime.newConversation('Synthetic image test',mode==='ephemeral');
  s.faux.appendResponses([loadTools('image_generate'),fauxAssistantMessage([fauxToolCall('image_generate',{prompt:'A synthetic blue circle'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Image receipt checked')])]);
  const run=await s.runtime.ingest({requestId:crypto.randomUUID(),conversationId:conversation.id,text:'Create a synthetic blue circle'}, {...source,trustedOwner},mode);
  await waitFor(()=>s.runtime.run(run.id).status==='completed');
  const messages=mode==='ephemeral'?s.runtime.history(conversation.id):s.store.all<{body:string}>('SELECT body FROM messages WHERE run_id=?',run.id).map(row=>JSON.parse(row.body));
  return {run,result:messages.find((message:any)=>message.role==='toolResult'&&message.toolName==='image_generate') as any};
}

it('presents existing images without Telegram, generation or model-visible pixels and recovers scoped previews from receipts',async()=>{
  const s=instance(),sourceId=s.runtime.ownerEvidence('Synthetic saved image'),attachmentId=s.runtime.media.save(png,'saved.png','image/png',undefined,false,'a'.repeat(64));s.runtime.media.link(attachmentId,sourceId,s.runtime.newConversation('Original').id);
  const events:any[]=[],fetch=vi.fn();vi.stubGlobal('fetch',fetch);s.runtime.events.on('output',event=>{if(event.type==='image')events.push(event);});
  const context=owner(s),result=await s.runtime.invokeExtension('image_show',{attachmentId},context),image=JSON.parse((result.content[0] as {text:string}).text),conversationId=s.store.meta('extensionConversation')!;
  expect(image).toMatchObject({attachmentId,mime:'image/png',synthetic:false,displayed:true});expect(image.data).toBeUndefined();expect(events).toMatchObject([{conversationId,runId:context.runId,data:{attachmentId}}]);
  expect(await rpc(s.runtime,{op:'images.preview',args:{attachmentId}})).toMatchObject({data:png.toString('base64'),synthetic:false});
  expect(await rpc(s.runtime,{op:'images.previews',args:{conversationId}})).toEqual({images:[{attachmentId}]});expect(s.runtime.images.previews(s.runtime.newConversation('Unrelated').id).images).toEqual([]);
  expect(s.store.all('SELECT source_id FROM run_sources WHERE run_id=?',context.runId)).toContainEqual({source_id:sourceId});
  expect(JSON.stringify(s.store.all('SELECT result FROM operations'))).not.toContain(png.toString('base64'));expect(s.runtime.images.list({}).total).toBe(0);expect(fetch).not.toHaveBeenCalled();
  await s.runtime.close();s.runtime=new Runtime(s.store,s.runtime.models);expect(s.runtime.images.previews(conversationId).images).toEqual([{attachmentId}]);expect(s.faux.state.callCount).toBe(0);
});
it('previews image document originals by immutable revision, even after raw attachment expiry',async()=>{
  const s=instance(),attachmentId=s.runtime.media.save(png,'document.png','image/png'),doc=await s.runtime.knowledge.importAttachment(attachmentId,'preview-document');
  s.store.run("UPDATE attachments SET status='expired' WHERE id=?",attachmentId);
  const context=owner(s),result=await s.runtime.invokeExtension('image_show',{documentId:doc.id},context),image=JSON.parse((result.content[0] as {text:string}).text);
  expect(image).toMatchObject({documentId:doc.id,revision:1,sourceId:`document:${doc.id}:r1`,mime:'image/png',displayed:true});
  expect(await rpc(s.runtime,{op:'images.preview',args:{documentId:doc.id,revision:1}})).toMatchObject({data:png.toString('base64')});
  expect(s.runtime.images.previews(s.store.meta('extensionConversation')!).images).toEqual([{documentId:doc.id,revision:1}]);
  expect(s.store.all('SELECT source_id FROM run_sources WHERE run_id=?',context.runId)).toContainEqual({source_id:`document:${doc.id}:r1`});
});
it.each(['jpeg','gif','webp'] as const)('renders a real %s original as a bounded PNG preview without changing the saved file',async format=>{
  const s=instance(),{RawImage}=await import('@huggingface/transformers'),encoder=new RawImage(new Uint8ClampedArray([20,40,200,200,40,20]),2,1,3).toSharp();
  const bytes=await (format==='jpeg'?encoder.withMetadata({orientation:6}):encoder).toFormat(format).toBuffer(),mime=`image/${format}`,attachmentId=s.runtime.media.save(bytes,`preview.${format}`,mime),preview=await s.runtime.images.preview({attachmentId}),pngBytes=Buffer.from(preview.data,'base64');
  expect(preview.mime).toBe('image/png');expect(pngBytes.subarray(0,8)).toEqual(png.subarray(0,8));expect([pngBytes.readUInt32BE(16),pngBytes.readUInt32BE(20)]).toEqual(format==='jpeg'?[1,2]:[2,1]);
  expect(Buffer.from((await s.runtime.media.read(attachmentId)).bytes)).toEqual(bytes);expect(s.store.get('SELECT mime FROM attachments WHERE id=?',attachmentId)).toEqual({mime});
},20_000);
it('rejects excessive decoded dimensions before normalizing a non-PNG preview',async()=>{
  const s=instance(),attachmentId=s.runtime.media.save(Buffer.from('474946383961881388138000','hex'),'huge.gif','image/gif');
  await expect(s.runtime.images.preview({attachmentId})).rejects.toThrow('pixel limit');
});
it('rejects invalid image references, non-images, volatile/foreign media, expired originals and tampered bytes',async()=>{
  const s=instance(),attachmentId=s.runtime.media.save(png,'saved.png','image/png'),text=s.runtime.media.save(Buffer.from('not an image'),'text.txt','text/plain'),volatile=s.runtime.media.save(png,'private.png','image/png',undefined,true);
  for(const args of [{},{attachmentId,documentId:crypto.randomUUID()},{attachmentId,revision:1},{attachmentId,ownerId:'foreign'},{attachmentId:'../../secrets.json'},{attachmentId:text},{attachmentId:volatile},{attachmentId:crypto.randomUUID()}])await expect(rpc(s.runtime,{op:'images.preview',args})).rejects.toThrow();
  await expect(rpc(s.runtime,{op:'images.previews',args:{}})).rejects.toThrow('Invalid input');
  s.store.run("UPDATE attachments SET status='expired' WHERE id=?",attachmentId);await expect(s.runtime.images.preview({attachmentId})).rejects.toThrow('expired');
  s.store.run("UPDATE attachments SET status='stored' WHERE id=?",attachmentId);writeFileSync(join(s.root,'attachments',attachmentId),Buffer.from('tampered'));await expect(s.runtime.images.preview({attachmentId})).rejects.toThrow('integrity');
});
it.each(['ephemeral','scheduled','review','untrusted','foreign'])('denies image presentation before media reads in %s work',async mode=>{
  const s=instance(),read=vi.spyOn(s.runtime.media,'read'),context=owner(s);
  if(mode==='foreign')context.ownerId='foreign';else if(mode==='untrusted')context.source.trustedOwner=false;else context.mode=mode as Envelope['mode'];
  await expect(s.runtime.images.show({attachmentId:crypto.randomUUID()},context)).rejects.toThrow(/ownership|trusted retained/);expect(read).not.toHaveBeenCalled();expect(s.store.all('SELECT * FROM operations')).toEqual([]);
});
it('does not publish a preview when cancelled while reading its attachment',async()=>{
  const s=instance(),attachmentId=s.runtime.media.save(png,'saved.png','image/png'),read=s.runtime.media.read.bind(s.runtime.media);let release!:()=>void;
  vi.spyOn(s.runtime.media,'read').mockImplementation(async id=>{await new Promise<void>(resolve=>{release=resolve;});return read(id);});
  const controller=new AbortController(),work=s.runtime.images.show({attachmentId},owner(s),controller.signal),failure=expect(work).rejects.toThrow('Cancelled');await waitFor(()=>!!release);controller.abort(new Error('Cancelled'));release();await failure;
  expect(s.store.all('SELECT * FROM run_sources')).toEqual([]);
});
it('forgets existing-image preview receipts and prevents recovery from an old backup',async()=>{
  const s=instance(),sourceId=s.runtime.ownerEvidence('Synthetic erasable image'),attachmentId=s.runtime.media.save(png,'erase.png','image/png');s.runtime.media.link(attachmentId,sourceId,s.runtime.newConversation('Source').id);
  const memory=s.runtime.memory.remember({sourceId,entity:`owner:${s.config.ownerId}`,kind:'fact',key:'image-fixture',value:'Synthetic erasable image',quote:'Synthetic erasable image',eventAt:Date.now()},false);
  await s.runtime.invokeExtension('image_show',{attachmentId},owner(s));const conversationId=s.store.meta('extensionConversation')!,snapshot=await backup(s.store),external=mkdtempSync(join(tmpdir(),'pico-preview-backup-'));directories.push(external);cpSync(snapshot.path,external,{recursive:true});
  await s.runtime.forget(memory.id);expect(s.runtime.images.previews(conversationId).images).toEqual([]);await expect(s.runtime.images.preview({attachmentId})).rejects.toThrow();
  await s.runtime.close();s.store.close();instances.splice(instances.indexOf(s),1);directories.push(s.root);await restore(s.root,external,true);
  const restored=new Store(s.root,s.config),runtime=new Runtime(restored,s.runtime.models);try{expect(runtime.images.previews(conversationId).images).toEqual([]);await expect(runtime.images.preview({attachmentId})).rejects.toThrow();}finally{await runtime.close();restored.close();}
});

it('creates a private PNG through the fixed metered API, not the chat provider, and journals metadata instead of base64',async()=>{
  const s=await configured(),fetch=vi.fn(async(url:string,options:any)=>{expect(url).toBe('https://api.openai.com/v1/images/generations');expect(options.redirect).toBe('error');expect(options.headers.Authorization).toBe('Bearer fixture-image-key');expect(JSON.parse(options.body)).toEqual({model:'gpt-image-1',prompt:'A synthetic blue circle',n:1,size:'1024x1024',quality:'low',output_format:'png'});return response();});vi.stubGlobal('fetch',fetch);
  const image=await invoke(s);expect(image).toMatchObject({synthetic:true,mime:'image/png',provider:'openai',model:'gpt-image-1',usage:{input_tokens:3,output_tokens:7,total_tokens:10}});expect(image.data).toBeUndefined();
  expect(Buffer.from((await rpc(s.runtime,{op:'images.read',args:{id:image.attachmentId}}) as any).data,'base64')).toEqual(png);expect(statSync(join(s.root,'attachments',image.attachmentId)).mode&0o777).toBe(0o600);
  expect(s.store.all('SELECT tool,status FROM operations')).toContainEqual({tool:'$images.generate',status:'completed'});expect(s.faux.state.callCount).toBe(0);expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(exportData(s.store))).not.toContain('fixture-image-key');expect(JSON.stringify(exportData(s.store))).not.toContain(png.toString('base64'));
});
it('uses a dedicated image key before the stored API key and never selects a subscription/chat/environment key',async()=>{
  const s=await configured();await s.runtime.credentials.setSecret('openai.imageKey','fixture-dedicated-image');await s.runtime.credentials.modify('chatgpt:test',async()=>({type:'oauth',access:'subscription-secret',refresh:'refresh',expires:Date.now()+60_000}));await s.runtime.credentials.selectOpenai('chatgpt:test');
  const fetch=vi.fn(async(_url:string,options:any)=>{expect(options.headers.Authorization).toBe('Bearer fixture-dedicated-image');return response();});vi.stubGlobal('fetch',fetch);await invoke(s);expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(['configuration missing','key missing','subscription only','environment only'])('makes no image request when %s',async scenario=>{
  const s=instance(),fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  if(scenario!=='configuration missing')s.config.imageGeneration={provider:'openai',model:'gpt-image-1'};
  if(scenario==='configuration missing')await s.runtime.credentials.setSecret('openai.imageKey','fixture-key');
  if(scenario==='subscription only')await s.runtime.credentials.modify('openai',async()=>({type:'oauth',access:'subscription-secret',refresh:'refresh',expires:Date.now()+60_000}));
  if(scenario==='environment only'){const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-env';try{await expect(invoke(s)).rejects.toThrow('API key missing');}finally{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}}
  else await expect(invoke(s)).rejects.toThrow(/disabled|API key missing/);
  expect(fetch).not.toHaveBeenCalled();expect(s.store.all('SELECT * FROM generated_images')).toEqual([]);
});
it.each(['ephemeral','scheduled','review','untrusted'])('denies image generation before billing/storage in %s work',async mode=>{
  const s=await configured(),fetch=vi.fn(async()=>response());vi.stubGlobal('fetch',fetch);
  const result=await turn(s,mode==='untrusted'?'foreground':mode as Envelope['mode'],mode!=='untrusted');expect(result.result.isError).toBe(true);expect(fetch).not.toHaveBeenCalled();expect(s.store.all('SELECT * FROM generated_images')).toEqual([]);
});
it('citation repair cannot start a billed image request',async()=>{
  const s=await configured(),fetch=vi.fn();vi.stubGlobal('fetch',fetch);const conversation=s.runtime.newConversation('Synthetic citation repair');
  s.faux.appendResponses([fauxAssistantMessage([fauxText(`Invalid pico:web:${crypto.randomUUID()}:${'0'.repeat(64)}:L1-2`)]),fauxAssistantMessage([fauxToolCall('image_generate',{prompt:'Denied repair'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('No grounded evidence available.')])]);
  const run=await s.runtime.ingest({requestId:crypto.randomUUID(),conversationId:conversation.id,text:'Read existing evidence'},source);await waitFor(()=>s.runtime.run(run.id).status==='completed');
  expect(JSON.parse(s.store.get<{body:string}>("SELECT body FROM messages WHERE run_id=? AND role='toolResult'",run.id)!.body).isError).toBe(true);expect(fetch).not.toHaveBeenCalled();expect(s.store.all('SELECT * FROM generated_images')).toEqual([]);
});

it('rejects foreign ownership, unknown properties, blank prompts and unsupported sizes before HTTP',async()=>{
  const s=await configured(),fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(s.runtime.invokeExtension('image_generate',{prompt:'Synthetic'}, {...owner(s),ownerId:'foreign'})).rejects.toThrow('Trusted retained owner');
  for(const args of [{prompt:' '},{prompt:'Synthetic',ownerId:'foreign'},{prompt:'x'.repeat(6001)},{prompt:'Synthetic',size:'4096x4096'}])await expect(invoke(s,args)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
});
it('reuses only exact successful tool receipts and permits only one generation attempt per run',async()=>{
  const s=await configured(),fetch=vi.fn(async()=>response());vi.stubGlobal('fetch',fetch);
  const context=owner(s);await s.runtime.invokeExtension('image_generate',{prompt:'Synthetic'},context);const bound={...context,conversationId:s.store.meta('extensionConversation')!},tool=s.runtime.availableTools(bound).find(tool=>tool.name==='image_generate')!;
  const operation=s.store.get<{id:string}>("SELECT id FROM operations WHERE run_id=? AND tool='image_generate'",context.runId)!;const callId=operation.id.slice(context.runId.length+1);
  await tool.execute(callId,{prompt:'Synthetic'});await expect(tool.execute(callId,{prompt:'Changed'})).rejects.toThrow('not replayed');
  await expect(tool.execute('another',{prompt:'Second request'})).rejects.toThrow('one image generation attempt');expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(['network uncertainty','http failure','remote URL','invalid base64','invalid PNG','extra images','reflected credential','oversized response','invalid JSON'])('refuses %s without retry or persistence',async scenario=>{
  const s=await configured();s.config.limits.attachmentBytes=1024;
  const fetch=vi.fn(async()=>{
    if(scenario==='network uncertainty')throw new Error('fixture-image-key must not be exposed');
    if(scenario==='http failure')return new Response('fixture-image-key',{status:429});
    if(scenario==='remote URL')return Response.json({data:[{url:'http://127.0.0.1/private'}]});
    if(scenario==='invalid base64')return Response.json({data:[{b64_json:'invalid!'}]});
    if(scenario==='invalid PNG')return Response.json({data:[{b64_json:Buffer.from('not an image').toString('base64')}]});
    if(scenario==='extra images')return Response.json({data:[{b64_json:png.toString('base64')},{b64_json:png.toString('base64')}]});
    if(scenario==='reflected credential')return Response.json({data:[{b64_json:png.toString('base64')}],echo:'fixture-image-key'});
    if(scenario==='oversized response')return new Response('x'.repeat(70_000),{headers:{'Content-Type':'application/json'}});
    return new Response('{',{headers:{'Content-Type':'application/json'}});
  });vi.stubGlobal('fetch',fetch);await expect(invoke(s)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);expect(s.store.all('SELECT * FROM generated_images')).toEqual([]);expect(s.store.all('SELECT * FROM attachments')).toEqual([]);
  expect(JSON.stringify(exportData(s.store))).not.toContain('fixture-image-key');
});
it('binds synthetic assistant provenance and actual input dependencies without claiming a real photograph',async()=>{
  const s=await configured();vi.stubGlobal('fetch',async()=>response());const {run,result}=await turn(s),image=JSON.parse(result.content[0].text),user=s.store.get<{id:string}>("SELECT id FROM messages WHERE run_id=? AND role='user'",run.id)!;
  expect(s.store.all('SELECT * FROM generated_image_sources')).toContainEqual({attachment_id:image.attachmentId,source_id:user.id});expect(s.runtime.memory.source(image.sourceId)).toMatchObject({actor:`assistant:${s.config.instanceId}`,generated:true,evidence:expect.stringContaining('not a photograph')});
  expect(s.runtime.images.list({runId:run.id}).images).toHaveLength(1);expect(s.store.all('SELECT * FROM memories')).toEqual([]);
});
it('counts image requests against the parent budget and never retries after a billed-looking failure',async()=>{
  const s=await configured();s.config.limits.turns=2;const fetch=vi.fn(async()=>response());vi.stubGlobal('fetch',fetch);const conversation=s.runtime.newConversation();
  s.faux.appendResponses([loadTools('image_generate'),fauxAssistantMessage([fauxToolCall('image_generate',{prompt:'Synthetic'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Unreachable')])]);const run=await s.runtime.ingest({requestId:crypto.randomUUID(),conversationId:conversation.id,text:'Create synthetic image'},source);await waitFor(()=>s.runtime.run(run.id).status==='failed');expect(fetch).not.toHaveBeenCalled();
});
it('cancellation stops admitted work even when the mocked provider returns a late response',async()=>{
  const s=await configured();let release!:(value:Response)=>void;vi.stubGlobal('fetch',()=>new Promise<Response>(resolve=>{release=resolve;}));
  const controller=new AbortController(),envelope=owner(s),conversation=s.runtime.newConversation();s.store.run("INSERT INTO runs(id,conversation_id,request_id,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",envelope.runId,conversation.id,crypto.randomUUID(),'{}','running',Date.now(),Date.now());
  const tool=s.runtime.availableTools({...envelope,conversationId:conversation.id}).find(tool=>tool.name==='image_generate')!,work=tool.execute('late',{prompt:'Synthetic'},controller.signal);const failure=expect(work).rejects.toThrow();await waitFor(()=>!!release);controller.abort(new Error('Cancelled'));release(response());await failure;expect(s.store.all('SELECT * FROM generated_images')).toEqual([]);
});
it('source erasure invalidates a late response even when the provider ignores cancellation',async()=>{
  const s=await configured(),memory=s.runtime.remember('fixture','erased during image work','global','fact') as any;let release!:(value:Response)=>void;vi.stubGlobal('fetch',()=>new Promise<Response>(resolve=>{release=resolve;}));
  const work=invoke(s),failure=expect(work).rejects.toThrow();await waitFor(()=>!!release);await s.runtime.forget(memory.id);release(response());await failure;expect(s.store.all('SELECT * FROM generated_images')).toEqual([]);expect(s.store.all('SELECT * FROM attachments')).toEqual([]);
});
it('removes orphan files after rolled-back persistence and recovers interrupted file cleanup on restart',async()=>{
  const s=await configured();vi.stubGlobal('fetch',async()=>response());const original=s.store.run.bind(s.store);
  const failure=vi.spyOn(s.store,'run').mockImplementation((sql,...params)=>{if(sql.startsWith('INSERT INTO generated_images'))throw new Error('Synthetic storage failure');return original(sql,...params);});
  await expect(invoke(s)).rejects.toThrow('storage failure');expect(readdirSync(join(s.root,'attachments'))).toEqual([]);expect(s.store.all('SELECT * FROM attachments')).toEqual([]);failure.mockRestore();
  const id=crypto.randomUUID();s.runtime.media.save(png,'interrupted.png','image/png',undefined,false,id);s.store.run('DELETE FROM attachments WHERE id=?',id);s.store.setMeta(`images.unlink:${id}`,'pending');
  await s.runtime.close();s.runtime=new Runtime(s.store,s.runtime.models);expect(existsSync(join(s.root,'attachments',id))).toBe(false);expect(s.store.meta(`images.unlink:${id}`)).toBeUndefined();
});

it('preserves generated PNGs through backup/reconstruction and reapplies image tombstones on old restore',async()=>{
  const s=await configured();vi.stubGlobal('fetch',async()=>response());const image=await invoke(s),snapshot=await backup(s.store),external=mkdtempSync(join(tmpdir(),'pico-image-backup-'));directories.push(external);cpSync(snapshot.path,external,{recursive:true});expect((exportData(s.store) as any).generatedImages).toHaveLength(1);
  await s.runtime.close();s.runtime=new Runtime(s.store,s.runtime.models);expect(Buffer.from((await s.runtime.images.read(image.attachmentId)).data,'base64')).toEqual(png);
  await rpc(s.runtime,{op:'images.forget',args:{id:image.attachmentId}});expect(existsSync(join(s.root,'attachments',image.attachmentId))).toBe(false);
  await s.runtime.close();s.store.close();instances.splice(instances.indexOf(s),1);directories.push(s.root);await restore(s.root,external,true);
  const restored=new Store(s.root,s.config);try{expect(restored.all('SELECT * FROM generated_images')).toEqual([]);expect(restored.all('SELECT * FROM attachments')).toEqual([]);expect(existsSync(join(s.root,'attachments',image.attachmentId))).toBe(false);expect(restored.all('PRAGMA foreign_key_check')).toEqual([]);}finally{restored.close();}
});
it('forgetting owner input removes dependent images and raw files, including from old backups',async()=>{
  const s=await configured();vi.stubGlobal('fetch',async()=>response());const {run,result}=await turn(s),image=JSON.parse(result.content[0].text),user=s.store.get<{id:string;text:string}>("SELECT id,text FROM messages WHERE run_id=? AND role='user'",run.id)!;
  const memory=s.runtime.memory.remember({sourceId:user.id,entity:`owner:${s.config.ownerId}`,kind:'fact',key:'synthetic-image-request',value:user.text,quote:user.text,eventAt:Date.now()},false);
  const snapshot=await backup(s.store),external=mkdtempSync(join(tmpdir(),'pico-image-input-backup-'));directories.push(external);cpSync(snapshot.path,external,{recursive:true});
  await s.runtime.forget(memory.id);expect(s.store.all('SELECT * FROM generated_images')).toEqual([]);expect(existsSync(join(s.root,'attachments',image.attachmentId))).toBe(false);
  await s.runtime.close();s.store.close();instances.splice(instances.indexOf(s),1);directories.push(s.root);await restore(s.root,external,true);const restored=new Store(s.root,s.config);try{expect(restored.all('SELECT * FROM generated_images')).toEqual([]);expect(restored.all('SELECT * FROM attachments')).toEqual([]);expect(existsSync(join(s.root,'attachments',image.attachmentId))).toBe(false);}finally{restored.close();}
});
it('schema eleven upgrades preserve calendar/memory/tags, and settings require explicit enablement',async()=>{
  const s=instance(),record=s.runtime.remember('fixture','preserved','global','fact',undefined,['tests']) as any;
  const appointment=await rpc(s.runtime,{op:'calendar',args:{action:'create',title:'Preserved appointment',start:'2099-01-01T10:00Z',end:'2099-01-01T11:00Z'}}) as any;
  await s.runtime.close();s.store.db.exec('DROP TABLE generated_image_sources;DROP TABLE generated_images;ALTER TABLE run_sources DROP COLUMN inherited;PRAGMA user_version=11');s.store.close();s.store=new Store(s.root,s.config);s.runtime=new Runtime(s.store,s.runtime.models);
  expect(s.store.get<any>('PRAGMA user_version').user_version).toBe(15);expect(s.runtime.memory.read(record.id).memory.tags).toEqual(['tests']);expect(s.runtime.calendar.read(appointment.id).title).toBe('Preserved appointment');
  await rpc(s.runtime,{op:'settings.update',args:{imageGeneration:{provider:'openai',model:'gpt-image-1',quality:'low'}}});expect(loadConfig(s.root).config.imageGeneration?.model).toBe('gpt-image-1');expect(s.config.imageGeneration).toBeUndefined();
  await rpc(s.runtime,{op:'settings.update',args:{imageGeneration:null}});expect(loadConfig(s.root).config.imageGeneration).toBeUndefined();
  await expect(rpc(s.runtime,{op:'settings.update',args:{imageGeneration:{provider:'untrusted',model:'anything'}}})).rejects.toThrow('Invalid input');
});
it('disabled image dispatch preserves records and expiration refuses original downloads',async()=>{
  const s=await configured();vi.stubGlobal('fetch',async()=>response());const image=await invoke(s);await s.runtime.extensions.disable('images');expect(s.runtime.extensions.tools().map(tool=>tool.name)).not.toContain('image_generate');expect(s.runtime.images.list({}).total).toBe(1);expect(await rpc(s.runtime,{op:'images.read',args:{id:image.attachmentId}})).toMatchObject({attachmentId:image.attachmentId});
  await s.runtime.extensions.enable('images');s.store.run('UPDATE attachments SET created_at=0 WHERE id=?',image.attachmentId);await s.runtime.media.expire();await expect(s.runtime.images.read(image.attachmentId)).rejects.toThrow('expired');
});
