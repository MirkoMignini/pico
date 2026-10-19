import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { initialize, loadConfig, privateDirectory } from '../dist/config.js';
import { Store, hash } from '../dist/store.js';
import { Runtime } from '../dist/runtime.js';
const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const root=arg('--root')?resolve(arg('--root')):mkdtempSync(join(tmpdir(),'pikobot-knowledge-eval-'));
const output=resolve(arg('--output','eval/knowledge-results.json'));
if(!existsSync(root))mkdirSync(root,{mode:0o700,recursive:true});
const config=existsSync(join(root,'config.json'))?loadConfig(root).config:initialize(root,'Synthetic knowledge evaluation');
assert.equal(config.ownerName,'Synthetic knowledge evaluation','Never use an operational instance');delete config.embeddings;
const fixtures=JSON.parse(readFileSync('tests/fixtures/knowledge/manifest.json','utf8')).fixtures;
const protocol=JSON.parse(readFileSync('eval/knowledge-gold.json','utf8'));
const store=new Store(root,config),runtime=new Runtime(store),ids=new Map();
if(arg('--model-cache')){const directory=privateDirectory(join(root,'knowledge','worker-home','qmd'));if(!existsSync(join(directory,'models')))symlinkSync(resolve(arg('--model-cache')),join(directory,'models'),'dir');}
const report={at:new Date().toISOString(),node:process.version,hardware:{cpu:cpus()[0]?.model,cores:cpus().length,ram:totalmem(),platform:process.platform,arch:process.arch},fixtureManifestHash:hash(readFileSync('tests/fixtures/knowledge/manifest.json')),protocolHash:hash(JSON.stringify(protocol)),depth:protocol.depth,root,conversion:[],queries:[],growth:null,qualityGate:null};
const save=()=>writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
try {
  for(const f of fixtures){
    const bytes=readFileSync(join('tests/fixtures/knowledge',f.file));assert.equal(hash(bytes),f.hash);
    const t=performance.now(),a=runtime.media.save(bytes,f.file,'application/octet-stream');
    const d=await runtime.knowledge.importAttachment(a,`evaluation:${f.file}`);ids.set(f.file,d.id);
    await runtime.knowledge.work();
    const rev=runtime.knowledge.revision(d.id);report.conversion.push({file:f.file,id:d.id,expected:f.expectedOutcome,actual:rev.extraction,textPass:!f.expectedText||rev.markdown?.includes(f.expectedText),originalPass:hash(runtime.knowledge.original(d.id).bytes)===f.hash,conversion:JSON.parse(rev.conversion??'{}'),ms:performance.now()-t});save();
  }
  const start=performance.now();console.error('QMD update/embed: actual local models');await runtime.knowledge.index(true);report.indexMs=performance.now()-start;report.indexStatus=await runtime.knowledge.status();save();
  for(const q of protocol.questions){
    const row={id:q.id,split:q.split,question:q.question,answerable:q.answer!==null,expectedFiles:q.files,runs:[]};
    for(const mode of ['lexical','hybrid']){
      const start=performance.now(),result=await runtime.knowledge.search(q.question,mode,protocol.depth);
      const citations=result.results.map(r=>r.citation).filter(Boolean);for(const citation of citations)assert(runtime.knowledge.resolve(citation));
      const sourceIds=result.results.map(r=>r.documentId);row.runs.push({mode,actualStrategy:result.strategy,fallback:result.fallback,ms:performance.now()-start,support:q.answer===null?null:q.files.every(f=>sourceIds.includes(ids.get(f))),sourceIds,citations});
    }
    report.queries.push(row);save();console.error(q.id,row.runs.map(r=>`${r.mode}:${r.support}/${Math.round(r.ms)}ms`).join(' '));
  }
  report.qualityGate=Object.fromEntries(['lexical','hybrid'].map(mode=>{const cases=report.queries.filter(q=>q.split==='heldout'&&q.answerable),hits=cases.filter(q=>q.runs.find(r=>r.mode===mode).support).length;return [mode,{supportHits:hits,answerable:cases.length,recall:hits/cases.length,passed:hits/cases.length>=protocol.supportGate,answerAccuracy:null,note:'Retrieval only; no generated answers in this local run'}];}));save();
  const growthStart=performance.now();let corpusBytes=fixtures.reduce((sum,f)=>sum+f.bytes,0);
  for(let i=0;i<1000;i++){const text=`# Seeded growth ${i}\nReference GROW-${i}. Routine fictional archive about ${['shipping','budgets','calendars','warehouse'][i%4]}.\n`+`Generic distractor ${i}: no changed approvals.\n`.repeat(1+(i*17)%80);corpusBytes+=Buffer.byteLength(text);runtime.knowledge.createNote(`Growth ${i}`,text,`growth:${i}`);}
  await runtime.knowledge.index(true);const growthIndexMs=performance.now()-growthStart;
  const timings=[];for(const mode of ['lexical','hybrid','vector'])for(const query of ['ARC-407','Where is the Nebbia warehouse?','emergency docking place']){const start=performance.now(),result=await runtime.knowledge.search(query,mode);timings.push({mode,query,ms:performance.now()-start,count:result.results.length,fallback:result.fallback});}
  report.growth={documents:runtime.knowledge.list().total,additionalDocuments:1000,corpusBytes,indexMs:growthIndexMs,timings,rss:process.memoryUsage(),status:await runtime.knowledge.status()};save();
}catch(error){report.error=error.message;save();throw error;}
finally{await runtime.close();store.close();}
console.log(JSON.stringify({output,root,qualityGate:report.qualityGate,growth:report.growth?.documents}));
