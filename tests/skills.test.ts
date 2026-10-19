import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, linkSync, cpSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import AdmZip from 'adm-zip';
import { fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools } from '@earendil-works/pi-ai';
import { Runtime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { rpc } from '../src/daemon.js';
import { backup, restore } from '../src/backup.js';
import { atomicWrite } from '../src/config.js';
import { packageFromFiles, directoryPackage, archivePackage, skillArchive, skillName, type SkillFile } from '../src/skill-package.js';
import { runSkill } from '../src/skill-runner.js';
import { WebNetwork } from '../src/web-network.js';
import { setup, source, waitFor, loadTools, reply } from './helpers.js';

const instances: ReturnType<typeof setup>[] = [];
const instance = () => { const s = setup('skills-fixture'); instances.push(s); return s; };
afterEach(async () => { vi.restoreAllMocks(); for (const s of instances.splice(0)) { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); } });
const files = (name = 'word-count', body = 'Use scripts/count.mjs with JSON stdin. Do not guess the answer.'): SkillFile[] => [
  { path: 'SKILL.md', content: `---\nname: ${name}\ndescription: Count supplied words. Use when asked for a word count.\nlicense: MIT\ncompatibility: Requires Node.js 24\nmetadata:\n  author: Pikobot tests\n  version: '1.0'\nallowed-tools: Read Bash(node:*)\n---\n${body}\n` },
  { path: 'scripts/count.mjs', content: "let text='';for await(const chunk of process.stdin)text+=chunk;const input=JSON.parse(text);if(typeof input.text!=='string')throw new Error('text must be a string');console.log(JSON.stringify({words:input.text.trim()?input.text.trim().split(/\\s+/).length:0}));" },
  { path: 'references/format.md', content: 'JSON input: {"text":"hello world"}; JSON output: {"words":2}.' },
  { path: 'assets/binary.bin', content: Buffer.from([0, 255, 1, 128]).toString('base64'), encoding: 'base64' }
];
const request = (s: ReturnType<typeof setup>, args: Record<string, unknown>) => rpc(s.runtime, { op: 'skills.request', args }) as Promise<any>;
const install = (s: ReturnType<typeof setup>, items = files()) => request(s, { action: 'save', files: items });
const read = (s: ReturnType<typeof setup>, name = 'word-count', path?: string) => rpc(s.runtime, { op: 'skills.read', args: { name, ...(path ? { path } : {}) } }) as Promise<any>;
const run = async (s: ReturnType<typeof setup>, args: Record<string, unknown> = { name: 'word-count', script: 'scripts/count.mjs', input: { text: 'hello world' } }) => { await read(s, args.name as string); return rpc(s.runtime, { op: 'skills.run', args }) as Promise<any>; };
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
async function chat(s: ReturnType<typeof setup>, text: string, conversationId = s.runtime.newConversation().id, ephemeral = false) {
  const run = await s.runtime.ingest({ requestId: crypto.randomUUID(), conversationId, text }, source, ephemeral ? 'ephemeral' : 'foreground');
  await waitFor(() => !s.runtime.hasPendingRuns, 10_000);
  return s.runtime.run(run.id);
}

it('supports standard YAML, optional fields, CRLF, BOM, Unicode names and binary resources', () => {
  const pkg = packageFromFiles(files());
  expect(pkg.metadata).toMatchObject({ name: 'word-count', license: 'MIT', metadata: { version: '1.0' }, 'allowed-tools': 'Read Bash(node:*)' });
  expect(pkg.warnings.join()).toContain('never a permission grant');
  const international = files('金融-计算'); international[0]!.content = '\uFEFF' + international[0]!.content.replaceAll('\n', '\r\n');
  expect(packageFromFiles(international).metadata.name).toBe('金融-计算');
  expect(skillName('cafe\u0301')).toBe('café');
  const zip = skillArchive(pkg.files, pkg.metadata.name), roundtrip = archivePackage(zip);
  expect(roundtrip.hash).toBe(pkg.hash); expect(roundtrip.files.find(file => file.path === 'assets/binary.bin')!.bytes).toEqual(Buffer.from([0,255,1,128]));
});

it.each([
  ['missing frontmatter', 'hello'],
  ['empty description', '---\nname: example\ndescription: ""\n---\nHello'],
  ['duplicate YAML key', '---\nname: example\nname: other\ndescription: text\n---\nHello'],
  ['alias', '---\nname: &name example\ndescription: *name\n---\nHello'],
  ['custom tag', '---\nname: example\ndescription: !unsafe text\n---\nHello'],
  ['metadata value type', '---\nname: example\ndescription: text\nmetadata:\n  version: 1\n---\nHello'],
  ['unknown field', '---\nname: example\ndescription: text\npermissions: all\n---\nHello'],
  ['uppercase name', '---\nname: Example\ndescription: text\n---\nHello'],
  ['double hyphen', '---\nname: two--words\ndescription: text\n---\nHello']
])('rejects malformed standard metadata: %s', (_label, content) => {
  expect(() => packageFromFiles([{ path: 'SKILL.md', content }])).toThrow();
});

it.each(['../escape', '/absolute', 'a/../../escape', 'a\\escape', 'a//b', 'C:/escape', 'assets/\u202esecret'])('rejects unsafe file paths %j', path => {
  expect(() => packageFromFiles([...files(), { path, content: 'bad' }])).toThrow();
});

