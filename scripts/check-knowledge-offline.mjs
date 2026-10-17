import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { anydocConverter } from '../dist/converter.js';
const root='tests/fixtures/knowledge';
const fixtures=JSON.parse(readFileSync(`${root}/manifest.json`)).fixtures;
let uploads=0;
globalThis.fetch=async()=>{uploads++;throw new Error('Network denied in offline converter validation');};
for(const f of fixtures){const result=await anydocConverter.convert(readFileSync(`${root}/${f.file}`),f.file,'application/octet-stream');assert.equal(result.status,f.expectedOutcome,f.file);if(f.expectedText)assert(result.markdown.includes(f.expectedText),f.file);}
assert.equal(uploads,0);console.log(JSON.stringify({fixtures:fixtures.length,networkCalls:uploads,passed:true,note:'Run this in Docker --network none for OS-enforced network denial'}));
