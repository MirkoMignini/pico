import { expect, it } from 'vitest';
import { rmSync, readFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import { setup } from './helpers.js';
import { backup, restore, exportData } from '../src/backup.js';
import { Store } from '../src/store.js';
import { atomicWrite } from '../src/config.js';

it('Pico branding reaches package, default CLI path, database, backup and export without changing owner identity',async()=>{
 const s=setup('Human owner');
 try{
  const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));expect(pkg.name).toBe('pico-assistant');expect(pkg.bin).toEqual({pico:'dist/cli.js'});
  const cli=spawnSync(process.execPath,[new URL('../dist/cli.js',import.meta.url).pathname,'init','--name','Human owner'],{env:{...process.env,HOME:s.root},encoding:'utf8'});expect(cli.status,cli.stderr).toBe(0);expect(JSON.parse(cli.stdout).path).toBe(join(s.root,'.local','share','pico'));
  expect(existsSync(join(s.root,'pico.sqlite'))).toBe(true);const snapshot=await backup(s.store);expect(snapshot.manifest.files.some(file=>file.path==='pico.sqlite')).toBe(true);
  const exported=exportData(s.store) as any;expect(exported.format).toBe('pico-export-v1');expect(exported.assistant.name).toBe('Pico');expect(exported.owner).toEqual({id:s.config.ownerId,name:'Human owner'});
  expect(s.store.meta('ownerId')).toBe(s.config.ownerId);expect(s.store.meta('instanceId')).toBe(s.config.instanceId);
 }finally{await s.runtime.close();s.store.close();rmSync(s.root,{recursive:true,force:true});}
});
it('concurrent foreground/background auth resolution serializes actual rotating-token HTTP exchange',async()=>{
  const s=setup();let token='first-refresh',rotations=0;
  const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const data=new URLSearchParams(Buffer.concat(chunks).toString());
    if(data.get('refresh_token')!==token){res.writeHead(400).end(JSON.stringify({error:'invalid_grant'}));return;}rotations++;token='second-refresh';res.end(JSON.stringify({access:'fresh-access',refresh:token,expires:Date.now()+3600000}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${(server.address() as any).port}`;
  const faux=fauxProvider({provider:'rotating'});
  const models=createModels({credentials:s.runtime.credentials,authContext:{env:async()=> 'must-not-use-env-fallback',fileExists:async()=>false}});
  models.setProvider({...faux.provider,auth:{oauth:{name:'fixture subscription',isSubscription:true,login:async()=>{throw new Error('not used');},refresh:async(credential,signal)=>{
    const response=await fetch(endpoint,{method:'POST',body:new URLSearchParams({refresh_token:credential.refresh}),signal});if(!response.ok)throw new Error('invalid_grant');return{type:'oauth',...await response.json() as any};},toAuth:async credential=>({apiKey:credential.access})}}});
  try{
    await s.runtime.credentials.modify('rotating',async()=>({type:'oauth',access:'expired',refresh:'first-refresh',expires:1}));
    const auth=await Promise.all(Array.from({length:20},()=>models.getAuth('rotating')));expect(rotations).toBe(1);expect(auth.every(a=>a?.auth.apiKey==='fresh-access')).toBe(true);
    expect((await s.runtime.credentials.read('rotating') as any).refresh).toBe('second-refresh');
    await s.runtime.credentials.modify('rotating',async()=>({type:'oauth',access:'expired',refresh:'invalid',expires:1}));await expect(models.getAuth('rotating')).rejects.toThrow();expect((await s.runtime.credentials.read('rotating') as any).refresh).toBe('invalid');
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await s.runtime.close();s.store.close();rmSync(s.root,{recursive:true,force:true});}
});
it('pre-rename snapshot basenames restore into Pico without weakening hash or single-database validation',async()=>{
 const s=setup();s.runtime.remember('preserved','legacy evidence');const snapshot=await backup(s.store);
 renameSync(join(snapshot.path,'pico.sqlite'),join(snapshot.path,'legacy.sqlite'));
 const files=snapshot.manifest.files.map(file=>file.path==='pico.sqlite'?{...file,path:'legacy.sqlite'}:file);
 writeFileSync(join(snapshot.path,'manifest.json'),JSON.stringify({...snapshot.manifest,files}));await s.runtime.close();s.store.close();
 try{
  await restore(s.root,snapshot.path,true);const recovered=new Store(s.root,s.config);try{expect(recovered.get<{value:string}>('SELECT value FROM memories')!.value).toBe('legacy evidence');expect(existsSync(join(s.root,'pico.sqlite'))).toBe(true);}finally{recovered.close();}
  writeFileSync(join(snapshot.path,'manifest.json'),JSON.stringify({...snapshot.manifest,files:[...files,{...files.find(file=>file.path==='legacy.sqlite')!,path:'other.sqlite'}]}));await expect(restore(s.root,snapshot.path,true)).rejects.toThrow('ambiguous database');
  writeFileSync(join(snapshot.path,'manifest.json'),JSON.stringify({...snapshot.manifest,files}));writeFileSync(join(snapshot.path,'legacy.sqlite'),'tampered');await expect(restore(s.root,snapshot.path,true)).rejects.toThrow('integrity');
 }finally{rmSync(s.root,{recursive:true,force:true});}
});
it('consistent SQLite/media backup restores conversations, facts, references, schedules and extension configuration',async()=>{
  const s=setup();atomicWrite(join(s.root,'config.json'),JSON.stringify(s.config));
  const memory=s.runtime.remember('backup-fact','retained value') as any;
  const conversation=s.runtime.newConversation('backup-conversation');const media=s.runtime.media.save(Buffer.from('name,value\na,2'),'test.csv','text/csv',conversation.id);s.runtime.media.link(media,memory.source_id,conversation.id);
  s.runtime.scheduler.create({text:'retained reminder',timezone:'Europe/Rome',cron:'0 9 * * *',kind:'reminder',destination:'terminal',misfire:'once'},'test');
  s.store.run('INSERT INTO extension_installs(id,enabled) VALUES(?,0)','saved-extension');
  const snapshot=await backup(s.store);expect(snapshot.manifest.credentials).toBe('excluded');expect(existsSync(join(snapshot.path,'secrets.json'))).toBe(false);expect(JSON.stringify(exportData(s.store))).toContain('retained value');
  s.store.run('DELETE FROM schedules');s.store.run("UPDATE memories SET value='changed'");await s.runtime.close();s.store.close();
  try{
    await expect(restore(s.root,snapshot.path,false)).rejects.toThrow('original-stopped');await restore(s.root,snapshot.path,true);
    const recovered=new Store(s.root,s.config);try{expect(recovered.get<{value:string}>('SELECT value FROM memories')!.value).toBe('retained value');expect(recovered.all('SELECT * FROM schedules')).toHaveLength(1);expect(recovered.get('SELECT * FROM extension_installs WHERE id=?','saved-extension')).toBeDefined();expect(readFileSync(join(s.root,'attachments',media),'utf8')).toContain('a,2');}finally{recovered.close();}
  }finally{rmSync(s.root,{recursive:true,force:true});}
});
