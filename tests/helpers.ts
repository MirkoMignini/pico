import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize } from '../src/config.js';
import { Store } from '../src/store.js';
import { Runtime } from '../src/runtime.js';
import { Credentials } from '../src/credentials.js';
import { ModelAccess } from '../src/models.js';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
export const source = { channel: 'terminal' as const, identity: 'test-owner', trustedOwner: true };
export function setup(name='owner') {
  const root = mkdtempSync(join(tmpdir(),'pikobot-test-'));
  const config = initialize(root,name);
  delete config.embeddings; // Fast deterministic core tests; real multilingual retrieval has a separate evaluation gate.
  const faux = fauxProvider({ tokensPerSecond: 500 });
  config.model = {provider:faux.provider.id,id:faux.getModel().id};
  const credentials = new Credentials(root), models = builtinModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } }); models.setProvider(faux.provider);
  const store = new Store(root,config), runtime = new Runtime(store,new ModelAccess(credentials,config,models));
  return {root,config,store,runtime,faux};
}
export const loadTools = (...names: string[]) => fauxAssistantMessage([fauxToolCall('tools_load', { names })], { stopReason: 'toolUse' });
export function reply(faux: ReturnType<typeof fauxProvider>, text: string) { faux.appendResponses([fauxAssistantMessage([fauxText(text)])]); }
export async function waitFor(fn: () => boolean, ms=5000) {
  const until = Date.now()+ms;
  while (!fn()) { if (Date.now()>until) throw new Error('Timed out waiting for state'); await new Promise(resolve=>setTimeout(resolve,10)); }
}
