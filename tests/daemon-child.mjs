// Trusted fault-injection fixture, never used by the public CLI.
import {serve} from '../dist/daemon.js';
import {Runtime} from '../dist/runtime.js';
import {Credentials} from '../dist/credentials.js';
import {ModelAccess} from '../dist/models.js';
import {createModels,fauxProvider,fauxAssistantMessage,fauxText,fauxToolCall} from '@earendil-works/pi-ai';
const [root,scenario,endpoint]=process.argv.slice(2);
const daemon=await serve(root,{runtimeFactory(store){
 const faux=fauxProvider({tokensPerSecond:scenario==='stream'?20:2000});
 store.config.model={provider:faux.provider.id,id:faux.getModel().id};
 const credentials=new Credentials(root),models=createModels({credentials});models.setProvider(faux.provider);
 const runtime=new Runtime(store,new ModelAccess(credentials,store.config,models));
 if(scenario==='intent'){
  const search=runtime.memory.search.bind(runtime.memory);
  runtime.memory.search=async(query,options)=>{if(query!=='accepted-effect-fixture')return search(query,options);await fetch(endpoint,{method:'POST'});return new Promise(()=>{});};
  faux.appendResponses([fauxAssistantMessage(fauxToolCall('memory_search',{query:'accepted-effect-fixture'}),{stopReason:'toolUse'})]);
 }else faux.appendResponses([fauxAssistantMessage(fauxText(scenario==='stream'?'Unfinished streaming fixture '.repeat(500):'Recovered safely'))]);
 return runtime;
}});
console.log('READY');
process.on('SIGTERM',()=>{void daemon.close().then(()=>process.exit(0));});
