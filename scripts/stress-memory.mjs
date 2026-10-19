import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize } from '../dist/config.js';
import { Store, json } from '../dist/store.js';
import { Memory } from '../dist/memory.js';
import { Mem0Operation } from '../dist/mem0.js';

// Infrastructure fixture only: synthetic dense vectors, not a semantic-quality or live-provider score.
const root = await mkdtemp(join(tmpdir(), 'pikobot-memory-stress-'));
const config = initialize(root, 'Synthetic scaling owner');
const dimensions = 3072, count = 10000;
const vector = Array.from({ length: dimensions }, (_, i) => Math.sin(i + 1) / Math.sqrt(dimensions));
const encodedVector = Buffer.from(new Float32Array(vector).buffer);
const provider = { model: 'fixture-dense-3072', version: '1', dimensions, embed: async texts => texts.map(() => vector) };
let store = new Store(root, config);
try {
  store.run('INSERT INTO conversations VALUES(?,?,?,?,?,?)', 'fixture', 'Synthetic stress only', 'terminal', json(config.model), '', Date.now());
  const memory = new Memory(store, provider), started = performance.now(), base = Date.now() - count;
  store.transaction(() => {
    for (let i = 0; i < count; i++) {
      const sourceId = `synthetic-${i}`, key = `label-${i}`, text = `Synthetic ${key} has color blue.`, eventAt = base + i;
      store.run('INSERT INTO messages VALUES(?,?,NULL,?,?,?,?,?,?)', sourceId, 'fixture', `human:${config.ownerId}`, 'user', text, json({ role: 'user', content: text, timestamp: eventAt }), eventAt, Date.now());
      store.index({ id: sourceId, kind: 'message', text, sourceId, eventAt });
      const record = memory.remember({ entity: `owner:${config.ownerId}`, kind: 'fact', key, value: 'blue', sourceId, eventAt, quote: text }, false);
      const row = store.get('SELECT * FROM retrieval WHERE id=?', record.id);
      store.run('INSERT INTO mem0_vectors VALUES(?,?,?,?,?,?,?,?)', record.id, record.id, 'memories', provider.model, dimensions, provider.version, encodedVector, json(new Mem0Operation(store, provider).payload(row)));
    }
  });
  const seedMs = performance.now() - started;
  store.close(); store = new Store(root, config);
  const search = new Memory(store, provider), queryStarted = performance.now();
  const results = await search.search('label-9997', { entity: `owner:${config.ownerId}`, limit: 10 });
  assert.equal(results[0]?.sourceId, 'synthetic-9997');
  assert.equal(results.length, 10); assert.equal(store.get("SELECT count(*) n FROM memories WHERE status='current'").n, 0);
  console.log(JSON.stringify({ evidence: 'Synthetic-vector infrastructure fixture, no provider calls', node: process.version, dimensions, indexedFacts: count, retrievalDepth: 10,
    seedMs, queryMs: performance.now() - queryStarted, rssMiB: process.memoryUsage().rss / 2 ** 20, maxRssMiB: process.resourceUsage().maxRSS / 1024, heapMiB: process.memoryUsage().heapUsed / 2 ** 20,
    firstSource: results[0].sourceId, integrity: store.get('PRAGMA quick_check'), constraints: store.all('PRAGMA foreign_key_check') }, null, 2));
} finally { store.close(); await rm(root, { recursive: true, force: true }); }
