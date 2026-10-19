import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { initialize } from '../dist/config.js';
import { Store, hash } from '../dist/store.js';
import { Runtime } from '../dist/runtime.js';
import { Credentials } from '../dist/credentials.js';
import { ModelAccess, assistantText } from '../dist/models.js';

const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const credentialRoot = arg('--credential-root');
assert(credentialRoot, 'Explicit --credential-root is required; no environment/Pi/account credential discovery. Live API charges must be authorized.');
const split = arg('--split', 'validation'), repeats = Number(arg('--repeat', '1'));
assert(['development', 'validation'].includes(split)); assert(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10);
const fixturePath = arg('--fixtures', 'eval/mem0-validation.json'), output = resolve(arg('--output', `eval/${basename(fixturePath, '.json')}-${split}-results.json`));
assert(output !== resolve(credentialRoot) && !output.startsWith(resolve(credentialRoot) + '/'), 'Reports cannot be written into the credential instance.');
const fixtureText = await readFile(resolve(fixturePath), 'utf8');
const fixtures = JSON.parse(fixtureText)[split]; assert(fixtures?.messages?.length && fixtures?.questions?.length, 'Fixture split is empty');
const retrieval = arg('--retrieval', 'foreground'); assert(['standalone', 'foreground'].includes(retrieval));
const foregroundRetrieval = retrieval === 'foreground';
const normalize = text => text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const abstains = text => /(?:do not|don't|cannot|can't) (?:know|determine|find|establish)|not (?:recorded|provided|mentioned|available|specified)|no (?:evidence|information)|unknown|non (?:so|ho)|not have/i.test(text);
const wait = async fn => { const until = Date.now() + 180_000; while (!fn()) { assert(Date.now() < until, 'Foreground run did not settle'); await new Promise(resolve => setTimeout(resolve, 25)); } };
const files = (await readdir(new URL('../dist/', import.meta.url))).filter(name => name.endsWith('.js') && !name.startsWith('._')).sort();
const build = await Promise.all(files.map(async name => ({ file: `dist/${name}`, sha256: hash(await readFile(new URL(`../dist/${name}`, import.meta.url))) })));
for (const file of ['migrations/007.sql', 'migrations/008.sql', 'migrations/009.sql', 'patches/mem0ai@3.3.1.patch', 'pnpm-lock.yaml', 'scripts/validate-memory.mjs']) build.push({ file, sha256: hash(await readFile(new URL(`../${file}`, import.meta.url))) });
const report = { buildHash: hash(JSON.stringify(build)), build, protocol: fixturePath, protocolHash: hash(fixtureText), retrievalMeasurement: foregroundRetrieval ? 'First model-selected memory search, capped at ten results; empty if no search (on-demand context protocol)' : 'Standalone question before foreground ingestion', split, createdAt: new Date().toISOString(), node: process.version, engine: 'mem0ai/oss@3.3.1', models: { chat: 'deepseek/deepseek-flash', embeddings: 'text-embedding-3-small', dimensions: 1536 }, retrievalDepth: 10,
  note: 'Real foreground ingestion, asynchronous extraction, retrieval and new-session answers. No accepted facts seeded. Strict checks are not a complete factuality/attribution grader; review all records and answers.', runs: [] };

