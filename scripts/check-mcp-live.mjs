#!/usr/bin/env node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') { console.log('Build first, then: node scripts/check-mcp-live.mjs --run\nUses only new disposable stores and public credential-free Microsoft Learn/DeepWiki read tools. No model, owner credentials, existing instance, server installation or remote writes. Private reports remain in /tmp, including failures.'); process.exit(0); }
if (args.length !== 1 || args[0] !== '--run') throw new Error('Explicit --run required; use --help. No instance/credential arguments are accepted.');

const [{ initialize }, { Store }, { Runtime }, { Credentials }, { ModelAccess }, { rpc }] = await Promise.all(['config', 'store', 'runtime', 'credentials', 'models', 'daemon'].map(name => import(`../dist/${name}.js`)));
const directory = await mkdtemp(join(tmpdir(), 'pikobot-mcp-live-'));
const plans = [
  { id: 'microsoft', url: 'https://learn.microsoft.com/api/mcp', name: 'microsoft_docs_search', arguments: { query: 'Model Context Protocol TypeScript SDK initialization' } },
  { id: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp', name: 'read_wiki_structure', arguments: { repoName: 'modelcontextprotocol/typescript-sdk' } }
];
const report = { startedAt: new Date().toISOString(), evidence: 'Live public MCP HTTP interoperability, not model correctness, authenticated vendor OAuth or production reliability', cases: plans.map(plan => ({ ...plan, status: 'not_run' })) };
try {
for (const entry of report.cases) {
  const root = join(directory, entry.id); await mkdir(root, { mode: 0o700 });
  const config = initialize(root, 'Synthetic MCP interoperability'); delete config.embeddings;
  config.limits.backgroundIntervalMs = 86_400_000; config.limits.runTimeoutMs = 120_000;
  const store = new Store(root, config), runtime = new Runtime(store, new ModelAccess(new Credentials(root), config));
  const started = Date.now();
  const invoke = (op, args = {}) => rpc(runtime, { op: `extensions.mcp.${op}`, args });
  try {
    await runtime.start();
    await rpc(runtime, { op: 'extensions.configure', args: { id: 'mcp', settings: { servers: [{ id: entry.id, enabled: true, transport: 'http', url: entry.url, tools: [entry.name], readOnlyTools: [entry.name], timeoutMs: 45_000, maxBytes: 4_000_000 }] } } });
    await invoke('connect', { server: entry.id });
    entry.connection = (await invoke('status')).servers[0];
    entry.catalog = await invoke('catalog', { server: entry.id, kind: 'tools', limit: 100 });
    if (!entry.catalog.entries?.some(tool => tool.name === entry.name && tool.enabled)) throw new Error('Expected public read tool missing or catalog preview incomplete');
    entry.result = await invoke('call', { server: entry.id, name: entry.name, arguments: entry.arguments });
    if (entry.result.truncated && entry.result.originalResultSourceId) {
      entry.preview = entry.result;
      const source = await rpc(runtime, { op: 'source.read', args: { id: entry.result.originalResultSourceId } });
      if (source.operationStatus !== 'completed') throw new Error('Incomplete result has no completed canonical receipt');
      entry.result = JSON.parse(JSON.parse(source.text).content[0].text);
      entry.originalResultSourceId = source.id;
    }
    if (entry.result.isError || !(entry.result.content?.some(block => block.type === 'text' && block.text.trim()) || entry.result.structuredContent)) throw new Error('Public MCP returned an error, empty response or incomplete preview');
    entry.modelCalls = runtime.models.nonAgentUsage.length + store.get("SELECT count(*) count FROM messages WHERE role='assistant'").count + store.get("SELECT count(*) count FROM operations WHERE tool='$model.complete'").count;
    if (entry.modelCalls !== 0) throw new Error('Unexpected model usage');
    entry.status = 'passed';
  } catch (error) { entry.status = 'failed'; entry.error = error instanceof Error ? error.message : 'Live MCP check failed'; entry.connection = (await invoke('status').catch(() => ({}))).servers?.[0]; }
  finally { entry.durationMs = Date.now() - started; await runtime.close(); store.close(); await rm(root, { recursive: true, force: true }); }
}
} catch (error) { report.error = error instanceof Error ? error.message : 'Live check/cleanup failed'; process.exitCode = 1; }
finally {
report.finishedAt = new Date().toISOString();
const path = join(directory, 'report.json'); await writeFile(path, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ report: path, cases: report.cases.map(({ id, status, durationMs, error }) => ({ id, status, durationMs, error })) }, null, 2));
if (report.cases.some(entry => entry.status !== 'passed')) process.exitCode = 1;
}