it('rejects duplicates, prefix collisions, oversized files and unsafe ZIP entries before extraction', () => {
  for (const extra of [[{ path: 'skill.md', content: 'duplicate' }], [{ path: 'assets', content: 'prefix collision' }], [{ path: 'ASSETS', content: 'case-insensitive prefix collision' }], [{ path: 'huge', content: 'x'.repeat(4_000_001) }]]) expect(() => packageFromFiles([...files(), ...extra])).toThrow();
  const zip = new AdmZip(); zip.addFile('unsafe/SKILL.md', Buffer.from(files('unsafe')[0]!.content)); zip.addFile('xx/escape', Buffer.from('bad'));
  const unsafe = Buffer.from(zip.toBuffer().toString('latin1').replaceAll('xx/escape','../escape'),'latin1');
  expect(() => archivePackage(unsafe)).toThrow('relative path');
  const linked = new AdmZip(); linked.addFile('unsafe/SKILL.md', Buffer.from(files('unsafe')[0]!.content)); linked.addFile('unsafe/linked', Buffer.from('/private')); linked.getEntry('unsafe/linked')!.attr=(0o120777<<16)>>>0;
  expect(() => archivePackage(linked.toBuffer())).toThrow('symlinks');
});

it('refuses credential filenames even inside otherwise valid packages and rejects the global Pi directory itself', async () => {
  const s=instance(),directory=join(s.root,'selected','word-count');mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'SKILL.md'),files()[0]!.content);writeFileSync(join(directory,'secrets.json'),'synthetic non-secret fixture');
  await expect(request(s,{action:'import',localPath:directory})).rejects.toThrow('Credential');await expect(request(s,{action:'import',localPath:join(homedir(),'.pi')})).rejects.toThrow('global Pi');
  for(const path of ['assets/.env','assets/auth.json','credentials.json'])expect(()=>packageFromFiles([...files(),{path,content:'synthetic non-secret fixture'}])).toThrow('Credential');expect(s.store.all('SELECT * FROM skill_packages')).toEqual([]);
});