for (let iteration = 0; iteration < repeats; iteration++) {
  const root = await mkdtemp(join(tmpdir(), 'pikobot-natural-memory-'));
  const config = initialize(root, 'Synthetic memory validation owner');
  config.model = { provider: 'deepseek', id: 'deepseek-flash' };
  config.embeddings = { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536, maxScan: 10000 };
  const credentials = new Credentials(credentialRoot);
  assert((await credentials.read('deepseek'))?.type === 'api_key', 'Configured DeepSeek API credential required');
  assert(await credentials.secret('openai.embeddingKey'), 'Configured OpenAI embedding/API credential required');
  const models = new ModelAccess(credentials, config);
  let store = new Store(root, config), runtime = new Runtime(store, models);
  const sessions = new Map(), sources = new Map();
  const run = { iteration: iteration + 1, messages: [], questions: [], extractionResponses: [], usage: null, persistence: false, forgetting: false };
  const searches = [], search = runtime.memory.search.bind(runtime.memory);
  runtime.memory.search = async (...args) => { const result = await search(...args); searches.push({ query: args[0], results: result }); return result; };
  const complete = models.complete.bind(models);
  models.complete = async (...args) => { const result = await complete(...args); if (args[3]?.json) run.extractionResponses.push(assistantText(result)); return result; };
  try {
    for (let i = 0; i < 80; i++) runtime.ownerEvidence(`Routine synthetic archive note ${i}: I reviewed a generic calendar export and sorted a collection of old stationery. Nothing changed in my personal profile.`);
    for (const message of fixtures.messages) {
      if (!sessions.has(message.session)) sessions.set(message.session, runtime.newConversation(message.session).id);
      const conversationId = sessions.get(message.session);
      const receipt = await runtime.ingest({ requestId: message.id, conversationId, text: message.text }, { channel: 'terminal', identity: 'synthetic-owner', trustedOwner: true });
      await wait(() => !['queued', 'running'].includes(runtime.run(receipt.id).status));
      assert.equal(runtime.run(receipt.id).status, 'completed', `Foreground ingestion failed for ${message.id}`);
      const original = store.get("SELECT id FROM messages WHERE run_id=? AND role='user'", receipt.id).id;
      sources.set(message.id, original);
      for (let attempt = 0; attempt < 3 && store.get('SELECT status FROM reviews WHERE source_id=?', original).status === 'pending'; attempt++) {
        store.run('UPDATE reviews SET next_at=0 WHERE source_id=?', original);
        await runtime.memory.extractOne(models);
      }
      const review = store.get('SELECT status,attempts,error FROM reviews WHERE source_id=?', original);
      const facts = store.all('SELECT m.*,e.quote FROM memories m LEFT JOIN memory_evidence e ON e.memory_id=m.id WHERE m.source_id=?', original).map(fact => ({ ...fact, contextSourceIds: store.all('SELECT source_id FROM memory_dependencies WHERE memory_id=?', fact.id).map(row => row.source_id) }));
      const matches = message.facts.map(([entity, value]) => ({ entity, value, found: facts.some(fact => (entity === 'owner' ? fact.entity === `owner:${config.ownerId}` : normalize(fact.entity).includes(normalize(entity))) && normalize(`${fact.key} ${fact.value}`).includes(normalize(value))) }));
      run.messages.push({ id: message.id, text: message.text, sourceId: original, assistantSourceId: store.get("SELECT id FROM messages WHERE run_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 1", receipt.id)?.id, review, foregroundAnswer: runtime.run(receipt.id).partial, expectedFacts: matches, facts });
      while (await runtime.memory.indexPending()) {}
      console.error(`${split} ${iteration + 1}: ${message.id}, ${facts.length} extracted, ${review.status}`);
    }
    assert.equal(store.get("SELECT count(*) n FROM memories WHERE entity='user'").n, 0, 'Mem0 user aliases must resolve to the immutable owner entity');
    run.ownerNamespaceBoundary = true;
    // A fresh Store sees durable facts and original evidence, not a transient model cache.
    const reopened = new Store(root, config);
    try { assert.equal(reopened.get('SELECT count(*) n FROM memories').n, store.get('SELECT count(*) n FROM memories').n); run.persistence = true; } finally { reopened.close(); }
    await runtime.close(); store.close(); store = new Store(root, config); runtime = new Runtime(store, models);
    const restartedSearch = runtime.memory.search.bind(runtime.memory);
    runtime.memory.search = async (...args) => { const result = await restartedSearch(...args); searches.push({ query: args[0], results: result }); return result; };
    for (const question of fixtures.questions) {
      let retrieved = foregroundRetrieval ? [] : await runtime.memory.search(question.question, { limit: 10 });
      searches.length = 0;
      const expectedSourceIds = question.sources.map(id => sources.get(id));
      const conversation = runtime.newConversation(`Probe ${question.id}`);
      const receipt = await runtime.ingest({ requestId: question.id, conversationId: conversation.id, text: `${question.question}\nAnswer in English, with full dates in YYYY-MM-DD format. Cite original source IDs. If unknown, say you do not know.` }, { channel: 'terminal', identity: 'synthetic-owner', trustedOwner: true });
      await wait(() => !['queued', 'running'].includes(runtime.run(receipt.id).status));
      if (foregroundRetrieval) retrieved = (searches[0]?.results ?? []).slice(0, 10);
      const answer = runtime.run(receipt.id).partial;
      const aliasMatches = question.aliases.map(alias => ({ alias, matched: normalize(answer).includes(normalize(alias)) }));
      const forbiddenMatches = question.forbidden.filter(alias => normalize(answer).includes(normalize(alias)));
      const sourceSupported = expectedSourceIds.some(id => answer.includes(id));
      const correct = runtime.run(receipt.id).status === 'completed' && (question.abstain ? abstains(answer) : aliasMatches.every(item => item.matched) && !forbiddenMatches.length && sourceSupported);
      run.questions.push({ ...question, answer, status: runtime.run(receipt.id).status, correct, aliasMatches, forbiddenMatches, sourceSupported, sourceRecall: question.abstain ? null : expectedSourceIds.some(id => retrieved.some(result => result.sourceId === id)),
        initialQuery: searches[0]?.query, expectedSourceIds, retrieved: retrieved.map(result => ({ ...result, original: runtime.memory.source(result.sourceId) })), tools: store.all('SELECT tool,status FROM operations WHERE run_id=?', receipt.id) });
      console.error(`${split} ${iteration + 1}: ${question.id}, ${correct ? 'strict pass' : 'strict fail'}`);
    }
    const beforeVolatile = store.get('SELECT count(*) n FROM memories').n;
    const ephemeral = runtime.newConversation('Volatile retention probe', true);
    const volatileRun = await runtime.ingest({ requestId: 'volatile-retention', conversationId: ephemeral.id, text: 'My ephemeral locker identifier is TEMP-4829. Keep this chat ephemeral.' }, { channel: 'terminal', identity: 'synthetic-owner', trustedOwner: true });
    await wait(() => !['queued', 'running'].includes(runtime.run(volatileRun.id).status));
    assert.equal(runtime.run(volatileRun.id).status, 'completed');
    assert.equal(store.get('SELECT count(*) n FROM messages WHERE conversation_id=?', ephemeral.id).n, 0);
    assert.equal(store.get('SELECT count(*) n FROM memories').n, beforeVolatile);
    run.ephemeralRetention = true;
    const forgettable = runtime.memory.list().find(fact => [...sources.values()].includes(fact.source_id));
    assert(forgettable, 'No natural memory to test forgetting');
    const assistantUsage = store.all("SELECT body FROM messages WHERE role='assistant'").map(row => JSON.parse(row.body).usage);
    run.usage = { nonAgent: models.nonAgentUsage, foreground: assistantUsage, embeddings: { ...runtime.memory.embeddings.usage }, note: 'Provider-reported tokens and estimated chat prices, not an invoice.' };
    await runtime.forget(forgettable.id);
    runtime.memory.rebuild();
    assert.equal(runtime.memory.source(forgettable.source_id), undefined);
    assert.equal(store.get('SELECT count(*) n FROM retrieval WHERE source_id=?', forgettable.source_id).n, 0);
    assert.equal(store.get('SELECT count(*) n FROM memories WHERE source_id=?', forgettable.source_id).n, 0);
    run.forgetting = true;
    assert.equal(store.get("SELECT count(*) n FROM memories WHERE status='candidate'").n, 0, 'Natural extraction must store facts without a candidate state');
    assert.equal(store.get("SELECT count(*) n FROM memories WHERE status='current'").n, 0, 'Inferred facts must not become explicit owner assertions');
    assert.equal(store.get('SELECT count(*) n FROM memory_confirmations').n, 0, 'No memory-confirmation flow exists');
    run.automaticStorageBoundary = true;
    const answerable = run.questions.filter(question => !question.abstain), unknown = run.questions.filter(question => question.abstain);
    run.summary = { extractionExpected: run.messages.flatMap(message => message.expectedFacts).length, extractionMatched: run.messages.flatMap(message => message.expectedFacts).filter(fact => fact.found).length,
      extractionFailures: run.messages.filter(message => message.review.status !== 'completed').length, storedFactCount: run.messages.flatMap(message => message.facts).length,
      sourceRecallAt10: answerable.filter(question => question.sourceRecall).length / answerable.length, strictAnswerAccuracy: answerable.filter(question => question.correct).length / answerable.length,
      strictAbstention: unknown.filter(question => question.correct).length / unknown.length, noFactSources: run.messages.filter(message => !message.expectedFacts.length).map(message => ({ id: message.id, storedFacts: message.facts.length })),
      toolFailures: run.questions.flatMap(question => question.tools).filter(tool => tool.status !== 'completed').length };
  } catch (error) {
    run.error = error instanceof Error ? error.message : 'Validation failed';
    process.exitCode = 1;
  } finally {
    report.runs.push(run);
    await runtime.close(); store.close(); await rm(root, { recursive: true, force: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
}
console.log(JSON.stringify({ ...report, runs: report.runs.map(run => ({ iteration: run.iteration, summary: run.summary, persistence: run.persistence, forgetting: run.forgetting, error: run.error })) }, null, 2));
if (report.runs.some(run => !run.summary || run.summary.extractionFailures || run.summary.sourceRecallAt10 < 0.9 || run.summary.strictAnswerAccuracy < 0.9 || run.summary.strictAbstention < 0.9)) process.exitCode = 1;
