import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../src/daemon.js';
import { Runtime } from '../src/runtime.js';
import { atomicWrite } from '../src/config.js';
import { archivePackage } from '../src/skill-package.js';
import { setup } from './helpers.js';

it('imports, inspects, executes and privately exports a standard skill through the compiled CLI and authenticated Unix IPC', async () => {
  const s=setup('skill-cli'),execute=promisify(execFile);atomicWrite(join(s.root,'config.json'),JSON.stringify(s.config));
  const service=await serve(s.root,{runtimeFactory:store=>new Runtime(store,s.runtime.models)});
  const cli=async(...args:string[])=>{const result=await execute(process.execPath,[fileURLToPath(new URL('../dist/cli.js',import.meta.url)),'--instance',s.root,'skills',...args],{timeout:10000});return JSON.parse(result.stdout);};
  try {
    const imported=await cli('import',fileURLToPath(new URL('../examples/skills/text-statistics',import.meta.url)));expect(imported.saved).toBe(true);
    expect((await cli('list')).skills).toContainEqual(expect.objectContaining({name:'text-statistics',enabled:true}));expect((await cli('read','text-statistics')).text).toContain('Text statistics');
    const result=await cli('run','text-statistics','scripts/analyze.mjs',JSON.stringify({text:'Hello, world!'}));expect(result.status).toBe('completed');expect(JSON.parse(result.stdout)).toEqual({characters:13,words:2,lines:1});
    const destination=join(s.root,'text-statistics.zip');expect(await cli('export','text-statistics',destination)).toEqual({saved:true});expect(statSync(destination).mode&0o777).toBe(0o600);expect(archivePackage(readFileSync(destination)).hash).toBe(imported.hash);
    await expect(cli('export','text-statistics',destination)).rejects.toThrow();expect(archivePackage(readFileSync(destination)).hash).toBe(imported.hash);
  } finally { await service.close();await s.runtime.close();s.store.close();rmSync(s.root,{recursive:true,force:true}); }
});