it('selects a single package from a repository ZIP without importing siblings', () => {
  const zip = new AdmZip();
  for (const name of ['first-skill', 'second-skill']) for (const file of files(name)) zip.addFile(`repository/skills/${name}/${file.path}`, Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'));
  expect(() => archivePackage(zip.toBuffer())).toThrow('Select one');
  const selected = archivePackage(zip.toBuffer(), 'repository/skills/second-skill');
  expect(selected.metadata.name).toBe('second-skill'); expect(selected.files).toHaveLength(4);
});

it('discovers dropped directories, scopes roots to this instance, detects edits/removal and reports isolated errors', async () => {
  const s = instance(), root = join(s.root, 'skills', 'word-count');
  for (const file of files().filter(file => file.encoding !== 'base64')) { mkdirSync(join(root,file.path,'..'),{recursive:true,mode:0o700}); writeFileSync(join(root,file.path),file.content); }
  mkdirSync(join(s.root,'skills','broken'),{recursive:true}); writeFileSync(join(s.root,'skills','broken','SKILL.md'),'malformed');
  s.runtime.skills.sync();
  const first = await request(s,{action:'list'}); expect(first.skills).toContainEqual(expect.objectContaining({name:'word-count',version:1})); expect(first.diagnostics['skills/broken']).toContain('frontmatter');
  writeFileSync(join(root,'references/format.md'),'Changed reference.'); s.runtime.skills.sync();
  expect((await read(s)).version).toBe(2);
  writeFileSync(join(root,'SKILL.md'),'broken'); s.runtime.skills.sync(); expect(await read(s)).toMatchObject({status:'invalid',enabled:false}); await expect(run(s)).rejects.toThrow('not enabled');
  writeFileSync(join(root,'SKILL.md'),files()[0]!.content); s.runtime.skills.sync(); expect((await read(s)).name).toBe('word-count');
  rmSync(root,{recursive:true}); s.runtime.skills.sync(); expect(await read(s)).toMatchObject({status:'missing',enabled:false});
});

it('refuses symlinked roots, skill directories, files and hardlinks without reading their target', async () => {
  const s = instance(), outside = join(s.root,'outside'); mkdirSync(outside); writeFileSync(join(outside,'SKILL.md'),files()[0]!.content);
  symlinkSync(outside,join(s.root,'skills','word-count')); s.runtime.skills.sync(); expect((await request(s,{action:'list'})).skills).toEqual([]);
  rmSync(join(s.root,'skills','word-count')); mkdirSync(join(s.root,'skills','word-count')); symlinkSync(join(outside,'SKILL.md'),join(s.root,'skills','word-count','SKILL.md')); s.runtime.skills.sync(); expect(s.runtime.skills.errors.size).toBeGreaterThan(0);
  rmSync(join(s.root,'skills','word-count','SKILL.md')); linkSync(join(outside,'SKILL.md'),join(s.root,'skills','word-count','SKILL.md')); s.runtime.skills.sync(); expect(s.runtime.skills.errors.size).toBeGreaterThan(0);
  mkdirSync(join(outside,'skills')); symlinkSync(outside,join(s.root,'.agents')); s.runtime.skills.sync(); expect(s.runtime.skills.errors.get('.agents/skills')).toContain('symlink');
});

it('installs atomically with private files, revision checks, resource edits, disable/enable and rollback', async () => {
  const s = instance(), first = await install(s);
  expect(first).toMatchObject({ saved:true,version:1,testsRun:false });
  expect(statSync(join(s.root,'skills','word-count','SKILL.md')).mode&0o777).toBe(0o600);
  await expect(install(s)).rejects.toThrow('already exists');
  const second = await request(s,{action:'write',name:'word-count',path:'references/format.md',content:'A revised reference.',expectedHash:first.hash}); expect(second.version).toBe(2);
  await expect(request(s,{action:'write',name:'word-count',path:'references/format.md',content:'stale',expectedHash:first.hash})).rejects.toThrow('revision conflict');
  await request(s,{action:'disable',name:'word-count'}); expect((await request(s,{action:'list'})).skills).toContainEqual(expect.objectContaining({name:'word-count',enabled:false,status:'disabled'})); expect(await read(s)).toMatchObject({enabled:false,status:'disabled'});
  s.runtime.skills.sync(); await expect(run(s)).rejects.toThrow('not enabled');
  await request(s,{action:'enable',name:'word-count'}); expect((await read(s)).version).toBe(2);
  const reverted = await request(s,{action:'rollback',name:'word-count',version:1}); expect(reverted.version).toBe(3);
  expect((await read(s,'word-count','references/format.md')).text).toContain('JSON input');
});

it('recovers interrupted publication without overwriting concurrent directory edits or redoing an acknowledged rename', async () => {
  const s=instance(),first=await install(s),target=join(s.root,'skills','word-count'),context=JSON.parse(s.store.get<{source:string}>('SELECT source FROM runs ORDER BY rowid DESC LIMIT 1')!.source);
  const changed=files().map(file=>file.path==='references/format.md'?{...file,content:'Intended new reference.'}:file);writeFileSync(join(target,'references/format.md'),'Concurrent operator edit.');
  expect(()=>s.runtime.skills.save(changed,context,first.hash)).toThrow('publication conflict');expect(readFileSync(join(target,'references/format.md'),'utf8')).toBe('Concurrent operator edit.');expect(s.store.all("SELECT * FROM skills WHERE status='publishing'")).toHaveLength(1);
  s.runtime.skills.sync();expect(s.runtime.skills.errors.size).toBeGreaterThan(0);expect(readFileSync(join(target,'references/format.md'),'utf8')).toBe('Concurrent operator edit.');
  writeFileSync(join(target,'references/format.md'),files()[2]!.content);s.runtime.skills.sync();expect(s.store.all("SELECT * FROM skills WHERE status='publishing'")).toEqual([]);expect(await read(s,'word-count','references/format.md')).toMatchObject({text:'Intended new reference.',version:2});
  const mtime=statSync(join(target,'SKILL.md')).mtimeMs;s.store.run("UPDATE skills SET status='publishing' WHERE id=? AND version=2",first.id);s.store.setMeta(`skills.publish:${first.id}`,JSON.stringify({skillId:first.id,version:2,directory:'skills/word-count',previousHash:first.hash,desired:'active'}));s.runtime.skills.sync();expect(statSync(join(target,'SKILL.md')).mtimeMs).toBe(mtime);expect((await read(s)).version).toBe(2);expect(s.store.meta(`skills.publish:${first.id}`)).toBeUndefined();
});

it('runs actual Node/Python/Bash scripts with arguments, JSON stdin, package resources and scrubbed environment', async () => {
  const s = instance(); await install(s,[...files(), {path:'scripts/env.mjs',content:"console.log(JSON.stringify({key:process.env.SYNTHETIC_SKILL_SECRET,home:process.env.HOME,cwd:process.cwd(),arg:process.argv[2]}));"}, {path:'scripts/count.py',content:"import sys,json\nprint(json.dumps({'words': len(json.load(sys.stdin)['text'].split())}))\n"}, {path:'scripts/hello.sh',content:'#!/bin/bash\nprintf "hello %s" "$1"\n'}]);
  const result = await run(s); expect(result).toMatchObject({status:'completed',exitCode:0}); expect(JSON.parse(result.stdout)).toEqual({words:2});
  process.env.SYNTHETIC_SKILL_SECRET='not-forwarded';
  try { const env=await run(s,{name:'word-count',script:'scripts/env.mjs',args:['an argument']}); const data=JSON.parse(env.stdout); expect(data.key).toBeUndefined(); expect(data.home).toContain('skill-work'); expect(data.arg).toBe('an argument'); expect(existsSync(data.cwd)).toBe(false); } finally { delete process.env.SYNTHETIC_SKILL_SECRET; }
  expect(JSON.parse((await run(s,{name:'word-count',script:'scripts/count.py',input:{text:'one two three'}})).stdout)).toEqual({words:3});
  expect((await run(s,{name:'word-count',script:'scripts/hello.sh',args:['world']})).stdout).toBe('hello world');
});

it.each([{extension:'rb',interpreter:'ruby',source:"puts 'hello ruby'",text:'hello ruby'},{extension:'pl',interpreter:'perl',source:"print qq(hello perl\\n);",text:'hello perl'}])('runs installed $interpreter or reports its missing prerequisite without installation', async script => {
  const s=instance();await install(s,[...files(),{path:`scripts/hello.${script.extension}`,content:script.source}]);
  const available=spawnSync(script.interpreter,['--version'],{encoding:'utf8'});
  if(available.error)await expect(run(s,{name:'word-count',script:`scripts/hello.${script.extension}`})).rejects.toThrow('Could not start skill interpreter');
  else{const result=await run(s,{name:'word-count',script:`scripts/hello.${script.extension}`});expect(result.status,result.stderr).toBe('completed');expect(result.stdout.trim()).toBe(script.text);}
});

it('uses pinned Node type erasure and explicitly fails unsupported TypeScript runtime syntax', async () => {
  const s=instance();await install(s,[...files(),{path:'scripts/types.ts',content:"type Input={value:number};const input:Input={value:3};console.log(JSON.stringify(input));"},{path:'scripts/enum.ts',content:'enum Value { One };console.log(Value.One);'}]);
  expect(JSON.parse((await run(s,{name:'word-count',script:'scripts/types.ts'})).stdout)).toEqual({value:3});const unsupported=await run(s,{name:'word-count',script:'scripts/enum.ts'});expect(unsupported.status).toBe('failed');expect(unsupported.stderr).toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
});

it('joins owner-RPC child cleanup before runtime shutdown returns', async () => {
  const s=instance(),started=join(s.root,'shutdown-child');await install(s,[...files(),{path:'scripts/wait.mjs',content:`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(started)},'started');setInterval(()=>{},1000);`}]);await read(s);
  const pending=rpc(s.runtime,{op:'skills.run',args:{name:'word-count',script:'scripts/wait.mjs'}}).then(()=>'',error=>error.message);await waitFor(()=>existsSync(started));await s.runtime.close();expect(await pending).toMatch(/invalidated|stopping|ended|abort/i);expect(readdirSync(join(s.root,'skill-work'))).toEqual([]);
});

it('requires activation and the current hash, and never treats allowed-tools as permission', async () => {
  const s=instance(), installed=await install(s);
  await expect(rpc(s.runtime,{op:'skills.run',args:{name:'word-count',script:'scripts/count.mjs',input:{text:'one'}}})).rejects.toThrow('Read this skill');
  await read(s); await expect(run(s,{name:'word-count',script:'../escape.mjs'})).rejects.toThrow('relative path');
  await expect(run(s,{name:'word-count',script:'scripts/count.mjs',stdin:'{}',input:{}})).rejects.toThrow('either stdin');
  await expect(run(s,{name:'word-count',script:'scripts/count.mjs',input:{},expectedHash:'0'.repeat(64)})).rejects.toThrow('revision conflict');
  await request(s,{action:'write',name:'word-count',path:'references/format.md',content:'updated',expectedHash:installed.hash});
  await expect(rpc(s.runtime,{op:'skills.run',args:{name:'word-count',script:'scripts/count.mjs',input:{text:'one'}}})).rejects.toThrow('loaded version');
});

it('retains selected uploads/document originals as assets and lets scripts consume explicit input files and publish outputs', async () => {
  const s=instance(), input=s.runtime.media.save(Buffer.from('Synthetic CSV\n42\n'),'data.csv','text/csv');
  const doc=await s.runtime.knowledge.importAttachment(input,'skill-input-doc');
  const script="import fs from 'node:fs';const text=fs.readFileSync('inputs/data.csv','utf8');fs.writeFileSync('outputs/result.txt',text.toUpperCase());console.log(JSON.stringify({read:true}));";
  await request(s,{action:'save',files:[...files(),{path:'scripts/files.mjs',content:script}],resources:[{documentId:doc.id,path:'assets/source.csv'}]});
  expect((await read(s,'word-count','assets/source.csv')).text).toContain('42');
  const result=await run(s,{name:'word-count',script:'scripts/files.mjs',inputs:[{attachmentId:input,path:'data.csv'}],outputs:['outputs/result.txt']});
  expect(result.outputs).toHaveLength(1); expect(Buffer.from((await s.runtime.media.read(result.outputs[0].attachmentId)).bytes).toString()).toContain('SYNTHETIC CSV');
  expect(readdirSync(join(s.root,'skill-work'))).toEqual([]);
});

it('does not retain output symlinks or outputs from failed scripts', async () => {
  const s=instance(); await install(s,[...files(),{path:'scripts/output.mjs',content:"import fs from 'node:fs';fs.symlinkSync('/etc/hosts','outputs/link');"},{path:'scripts/fail.mjs',content:"import fs from 'node:fs';fs.writeFileSync('outputs/fail.txt','failed');process.exit(3);"}]);
  await expect(run(s,{name:'word-count',script:'scripts/output.mjs',outputs:['outputs/link']})).rejects.toThrow('symlink');
  const failed=await run(s,{name:'word-count',script:'scripts/fail.mjs',outputs:['outputs/fail.txt']}); expect(failed).toMatchObject({status:'failed',exitCode:3,outputs:[]});
});

it('bounds script time/output and kills only its own spawned process group', async () => {
  const s=instance(),marker=join(s.root,'descendant-marker');
  const child=`setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')},1200)`;
  await install(s,[...files(),{path:'scripts/wait.mjs',content:`import {spawn} from 'node:child_process';spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});setInterval(()=>{},1000);`},{path:'scripts/huge.mjs',content:"process.stdout.write('x'.repeat(1_500_000));setInterval(()=>{},1000);"}]);
  const timed=await run(s,{name:'word-count',script:'scripts/wait.mjs',timeoutMs:400}); expect(timed.status).toBe('timed_out'); expect(timed.effect).toContain('uncertain');
  await new Promise(resolve=>setTimeout(resolve,1300)); expect(existsSync(marker)).toBe(false);
  const huge=await run(s,{name:'word-count',script:'scripts/huge.mjs'}); expect(huge).toMatchObject({status:'output_limit',outputTruncated:true}); expect(Buffer.byteLength(huge.stdout)).toBeLessThanOrEqual(1_000_000);
});

it('discovers metadata progressively, explicitly activates $mentions and keeps instructions after compaction/reconstruction', async () => {
  const s=instance(); await install(s,files('word-count','PINNED_SKILL_ONLY: run scripts/count.mjs with JSON stdin.'));
  const conversation=s.runtime.newConversation();
  s.faux.appendResponses([req=>{const text=JSON.stringify(req);expect(text).toContain('Count supplied words');expect(text).not.toContain('PINNED_SKILL_ONLY');return fauxAssistantMessage([fauxText('Available.')]);}]);
  expect((await chat(s,'What skills are installed?',conversation.id)).status).toBe('completed');
  s.faux.appendResponses([req=>{expect(JSON.stringify(req)).toContain('PINNED_SKILL_ONLY');expect(getCurrentTools(req.messages).map(tool=>tool.name)).toContain('skills_run');return call('skills_run',{name:'word-count',script:'scripts/count.mjs',input:{text:'one two'}});},fauxAssistantMessage([fauxText('Two words.')])]);
  expect((await chat(s,'Use $word-count for one two',conversation.id)).status).toBe('completed');
  s.store.run('INSERT OR REPLACE INTO context_checkpoints VALUES(?,?,0,0)',conversation.id,10**9);
  await s.runtime.close();s.runtime=new Runtime(s.store,s.runtime.models);
  s.faux.appendResponses([req=>{expect(JSON.stringify(req)).toContain('PINNED_SKILL_ONLY');return fauxAssistantMessage([fauxText('Instructions retained.')]);}]);
  expect((await chat(s,'Continue the task',conversation.id)).status).toBe('completed');
});

it('creates a skill through the actual agent path, validates it and uses its script without generating an extension', async () => {
  const s=instance();
  s.faux.appendResponses([loadTools('skill_build'),call('skill_build',{specification:'Create a local word-count skill'}),fauxAssistantMessage([fauxText(JSON.stringify({files:files()}))]),call('skills_read',{name:'word-count'}),call('skills_run',{name:'word-count',script:'scripts/count.mjs',input:{text:'one two'}}),fauxAssistantMessage([fauxText('Skill created and used.')])]);
  const run=await chat(s,'Create a reusable word-count utility'); expect(run.status,run.error).toBe('completed');
  expect(s.store.all('SELECT * FROM extension_artifacts')).toEqual([]); expect(s.store.all('SELECT * FROM skill_packages')).toHaveLength(1);
  expect(s.store.all("SELECT status FROM operations WHERE run_id=? AND tool='skills_run'",run.id)).toEqual([{status:'completed'}]);
});

it('reuses identical script receipts across argument-key ordering without replaying effects', async () => {
  const s=instance(),marker=join(s.root,'effect-marker');
  await install(s,[...files(),{path:'scripts/effect.mjs',content:`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},'x');console.log('done');`}]);
  s.faux.appendResponses([loadTools('skills_read','skills_run'),call('skills_read',{name:'word-count'}),fauxAssistantMessage([fauxToolCall('skills_run',{name:'word-count',script:'scripts/effect.mjs',input:{a:1,b:2}}),fauxToolCall('skills_run',{script:'scripts/effect.mjs',input:{b:2,a:1},name:'word-count'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('No duplicate effects.')])]);
  const run=await chat(s,'Execute this synthetic effect once');expect(run.status,run.error).toBe('completed');expect(readFileSync(marker,'utf8')).toBe('x');
});

it.each(['ephemeral','scheduled','review','untrusted'] as const)('denies skill writes and execution in %s contexts', async mode => {
  const s=instance();await install(s);
  const context={ownerId:s.config.ownerId,instanceId:s.config.instanceId,conversationId:s.runtime.newConversation().id,runId:crypto.randomUUID(),source:{...source,trustedOwner:mode!=='untrusted'},mode:mode==='untrusted'?'foreground' as const:mode};
  s.store.run('INSERT INTO runs(id,conversation_id,request_id,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',context.runId,context.conversationId,context.runId,JSON.stringify(context),'running',1,1);
  const tool=s.runtime.availableTools(context).find(tool=>tool.name==='skills')!;
  await expect(tool.execute('denied',{action:'save',files:files('another-skill')})).rejects.toThrow('trusted retained');
  const execute=s.runtime.availableTools(context).find(tool=>tool.name==='skills_run')!;
  await expect(execute.execute('denied-run',{name:'word-count',script:'scripts/count.mjs'})).rejects.toThrow('trusted retained');
  expect(s.store.all('SELECT * FROM skill_packages')).toHaveLength(1);
});

it('allows ephemeral instruction/resource reads without durable activation or metadata writes', async () => {
  const s=instance();await install(s);const before=s.store.all('SELECT * FROM skill_activations');
  const session=s.runtime.newConversation('Volatile skill',true);
  s.faux.appendResponses([loadTools('skills_read'),call('skills_read',{name:'word-count'}),fauxAssistantMessage([fauxText('Instructions read without execution.')])]);
  const run=await chat(s,'Read the word-count instructions',session.id,true);expect(run.status,run.error).toBe('completed');
  expect(s.store.all('SELECT * FROM skill_activations')).toEqual(before);expect(s.store.all('SELECT * FROM messages WHERE run_id=?',run.id)).toEqual([]);
});

it('imports uploaded SKILL.md and ZIP packages, and requires explicit current-input authority for local paths', async () => {
  const s=instance(),zip=skillArchive(packageFromFiles(files()).files,'word-count'),uploaded=s.runtime.media.save(zip,'skill.zip','application/octet-stream');
  expect(await request(s,{action:'import',attachmentId:uploaded})).toMatchObject({saved:true,name:'word-count'});
  const local=join(s.root,'selected.txt');writeFileSync(local,'Selected source.');
  // Operator RPC is explicit authority for this exact path.
  const current=(await read(s)).packageHash;await request(s,{action:'import',localPath:local,name:'word-count',filePath:'assets/selected.txt',expectedHash:current});
  expect((await read(s,'word-count','assets/selected.txt')).text).toBe('Selected source.');
  s.faux.appendResponses([loadTools('skills'),call('skills',{action:'import',localPath:local,name:'word-count',filePath:'assets/forbidden.txt',expectedHash:(await read(s)).packageHash}),fauxAssistantMessage([fauxText('Host path was not authorized.')])]);
  const denied=await chat(s,'Use only uploaded files');expect(denied.status).toBe('completed');expect(s.store.get<{result:string}>("SELECT result FROM operations WHERE run_id=? AND tool='skills'",denied.id)!.result).toContain('exact path');
});

it('removes generated packages, outputs and dependent history on source forgetting and blocks rediscovery/old restore', async () => {
  const s=instance();atomicWrite(join(s.root,'config.json'),JSON.stringify(s.config));
  const fact=s.runtime.remember('skill source','synthetic-private-skill-source') as {id:string;source_id:string};
  s.faux.appendResponses([loadTools('memory_read','skill_build'),call('memory_read',{id:fact.id}),call('skill_build',{specification:'Create a word counter from this synthetic context'}),fauxAssistantMessage([fauxText(JSON.stringify({files:[...files(),{path:'scripts/output.mjs',content:"import fs from 'node:fs';fs.writeFileSync('outputs/result.txt','synthetic derived content');"}]}))]),fauxAssistantMessage([fauxText('Created.')])]);
  const built=await chat(s,'Create a synthetic skill');expect(built.status,built.error).toBe('completed');
  const output=await run(s,{name:'word-count',script:'scripts/output.mjs',outputs:['outputs/result.txt']}),attachment=output.outputs[0].attachmentId;
  const document=await s.runtime.knowledge.importAttachment(attachment,'derived-skill-output');expect(existsSync(join(s.root,'attachments',attachment))).toBe(true);
  const snapshot=await backup(s.store), external=join(s.root,'external-snapshot'); cpSync(snapshot.path,external,{recursive:true});
  await s.runtime.forget(fact.id);expect(s.store.all('SELECT * FROM skill_packages')).toEqual([]);expect(existsSync(join(s.root,'skills','word-count'))).toBe(false);
  expect(s.store.all('SELECT * FROM skill_outputs')).toEqual([]);expect(existsSync(join(s.root,'attachments',attachment))).toBe(false);expect(()=>s.runtime.knowledge.document(document.id)).toThrow('not found');expect(s.store.get<{deleted_at:number}>('SELECT deleted_at FROM documents WHERE id=?',document.id)?.deleted_at).toBeGreaterThan(0);
  s.runtime.skills.sync();expect(s.store.all('SELECT * FROM skill_packages')).toEqual([]);
  await s.runtime.close();s.store.close();await restore(s.root,external,true);s.store=new Store(s.root,s.config);s.runtime=new Runtime(s.store,s.runtime.models);
  expect(s.store.all('SELECT * FROM skill_packages')).toEqual([]);s.runtime.skills.sync();expect(s.store.all('SELECT * FROM skill_packages')).toEqual([]);
  expect(s.store.all('SELECT * FROM skill_outputs')).toEqual([]);expect(existsSync(join(s.root,'attachments',attachment))).toBe(false);
});

it('backs up binary assets and restores canonical packages without enabling post-snapshot drop-ins', async () => {
  const s=instance();atomicWrite(join(s.root,'config.json'),JSON.stringify(s.config));await install(s);const snapshot=await backup(s.store);
  await install(s,files('later-skill'));
  await s.runtime.close();s.store.close();await restore(s.root,snapshot.path,true);s.store=new Store(s.root,s.config);s.runtime=new Runtime(s.store,s.runtime.models);s.runtime.skills.sync();
  expect((await request(s,{action:'list'})).skills.map((skill:any)=>skill.name)).toEqual(['word-count']);expect(existsSync(join(s.root,'skill-recovery'))).toBe(true);
  expect(directoryPackage(join(s.root,'skills','word-count')).files.find(file=>file.path==='assets/binary.bin')!.bytes).toEqual(Buffer.from([0,255,1,128]));
});

it('frees disabled instruction selections without exceeding the active-skill budget on re-enable', async () => {
  const s=instance();for(let index=0;index<9;index++)await install(s,files(`count-${index}`));for(let index=0;index<8;index++)await read(s,`count-${index}`);
  await expect(read(s,'count-8')).rejects.toThrow('conversation budget');await request(s,{action:'disable',name:'count-0'});await read(s,'count-8');await request(s,{action:'enable',name:'count-0'});expect(s.store.all('SELECT * FROM skill_activations')).toHaveLength(8);await expect(read(s,'count-0')).rejects.toThrow('conversation budget');
});

it('keeps edited disabled packages inspectable, disabled after restore and free of orphan publications', async () => {
  const s=instance();atomicWrite(join(s.root,'config.json'),JSON.stringify(s.config));const first=await install(s);
  await request(s,{action:'disable',name:'word-count'});
  const changed=await request(s,{action:'write',name:'word-count',path:'references/format.md',content:'Updated while disabled.',expectedHash:first.hash});expect(changed.enabled).toBe(false);
  expect(await read(s,'word-count','references/format.md')).toMatchObject({text:'Updated while disabled.',enabled:false});
  const snapshot=await backup(s.store);await s.runtime.close();s.store.close();await restore(s.root,snapshot.path,true);s.store=new Store(s.root,s.config);s.runtime=new Runtime(s.store,s.runtime.models);
  expect((await request(s,{action:'list'})).skills).toContainEqual(expect.objectContaining({version:2,status:'disabled',enabled:false}));
  expect(s.store.all("SELECT * FROM skills WHERE status='publishing'")).toEqual([]);await expect(run(s)).rejects.toThrow('not enabled');
});

it('enforces discovery precedence even when the higher-priority directory becomes invalid', async () => {
  const s=instance();await install(s);const higher=join(s.root,'skills','word-count'),lower=join(s.root,'.agents','skills','word-count');
  cpSync(higher,lower,{recursive:true});rmSync(higher,{recursive:true});s.runtime.skills.sync();expect((await read(s)).baseDirectory).toBe('.agents/skills/word-count');
  cpSync(lower,higher,{recursive:true});s.runtime.skills.sync();expect((await read(s)).baseDirectory).toBe('skills/word-count');
  writeFileSync(join(higher,'SKILL.md'),'malformed');s.runtime.skills.sync();expect(await read(s)).toMatchObject({enabled:false,status:'invalid'});await expect(run(s)).rejects.toThrow('not enabled');
  rmSync(higher,{recursive:true});s.runtime.skills.sync();expect(await read(s)).toMatchObject({enabled:true,baseDirectory:'.agents/skills/word-count'});
});

it('does not silently replace legacy scoped procedures with executable packages', async () => {
  const s=instance(),legacy=await rpc(s.runtime,{op:'skills.learn',args:{name:'word-count',instructions:'Legacy instruction only',scope:'terminal'}}) as any;
  await expect(install(s)).rejects.toThrow('legacy procedural skill');expect(await rpc(s.runtime,{op:'skills.read',args:{id:legacy.id,version:legacy.version}})).toMatchObject({permissionsChanged:false});
});

it('keys script receipts by the immutable package revision so changed code cannot inherit old passing tests', async () => {
  const s=instance(),marker=join(s.root,'revision-effects'),script=(value:string)=>`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},${JSON.stringify(value)});console.log('done');`;
  const first=await install(s,[...files(),{path:'scripts/effect.mjs',content:script('x')}]);
  s.faux.appendResponses([loadTools('skills','skills_read','skills_run'),call('skills_read',{name:'word-count'}),call('skills_run',{name:'word-count',script:'scripts/effect.mjs'}),call('skills',{action:'write',name:'word-count',path:'scripts/effect.mjs',content:script('y'),expectedHash:first.hash}),call('skills_read',{name:'word-count'}),call('skills_run',{name:'word-count',script:'scripts/effect.mjs'}),fauxAssistantMessage([fauxText('Both different revisions ran once.')])]);
  const result=await chat(s,'Run and update this synthetic utility');expect(result.status,result.error).toBe('completed');expect(readFileSync(marker,'utf8')).toBe('xy');expect(s.store.all("SELECT * FROM operations WHERE run_id=? AND tool='$skills.run'",result.id)).toHaveLength(2);
});

it('reuses failed-script receipts without repeating already accepted effects', async () => {
  const s=instance(),marker=join(s.root,'failed-effect');await install(s,[...files(),{path:'scripts/fail.mjs',content:`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},'x');process.exit(2);`}]);
  s.faux.appendResponses([loadTools('skills_read','skills_run'),call('skills_read',{name:'word-count'}),call('skills_run',{name:'word-count',script:'scripts/fail.mjs'}),call('skills_run',{script:'scripts/fail.mjs',name:'word-count'}),fauxAssistantMessage([fauxText('Failed, without replay.')])]);
  const result=await chat(s,'Run this synthetic failure once');expect(result.status,result.error).toBe('completed');expect(readFileSync(marker,'utf8')).toBe('x');expect(s.store.all("SELECT * FROM operations WHERE run_id=? AND tool='$skills.run'",result.id)).toHaveLength(1);
});

it('never retries uncertain model-generation errors as format repairs', async () => {
  const s=instance();s.faux.appendResponses([()=>{throw new Error('Synthetic lost model acknowledgment');}]);
  await expect(rpc(s.runtime,{op:'skills.build',args:{specification:'Create a synthetic counter'}})).rejects.toThrow('lost model acknowledgment');expect(s.faux.state.callCount).toBe(1);expect(s.store.all('SELECT * FROM skill_packages')).toEqual([]);
});

it('cancels an actual running child without pretending to undo its earlier write', async () => {
  const s=instance(),marker=join(s.root,'started-child'),controller=new AbortController();
  const pkg=packageFromFiles([...files(),{path:'scripts/wait.mjs',content:`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker + '.tmp')},String(process.pid));fs.renameSync(${JSON.stringify(marker + '.tmp')},${JSON.stringify(marker)});setInterval(()=>{},1000);`}]);
  const running=runSkill(s.root,pkg.files,{script:'scripts/wait.mjs',timeoutMs:10000},[],controller.signal);await waitFor(()=>existsSync(marker));const pid=Number(readFileSync(marker,'utf8'));controller.abort();expect((await running).status).toBe('cancelled');expect(()=>process.kill(pid,0)).toThrow();expect(existsSync(marker)).toBe(true);expect(readdirSync(join(s.root,'skill-work'))).toEqual([]);
});

it('rejects oversized declared ZIP entries and deflate streams that lie about their expanded size', () => {
  const zip=new AdmZip();zip.addFile('unsafe/SKILL.md',Buffer.from(files('unsafe')[0]!.content));const large=zip.toBuffer(),central=large.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));large.writeUInt32LE(4_000_001,central+24);expect(()=>archivePackage(large)).toThrow('expanded byte limit');
  const bomb=new AdmZip();bomb.addFile('unsafe/SKILL.md',Buffer.from(files('unsafe')[0]!.content));bomb.addFile('unsafe/giant.bin',Buffer.alloc(1_500_000));const bytes=bomb.toBuffer();
  for(let i=0;i<bytes.length-46;i++)if(bytes.readUInt32LE(i)===0x02014b50&&bytes.subarray(i+46,i+46+bytes.readUInt16LE(i+28)).toString()==='unsafe/giant.bin')bytes.writeUInt32LE(1,i+24);
  expect(()=>archivePackage(bytes)).toThrow();
});

it('cleans inherited descendant pipes when a successful script parent exits', async () => {
  const s=instance();await install(s,[...files(),{path:'scripts/parent.mjs',content:"import {spawn} from 'node:child_process';spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}).unref();console.log('parent returned');"}]);
  const result=await run(s,{name:'word-count',script:'scripts/parent.mjs',timeoutMs:5000});expect(result.status).toBe('completed');expect(result.stdout).toContain('parent returned');expect(result.durationMs).toBeLessThan(4000);
});

it('cancels owner-RPC scripts before forgetting and prevents late output or journal resurrection', async () => {
  const s=instance(),fact=s.runtime.remember('script origin','synthetic-private-source') as any,started=join(s.root,'script-started'),late=join(s.root,'late-effect');
  const script=`import fs from 'node:fs';console.log('synthetic-forgotten-output');fs.writeFileSync(${JSON.stringify(started)},'started');setTimeout(()=>fs.writeFileSync(${JSON.stringify(late)},'must not happen'),600);setInterval(()=>{},1000);`;
  s.faux.appendResponses([loadTools('memory_read','skills'),call('memory_read',{id:fact.id}),call('skills',{action:'save',files:[...files(),{path:'scripts/wait.mjs',content:script}]}),fauxAssistantMessage([fauxText('Created from sourced context.')])]);expect((await chat(s,'Create a synthetic source-backed skill')).status).toBe('completed');
  await read(s);const pending=rpc(s.runtime,{op:'skills.run',args:{name:'word-count',script:'scripts/wait.mjs'}}).then(value=>({value,error:''}),error=>({error:error.message}));await waitFor(()=>existsSync(started));await s.runtime.forget(fact.id);expect((await pending).error).toContain('invalidated');
  expect(s.store.all('SELECT * FROM skill_packages')).toEqual([]);expect(readdirSync(join(s.root,'skill-work'))).toEqual([]);expect(JSON.stringify(s.store.all('SELECT result FROM operations'))).not.toContain('synthetic-forgotten-output');await new Promise(resolve=>setTimeout(resolve,700));expect(existsSync(late)).toBe(false);
});

it('refuses late downloaded packages after source erasure invalidates their request', async () => {
  const s=instance(),fact=s.runtime.remember('download origin','synthetic-source') as any;let release!:()=>void,started=false;
  vi.spyOn(WebNetwork.prototype,'get').mockImplementation(async()=>{started=true;await new Promise<void>(resolve=>{release=resolve;});return {bytes:Buffer.from(files()[0]!.content)} as any;});
  const pending=request(s,{action:'import',url:'https://skills.example/SKILL.md'}).then(()=>'',error=>error.message);await waitFor(()=>started);await s.runtime.forget(fact.id);release();expect(await pending).toContain('invalidated');expect(s.store.all('SELECT * FROM skill_packages')).toEqual([]);
});

it('bounds selected resource bytes before they can become scripts, assets or execution inputs', async () => {
  const s=instance(),attachment=s.runtime.media.save(Buffer.alloc(4_000_001),'large.bin','application/octet-stream');
  await expect(request(s,{action:'prepare',resources:[{path:'assets/large.bin',attachmentId:attachment}]})).rejects.toThrow('byte limit');expect(s.store.all('SELECT * FROM skill_packages')).toEqual([]);
});

it('rejects private-network skill URLs through the shared public-fetch boundary', async () => {
  const s=instance();await expect(request(s,{action:'import',url:'http://127.0.0.1/SKILL.md'})).rejects.toThrow(/public|private|address/i);expect(s.store.all('SELECT * FROM skill_packages')).toEqual([]);
});

it('deletes a skill from the actual model turn without deadlocking or republishing stale context', async () => {
  const s=instance();await install(s);s.faux.appendResponses([loadTools('skills'),call('skills',{action:'delete',name:'word-count'})]);
  const result=await chat(s,'Delete the installed word-count skill');expect(result.status,result.error).toBe('completed');expect(result.partial).toContain('Skill forgotten');expect(s.store.all('SELECT * FROM skill_packages')).toEqual([]);expect(existsSync(join(s.root,'skills','word-count'))).toBe(false);
});

it('does not allow bounded workflows to generate or activate executable skill packages', async () => {
  const s=instance(),context={ownerId:s.config.ownerId,instanceId:s.config.instanceId,conversationId:s.runtime.newConversation().id,runId:crypto.randomUUID(),source,mode:'foreground' as const},tools=s.runtime.availableTools(context);
  for(const step of [{tool:'skill_build',args:{specification:'Build code'}},{tool:'skills',args:{action:'save',files:files()}}])expect(()=>s.runtime.workflows.define({id:'unsafe-skill',description:'Must be denied',steps:[step]},tools)).toThrow('permitted bounded');
});
