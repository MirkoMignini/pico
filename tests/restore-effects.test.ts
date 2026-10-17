import { expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { backup, restore } from '../src/backup.js';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { setup } from './helpers.js';

it('restoring an older snapshot never dispatches stale pending deliveries, overdue schedules or queued agent occurrences', async () => {
  const s = setup();
  let restored: Store | undefined, closed = false, sends = 0, agentRuns = 0;
  try {
    const scheduler = new Scheduler(s.store, new Map([['terminal', { send: async () => ({ remoteId: String(++sends) }) }]]), async () => { agentRuns++; return 'synthetic-agent-run'; });
    const definition = { text: 'Synthetic recurring notice', timezone: 'UTC', cron: '0 9 * * *', kind: 'reminder' as const, destination: 'terminal', misfire: 'once' as const };
    const overdue = scheduler.create(definition, 'Recurring fixture');
    const future = scheduler.create({ ...definition, cron: undefined, at: '2099-08-01T09:00:00Z' }, 'Future fixture');
    const agent = scheduler.create({ ...definition, text: 'Synthetic scheduled research', kind: 'agent' }, 'Agent fixture');
    const due = Date.now() - 1000;
    s.store.run('UPDATE schedules SET next_due=? WHERE id=?', due, overdue.id);
    s.store.run("UPDATE schedules SET status='finished' WHERE id=?", agent.id);
    s.store.run("INSERT INTO occurrences(id,schedule_id,due_at,status) VALUES(?,?,?,'pending')", 'queued-agent', agent.id, due);
    for (const status of ['pending', 'paused', 'sending']) {
      scheduler.outbox(`Synthetic ${status} notice`, 'terminal', `old-${status}`);
      s.store.run('UPDATE outbox SET status=? WHERE id=?', status, `old-${status}`);
    }
    const snapshot = await backup(s.store);
    // These effects occur AFTER the snapshot. Its old pending rows cannot tell whether acceptance happened.
    await scheduler.tick();
    expect(sends).toBe(2); expect(agentRuns).toBe(1);
    await s.runtime.close(); s.store.close(); closed = true;
    await restore(s.root, snapshot.path, true);
    restored = new Store(s.root, s.config);
    const recovered = new Scheduler(restored, scheduler.deliveries, scheduler.enqueueAgent);
    recovered.recover(); await recovered.tick(); await recovered.tick();
    expect(sends, 'No stale outbox row or overdue occurrence may dispatch after restore').toBe(2);
    expect(agentRuns, 'A queued agent may already have run after the snapshot').toBe(1);
    expect(restored.all<{ status: string }>("SELECT status FROM outbox WHERE id LIKE 'old-%'").map(row => row.status)).toEqual(['uncertain', 'uncertain', 'uncertain']);
    expect(restored.get<{ status: string }>('SELECT status FROM schedules WHERE id=?', overdue.id)?.status).toBe('paused');
    expect(restored.get<{ status: string }>("SELECT status FROM occurrences WHERE id='queued-agent'")?.status).toBe('interrupted');
    expect(restored.get<{ status: string }>('SELECT status FROM schedules WHERE id=?', future.id)?.status).toBe('active');
    await recovered.tick(Date.parse('2099-08-01T09:00:00Z'));
    expect(sends, 'A genuinely future restored reminder remains deliverable').toBe(3);
    expect(restored.all('PRAGMA foreign_key_check')).toEqual([]);
  } finally {
    restored?.close();
    if (!closed) { await s.runtime.close(); s.store.close(); }
    rmSync(s.root, { recursive: true, force: true });
  }
});

it('keeps already sent and uncertain receipts unchanged while holding every unfinished occurrence for review', async () => {
  const s = setup();
  let restored: Store | undefined, closed = false;
  try {
    const job = s.runtime.scheduler.create({ text: 'Synthetic read-only task', timezone: 'UTC', cron: '0 9 * * *', kind: 'agent', destination: 'terminal', misfire: 'once' }, 'Fixture');
    for (const status of ['pending', 'leased', 'running', 'paused', 'completed', 'cancelled']) {
      s.store.run('INSERT INTO occurrences(id,schedule_id,due_at,status,lease_until) VALUES(?,?,?,?,?)', `occurrence-${status}`, job.id, Date.now(), status, Date.now() + 60_000);
    }
    for (const status of ['sent', 'uncertain', 'failed', 'cancelled']) {
      s.runtime.scheduler.outbox('Historical receipt', 'terminal', `receipt-${status}`);
      s.store.run('UPDATE outbox SET status=?,remote_id=? WHERE id=?', status, status === 'sent' ? 'original-remote-id' : null, `receipt-${status}`);
    }
    const snapshot = await backup(s.store);
    await s.runtime.close(); s.store.close(); closed = true;
    await restore(s.root, snapshot.path, true);
    restored = new Store(s.root, s.config);
    for (const status of ['pending', 'leased', 'running', 'paused']) expect(restored.get<{ status: string; lease_until: number | null }>('SELECT status,lease_until FROM occurrences WHERE id=?', `occurrence-${status}`)).toEqual({ status: 'interrupted', lease_until: null });
    for (const status of ['completed', 'cancelled']) expect(restored.get<{ status: string }>('SELECT status FROM occurrences WHERE id=?', `occurrence-${status}`)?.status).toBe(status);
    for (const status of ['sent', 'uncertain', 'failed', 'cancelled']) expect(restored.get<{ status: string }>('SELECT status FROM outbox WHERE id=?', `receipt-${status}`)?.status).toBe(status);
    expect(restored.get<{ remote_id: string }>("SELECT remote_id FROM outbox WHERE id='receipt-sent'")?.remote_id).toBe('original-remote-id');
  } finally {
    restored?.close();
    if (!closed) { await s.runtime.close(); s.store.close(); }
    rmSync(s.root, { recursive: true, force: true });
  }
});
