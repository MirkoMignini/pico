import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initialize } from '../dist/config.js';
import { Store, hash } from '../dist/store.js';
import { Runtime } from '../dist/runtime.js';
import { Credentials } from '../dist/credentials.js';
import { ModelAccess } from '../dist/models.js';
import { rpc } from '../dist/daemon.js';
const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const selectedProvider=arg('--provider','all');assert(['all','openai','deepseek'].includes(selectedProvider),'Unknown evaluation provider; choose all, openai or deepseek');
const selections=[{provider:'openai',id:arg('--openai-model','gpt-4o-mini')},{provider:'deepseek',id:arg('--deepseek-model','deepseek-flash')}].filter(selection=>selectedProvider==='all'||selection.provider===selectedProvider);
assert.equal(selections.length,selectedProvider==='all'?2:1);
const credentialRoot=arg('--credential-root');assert(credentialRoot,'Explicit credential service root required; billed calls must be authorized');
const output=resolve(arg('--output','eval/knowledge-live-results.json'));
assert(!output.startsWith(resolve(credentialRoot)+'/'));
const modelCache=arg('--model-cache');
const credentials=new Credentials(credentialRoot);
const source={channel:'terminal',identity:'synthetic-live-owner',trustedOwner:true};
const report={at:new Date().toISOString(),node:process.version,fixtureManifestHash:hash(readFileSync('tests/fixtures/knowledge/manifest.json')),protocolHash:existsSync('eval/knowledge-gold.json')?hash(readFileSync('eval/knowledge-gold.json')):null,models:[],providers:[],note:'Real Pikobot Runtime foreground tool workflow, synthetic stores, explicit existing credential service. No operational database migrations or connector sends. Strict checks require manual factuality review.'};
const save=()=>writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
const wait=async runtime=>{const until=Date.now()+240_000;while(runtime.hasPendingRuns){assert(Date.now()<until,'Foreground timeout');await new Promise(resolve=>setTimeout(resolve,30));}};
for(const selection of selections) {
  assert.equal((await credentials.read(selection.provider))?.type,'api_key',`Configured ${selection.provider} API account required; no fallback`);
  const root=mkdtempSync(join(tmpdir(),'pikobot-knowledge-live-')),config=initialize(root,'Synthetic knowledge live owner');config.model=selection;delete config.embeddings;
  let store=new Store(root,config),models=new ModelAccess(credentials,config),runtime=new Runtime(store,models);
  const model=models.model(selection);assert.equal(model.provider,selection.provider);assert.equal(model.id,selection.id);report.models.push({provider:model.provider,id:model.id,baseUrl:model.baseUrl,input:model.input});
  const provider={model:selection,scenarios:[],usage:[],index:null,requests:0};report.providers.push(provider);save();
  const run=async(question)=>{
    const catalogHints=runtime.knowledge.list(0,20,'needs_ocr'),initialRetrieval=[],search=runtime.knowledge.search.bind(runtime.knowledge);
    runtime.knowledge.search=async(...args)=>{const result=await search(...args);initialRetrieval.push({query:args[0],strategy:result.strategy,sourceIds:result.results.map(record=>record.documentId)});return result;};
    provider.requests++;const t=performance.now(),c=runtime.newConversation(`Live scenario ${provider.requests}`);
    const receipt=await rpc(runtime,{op:'input',args:{conversationId:c.id,requestId:`live:${provider.requests}`,text:question+'\nUse Pikobot tools to check durable evidence. Cite the returned pikobot source citation for document claims. Do not guess unavailable facts.'}});
    await wait(runtime);const row=runtime.run(receipt.id),tools=store.all('SELECT tool,status,result FROM operations WHERE run_id=?',row.id);
    const usage=store.all("SELECT body FROM messages WHERE run_id=? AND role='assistant'",row.id).map(row=>JSON.parse(row.body).usage);provider.usage.push(...usage);
    runtime.knowledge.search=search;
    const toolErrors=store.all("SELECT body FROM messages WHERE run_id=? AND role='toolResult'",row.id).map(row=>JSON.parse(row.body)).filter(message=>message.isError).map(message=>message.content);
    const providerErrors=store.all("SELECT body FROM messages WHERE run_id=? AND role='assistant'",row.id).map(row=>JSON.parse(row.body).errorMessage).filter(Boolean).map(message=>message.replace(/sk-[A-Za-z0-9_-]+/g,'[redacted]'));
    return {question,status:row.status,error:row.error,providerErrors,toolErrors,initialRetrieval,catalogHints,answer:row.partial,ms:performance.now()-t,tools,usage};
  };
  const add=async(file)=>{const upload=await rpc(runtime,{op:'attachments.upload',args:{name:file,mime:'application/octet-stream',data:readFileSync(join('tests/fixtures/knowledge',file)).toString('base64')}});const doc=await rpc(runtime,{op:'knowledge',args:{action:'import',attachmentId:upload.id,submission:`live:${file}`}});await runtime.knowledge.work();return doc;};
  const evidenceCheck=(result,aliases,ids,abstain=false)=>{
    const citations=[...result.answer.matchAll(/pikobot:[a-f0-9-]{36}:r\d+:md:[a-f0-9]{64}:[LC]\d+-\d+/g)].map(match=>match[0]);
    const valid=citations.every(citation=>{try{return !!runtime.knowledge.resolve(citation);}catch{return false;}});
    const citationIds=citations.map(c=>c.split(':')[1]);
    return {validCitations:valid,citations,aliasPass:aliases.every(alias=>result.answer.toLowerCase().includes(alias.toLowerCase())),sourcePass:abstain||ids.every(id=>citationIds.includes(id)),abstains:!abstain||/(?:do not|don't|cannot|can't|could not|couldn't) (?:know|find|determine|tell)|not (?:available|recorded|provided|found)|no (?:evidence|information)|unknown|non (?:so|ho)|does not (?:contain|include)|not have/i.test(result.answer),toolPass:result.tools.some(t=>t.tool==='documents'&&t.status==='completed')||result.initialRetrieval.some(read=>read.sourceIds.length>0)||abstain&&result.catalogHints.total>0,completed:result.status==='completed'};
  };
  try {
    const aster=await add('policy-en.txt'),nebbia=await add('regole-italiano.txt'),long=await add('long.pdf'),table=await add('ledger.xlsx'),scan=await add('scan.pdf');
    if(modelCache){const dir=join(root,'knowledge','worker-home','qmd');mkdirSync(dir,{recursive:true,mode:0o700});symlinkSync(resolve(modelCache),join(dir,'models'),'dir');}
    await runtime.knowledge.index(true);provider.index=await runtime.knowledge.status();save();
    const scenarios=[
      ['exact','Find document reference AST-104. What is its approved budget?',['731'],[aster.id]],
      ['paraphrase','Which person looks after the Aster initiative?',['Elena','Rossi'],[aster.id]],
      ['italian_over_english','Chi coordina il progetto Aster?',['Elena','Rossi'],[aster.id]],
      ['english_over_italian','Where is the Nebbia warehouse, not the excluded city?',['Torino'],[nebbia.id]],
      ['long_document','What is the emergency docking place in the long archive?',['Cobalt','17'],[long.id]],
      ['two_documents','Who coordinates Aster and Nebbia?',['Elena','Giulia'],[aster.id,nebbia.id]],
      ['table','What is the amount for invoice XLS-601?',['213'],[table.id]]
    ];
    for(const [id,question,aliases,ids]of scenarios){const result=await run(question),checks=evidenceCheck(result,aliases,ids);provider.scenarios.push({id,result,checks,pass:Object.values(checks).filter(v=>typeof v==='boolean').every(Boolean)});save();console.error(selection.provider,id,provider.scenarios.at(-1).pass);}
    const note=await rpc(runtime,{op:'knowledge',args:{action:'create',title:'Current allocation',markdown:'UPD-812 allocation is EUR 611.',submission:'update'}});
    const edit=await run(`Update note ${note.id}: replace 611 with 722, preserving all other content. Read it first and use the current revision.`);
    await runtime.close();store.close();store=new Store(root,config);models=new ModelAccess(credentials,config);runtime=new Runtime(store,models);
    const updated=await run('What is the current allocation for UPD-812?'),checks=evidenceCheck(updated,['722'],[note.id]);checks.storedEdit=runtime.knowledge.revision(note.id).note_text.includes('722');provider.scenarios.push({id:'after_update_restart',edit,result:updated,checks,pass:Object.values(checks).filter(v=>typeof v==='boolean').every(Boolean)});save();
    const doomed=await rpc(runtime,{op:'knowledge',args:{action:'create',title:'Deleted fixture',markdown:'DEL-913 vault label was Periwinkle.',submission:'deleted'}});
    await rpc(runtime,{op:'knowledge',args:{action:'delete',id:doomed.id}});
    const deleted=await run('What was the vault label for DEL-913?'),deletionChecks=evidenceCheck(deleted,[],[],true);deletionChecks.noLeakedValue=!/Periwinkle/i.test(deleted.answer);provider.scenarios.push({id:'after_delete',result:deleted,checks:deletionChecks,pass:Object.values(deletionChecks).filter(v=>typeof v==='boolean').every(Boolean)});save();
    const unavailable=await run('Read the scan-only PDF. What code is printed in the scanned image?'),unavailableChecks=evidenceCheck(unavailable,[],[],true);unavailableChecks.noFabrication=!/SCAN-991/i.test(unavailable.answer);provider.scenarios.push({id:'unavailable_ocr',result:unavailable,checks:unavailableChecks,pass:Object.values(unavailableChecks).filter(v=>typeof v==='boolean').every(Boolean)});save();
    const created=await run('Create an identifiable Markdown checklist titled Alpine kit. Add two incomplete items, passport and jacket, using stable checklist item IDs. This is a note, not a scheduled reminder.');
    const checklist=store.get("SELECT * FROM documents WHERE kind='note' AND title LIKE '%Alpine%' AND deleted_at IS NULL");
    const modified=checklist?await run(`In checklist ${checklist.id}, mark passport complete and add water bottle. Preserve jacket and unrelated content. Read item IDs and current revision first.`):null;
    const items=checklist?runtime.knowledge.items(checklist.id):[];const checklistChecks={created:created.status==='completed',modified:modified?.status==='completed',stableId:items.some(i=>i.text.toLowerCase().includes('passport')&&i.completed),preserved:items.some(i=>i.text.toLowerCase().includes('jacket')&&!i.completed),added:items.some(i=>i.text.toLowerCase().includes('water')),noSchedule:runtime.scheduler.list().length===0};provider.scenarios.push({id:'checklist_create_modify',created,modified,items,checks:checklistChecks,pass:Object.values(checklistChecks).every(Boolean)});save();
    const memory=runtime.remember('favorite tea','oolong');config.embeddings={provider:'openai',model:'text-embedding-3-large',dimensions:3072,maxScan:10000};await runtime.close();store.close();store=new Store(root,config);models=new ModelAccess(credentials,config);runtime=new Runtime(store,models);
    while(await runtime.memory.indexPending()){}
    provider.hostedEmbeddings={model:runtime.memory.embeddings.model,dimensions:runtime.memory.embeddings.dimensions,usage:runtime.memory.embeddings.usage};save();
    const continuity=await run('What is my favorite tea, and who coordinates Aster?'),continuityChecks=evidenceCheck(continuity,['oolong','Elena'],[aster.id]);continuityChecks.memorySurvived=runtime.memory.read(memory.id).memory.value==='oolong';provider.scenarios.push({id:'existing_memory_continuity',result:continuity,checks:continuityChecks,pass:Object.values(continuityChecks).filter(v=>typeof v==='boolean').every(Boolean)});save();
    if(process.argv.includes('--evaluate-gold')) {
      const manifest=JSON.parse(readFileSync('tests/fixtures/knowledge/manifest.json','utf8')),protocol=JSON.parse(readFileSync('eval/knowledge-gold.json','utf8')),documents=new Map();
      for(const fixture of manifest.fixtures){const existing=store.get("SELECT id FROM documents WHERE submission=? AND deleted_at IS NULL",`live:${fixture.file}`);const doc=existing??await add(fixture.file);documents.set(fixture.file,doc.id);}
      await runtime.knowledge.index(true);provider.evaluation={protocolVersion:protocol.protocolVersion,depth:protocol.depth,queries:[],gates:null};save();
      for(const q of protocol.questions) {
        const result=await run(q.question),aliases=q.answer===null?[]:q.answer.split(';'),checks=evidenceCheck(result,aliases,q.files.map(file=>documents.get(file)),q.answer===null);
        const row={id:q.id,split:q.split,answerable:q.answer!==null,result,checks,pass:Object.values(checks).filter(value=>typeof value==='boolean').every(Boolean)};
        provider.evaluation.queries.push(row);save();console.error(selection.provider,q.id,row.pass);
      }
      const heldout=provider.evaluation.queries.filter(q=>q.split==='heldout'&&q.answerable),supported=heldout.filter(q=>q.pass).length,unavailable=provider.evaluation.queries.filter(q=>q.split==='heldout'&&!q.answerable);
      provider.evaluation.gates={answerable:heldout.length,supported,supportedAnswerAccuracy:supported/heldout.length,passed:supported/heldout.length>=protocol.answerGate,abstention:{cases:unavailable.length,passed:unavailable.filter(q=>q.pass).length},note:'Strict literal/source checks; human semantic adjudication still required. Gold never supplied to Runtime.'};save();
    }
    provider.summary={scenarios:provider.scenarios.length,passed:provider.scenarios.filter(s=>s.pass).length,modelResponses:provider.usage.length,estimatedUsage:provider.usage.reduce((sum,u)=>({input:sum.input+(u?.input??0),output:sum.output+(u?.output??0),cost:sum.cost+(u?.cost?.total??0)}),{input:0,output:0,cost:0})};save();
  }catch(error){provider.error=error.message;save();console.error(selection.provider,error.message);}
  finally{await runtime.close();store.close();rmSync(root,{recursive:true,force:true});}
}
console.log(JSON.stringify(report));
if(report.providers.some(p=>p.summary?.scenarios!==12||p.summary?.passed!==12||p.evaluation&&!p.evaluation.gates?.passed))process.exitCode=1;
