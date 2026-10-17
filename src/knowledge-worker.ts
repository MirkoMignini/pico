import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QMDStore } from '@tobilu/qmd';
import { anydocConverter } from './converter.js';
import { QMD_CONFIGURATION } from './knowledge-process.js';
process.umask(0o077);
const [kind,root] = process.argv.slice(2);
let store: QMDStore | undefined;
let tail: Promise<unknown> = Promise.resolve();
process.once('disconnect',()=>process.exit(0));
process.on('message',(request: {id:number;op:string;args:Record<string,any>}) => {
  tail=tail.then(async()=>{
    try {
      let result: unknown;
      if(kind==='web') {
        const { duckduckgoResults, braveResults, webArticle } = await import('./web-extract.js');
        const a = request.args;
        if(request.op==='duckduckgo') result=duckduckgoResults(a.body,a.limit);
        else if(request.op==='brave') result=braveResults(a.body,a.limit);
        else if(request.op==='article') result=webArticle(a.body,a.url,a.mime,a.contentType);
        else throw new Error('Unknown web extraction operation');
      } else if(kind==='convert'&&request.op==='image-preview') {
        const {getImageDimensions}=await import('@earendil-works/pi-tui'),a=request.args;
        if(!(a.bytes instanceof Uint8Array)||a.bytes.length>20_000_000||!['image/jpeg','image/gif','image/webp'].includes(a.mime))throw new Error('Invalid image preview input');
        const dimensions=getImageDimensions(Buffer.from(a.bytes).toString('base64'),a.mime);
        if(!dimensions||dimensions.widthPx*dimensions.heightPx>16_000_000)throw new Error('Image preview pixel limit exceeded');
        const {RawImage}=await import('@huggingface/transformers');
        const image=await RawImage.fromBlob(new Blob([new Uint8Array(a.bytes)],{type:a.mime}));
        result=await image.toSharp().resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).png().toBuffer();
        if((result as Uint8Array).length>20_000_000)throw new Error('Image preview byte limit exceeded');
      } else if(kind==='convert') {
        result=await anydocConverter.convert(request.args.bytes??await readFile(request.args.path),request.args.name,request.args.mime);
      } else {
        if(!store) {
          const { createStore }=await import('@tobilu/qmd');
          store=await createStore({dbPath:join(root!,'knowledge','qmd.sqlite'),config:{models:QMD_CONFIGURATION.models,collections:{knowledge:{path:join(root!,'knowledge','searchable'),pattern:'*.md'}}}});
        }
        const a=request.args;
        switch(request.op) {
          case 'update': result=await store.update({collections:['knowledge']});break;
          case 'embed': result=await store.embed({collection:'knowledge',maxDocsPerBatch:16,maxBatchBytes:2_000_000,force:a.force===true});break;
          case 'lexical': result=await store.searchLex(a.query,{collection:'knowledge',limit:a.limit});break;
          case 'vector': result=await store.searchVector(a.query,{collection:'knowledge',limit:a.limit});break;
          case 'fast': {
            const query=a.query.replace(/[\r\n]/g,' ');
            result=await store.search({queries:[{type:'lex',query},{type:'vec',query}],collection:'knowledge',limit:a.limit,candidateLimit:QMD_CONFIGURATION.candidateLimit,rerank:false});break;
          }
          case 'hybrid': result=await store.search({query:a.query,collection:'knowledge',limit:a.limit,candidateLimit:QMD_CONFIGURATION.candidateLimit,rerank:true});break;
          case 'get': result=await store.getDocumentBody(a.path,{fromLine:a.fromLine,maxLines:a.maxLines});break;
          case 'status': result={status:await store.getStatus(),health:await store.getIndexHealth()};break;
          case 'cleanup': { const { Maintenance }=await import('@tobilu/qmd'); result=await new Maintenance(store.internal).run();break; }
          default: throw new Error('Unknown knowledge worker operation');
        }
      }
      process.send?.({id:request.id,result});
    } catch(error) { process.send?.({id:request.id,error:error instanceof Error?error.message.slice(0,1000):'Knowledge processing failed'}); }
  });
});
