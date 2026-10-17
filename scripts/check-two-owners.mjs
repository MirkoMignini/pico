import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
const authorization = '--authorize-disposable-deployment';
const help = `Usage: node scripts/check-two-owners.mjs ${authorization}
Only for an explicitly authorized disposable Docker deployment.
Writes fixed-ID fixtures, activates an extension, creates a reminder and restarts pico-owner-a.
Never run against valuable owner data. --help performs no Docker operations.`;
if (process.argv.length === 3 && process.argv[2] === '--help') { console.log(help); process.exit(0); }
assert(process.argv.length === 3 && process.argv[2] === authorization, help);
const migrations = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => /^\d+\.sql$/.test(name));
const schemaVersion = Math.max(...migrations.map(name => Number(name.split('.')[0])));
assert(Number.isSafeInteger(schemaVersion) && schemaVersion > 0, 'No ordered migrations found');
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',maxBuffer:2_000_000,timeout:60_000});
const cli=(owner,...args)=>JSON.parse(docker('exec',`pico-owner-${owner}`,'node','/app/dist/cli.js','--instance','/data',...args));
const rpc=(owner,op,args={})=>cli(owner,'rpc',op,JSON.stringify(args));
const statusA=cli('a','status'),statusB=cli('b','status');assert.notEqual(statusA.ownerId,statusB.ownerId);assert.equal(statusA.schemaVersion,schemaVersion);assert.equal(statusB.schemaVersion,schemaVersion);assert.equal(statusA.extensionsExecution.mode,'in-process');assert.equal(statusB.extensionsExecution.mode,'in-process');assert.equal(statusA.extensionsExecution.isolation,'none');assert.equal(statusB.extensionsExecution.isolation,'none');
for(const owner of ['a','b']){
 const inspect=JSON.parse(docker('inspect',`pico-owner-${owner}`))[0];
 assert.ok(!inspect.Mounts.some(m=>m.Destination.includes('docker.sock')));
 assert.ok(!inspect.Mounts.some(m=>m.Name===`pico-owner-${owner==='a'?'b':'a'}`));
 assert.equal(inspect.HostConfig.NetworkMode,`pico-owner-${owner}`);assert.equal(inspect.HostConfig.ReadonlyRootfs,true);assert.ok(inspect.HostConfig.Memory>0);
 docker('exec',`pico-owner-${owner}`,'node','-e',`const fs=require('node:fs');for(const p of ['/owner-other','/var/run/docker.sock','/Users','/host','/control','/workspaces'])if(fs.existsSync(p))throw new Error('private mount exposed: '+p);`);
}
const sameId='isolation-record-identical';
for(const owner of ['a','b'])docker('exec',`pico-owner-${owner}`,'node','-e',`
 const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite'),c=JSON.parse(fs.readFileSync('/data/config.json')),db=new DatabaseSync('/data/pico.sqlite');
 db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');
 db.prepare('INSERT OR REPLACE INTO extension_storage VALUES(?,?,?,1)').run('${sameId}','private',JSON.stringify('${owner}'));
 db.prepare('INSERT OR REPLACE INTO workflows VALUES(?,?,1)').run('${sameId}',JSON.stringify({id:'${sameId}',description:'Synthetic owner ${owner} isolation fixture',steps:[{tool:'memory_search',args:{query:'synthetic isolation'}}]}));
 db.prepare('INSERT OR REPLACE INTO conversations VALUES(?,?,?,?,?,?)').run('${sameId}','Synthetic identical-ID fixture','terminal',JSON.stringify(c.model),'',Date.now());
 db.prepare('INSERT OR REPLACE INTO messages VALUES(?,?,NULL,?,?,?,?,?,?)').run('${sameId}','${sameId}','human:'+c.ownerId,'user','Synthetic isolation fixture: ${owner}',JSON.stringify({role:'user',content:'Synthetic isolation fixture: ${owner}',timestamp:Date.now()}),Date.now(),Date.now());
 db.prepare('INSERT OR REPLACE INTO memories(id,entity,kind,key,value,scope,source_id,basis,status,event_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('${sameId}','owner:'+c.ownerId,'fact','synthetic-shared-id','${owner}','isolation-test','${sameId}','direct','current',Date.now(),Date.now());db.close();
 fs.writeFileSync('/data/artifacts/${sameId}','owner-${owner}',{mode:0o600});`);
const factA=rpc('a','memory.remember',{key:'isolation-fixture',value:'Owner A secret fixture'}),factB=rpc('b','memory.remember',{key:'isolation-fixture',value:'Owner B secret fixture'});
assert.throws(()=>rpc('a','memory.read',{id:factB.id}));assert.throws(()=>rpc('b','memory.read',{id:factA.id}));
assert.throws(()=>rpc('a','memory.list',{owner_id:statusB.ownerId}));assert.throws(()=>rpc('b','memory.list',{instance_id:statusA.instanceId}));
assert.equal(rpc('a','memory.read',{id:factA.id}).memory.value,'Owner A secret fixture');assert.equal(rpc('b','memory.read',{id:factB.id}).memory.value,'Owner B secret fixture');
assert.equal(rpc('a','memory.read',{id:sameId}).memory.value,'a');assert.equal(rpc('b','memory.read',{id:sameId}).memory.value,'b');assert.notEqual(rpc('a','source.read',{id:sameId}).actor,rpc('b','source.read',{id:sameId}).actor);
assert.throws(()=>docker('exec','pico-owner-a','node','/app/dist/cli.js','--instance','/data','serve'));
const example=JSON.parse(await readFile(new URL('../examples/word-count.json',import.meta.url),'utf8'));
const artifact=rpc('a','extensions.validate',{module:example});rpc('a','extensions.approve',{id:artifact.approvalId,hash:artifact.hash,decision:true});
assert.deepEqual(rpc('a','extensions.invoke',{id:'word_count',input:{text:'independent owner'}}).details,{words:2});assert.throws(()=>rpc('b','extensions.invoke',{id:'word_count',input:{text:'forbidden'}}));
const reminder=rpc('a','schedules.create',{definition:{text:'isolation-restart-reminder',timezone:'Europe/Rome',at:new Date(Date.now()+60_000).toISOString(),kind:'reminder',destination:'terminal',misfire:'once'},original:'synthetic restart test'});
docker('exec','pico-owner-a','node','-e',`const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/pico.sqlite');d.prepare('UPDATE schedules SET next_due=1 WHERE id=?').run('${reminder.id}');d.close();`);
docker('restart','pico-owner-a');
for(let n=0;n<100;n++){await new Promise(r=>setTimeout(r,100));try{const notifications=rpc('a','notifications.list');if(notifications.some(item=>item.text==='isolation-restart-reminder'&&item.status==='sent'))break;if(n===99)throw new Error('Reminder did not survive restart');}catch(error){if(n===99)throw error;}}
assert.ok(!rpc('b','notifications.list').some(item=>item.text==='isolation-restart-reminder'));
assert.equal(rpc('a','memory.read',{id:factA.id}).memory.value,'Owner A secret fixture');
console.log(JSON.stringify({environment:'disposable whole-owner Docker check',schemaVersion,concurrentOwners:true,separateOwnerNetworks:true,privateMounts:true,forgedFieldsRejected:true,identicalIdsPrivate:true,duplicateAuthorityRejected:true,trustedInProcessExtensions:true,extensionPrivateToOwner:true,reminderRestartWithoutModel:true},null,2));
