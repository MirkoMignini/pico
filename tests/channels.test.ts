import { afterEach, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { join } from 'node:path';
import { atomicWrite } from '../src/config.js';
import { Client } from '../src/client.js';
import { serve } from '../src/daemon.js';
import { Runtime } from '../src/runtime.js';
import { Telegram } from '../src/features/telegram-channel.js';
import type { NotificationDelivery, OutputEvent, PikobotChannel } from '../src/contracts.js';
import { reply, setup, waitFor } from './helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function instance() {
  const s = setup();
  cleanup.push(async () => { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); });
  return s;
}
function adapter(id: string, destinations = [id]) {
  const sent: { text: string; id: string }[] = [], events: OutputEvent[] = [];
  const delivery: NotificationDelivery = { send: async (text, id) => { sent.push({ text, id }); return { remoteId: id }; } };
  const channel = { id, deliveries: new Map(destinations.map(destination => [destination, delivery])),
    start: vi.fn(), close: vi.fn(), onOutput: vi.fn((event: OutputEvent) => { events.push(event); }) } satisfies PikobotChannel;
  return { channel, sent, events };
}

it('routes normalized input and output for new channels without exposing other channel conversations', async () => {
  const s = instance(), whatsapp = adapter('whatsapp'), slack = adapter('slack');
  s.runtime.channels.register(whatsapp.channel); s.runtime.channels.register(slack.channel);
  const conversation = s.runtime.newConversation('WhatsApp', false, 'whatsapp');
  reply(s.faux, 'Private WhatsApp response');
  const attachment = s.runtime.media.save(Buffer.from('Platform document 617'), 'document.txt', 'text/plain', conversation.id);
  const input = { requestId: 'platform-message-1', conversationId: conversation.id, text: 'Forwarded WhatsApp evidence', attachments: [attachment] };
  const sender = { identity: '+391234', trustedOwner: false };
  const first = await s.runtime.channels.ingest('whatsapp', input, sender);
  const duplicate = await s.runtime.channels.ingest('whatsapp', input, sender);
  expect(duplicate.id).toBe(first.id);
  await expect(s.runtime.channels.ingest('whatsapp', { ...input, text: 'Changed' }, sender)).rejects.toThrow('changed');
  await waitFor(() => s.runtime.run(first.id).status === 'completed');
  expect(whatsapp.events.map(event => event.type)).toContain('settled');
  expect(slack.events).toEqual([]);
  expect(s.store.get<{ actor: string }>("SELECT actor FROM messages WHERE role='user'")?.actor).toBe('external:whatsapp:+391234');
  expect(s.store.all('SELECT * FROM reviews')).toEqual([]);
  expect(s.store.get<{ source_id: string }>('SELECT source_id FROM attachments WHERE id=?', attachment)?.source_id).toBeTruthy();
  expect(s.store.all('SELECT * FROM media_derivatives')).toHaveLength(1);
  expect(s.faux.state.callCount).toBe(1);
  await expect(s.runtime.channels.ingest('unregistered', input, sender)).rejects.toThrow('not registered');
});

it('namespaces arbitrary platform identities and request IDs, retaining old durable receipts', async () => {
  const s = instance(); s.runtime.channels.register(adapter('slack').channel);
  const conversation = s.runtime.newConversation('Slack', true, 'slack');
  reply(s.faux, 'First'); reply(s.faux, 'Second');
  const first = await s.runtime.channels.ingest('slack', { requestId: 'message', conversationId: conversation.id, text: 'one' }, { identity: 'workspace:user', trustedOwner: true });
  const second = await s.runtime.channels.ingest('slack', { requestId: 'user:message', conversationId: conversation.id, text: 'two' }, { identity: 'workspace', trustedOwner: true });
  expect(first.id).not.toBe(second.id);
  expect(s.runtime.receipt('message', { channel: 'slack', identity: 'workspace:user', trustedOwner: true })?.id).toBe(first.id);
  await waitFor(() => s.runtime.run(second.id).status === 'completed');
  expect(s.store.all('SELECT * FROM runs')).toEqual([]);
  const retained = s.runtime.newConversation(); reply(s.faux, 'Legacy');
  const source = { channel: 'terminal', identity: 'owner-ipc', trustedOwner: true };
  const legacy = await s.runtime.channels.ingest('terminal', { requestId: 'legacy', conversationId: retained.id, text: 'same body' }, source);
  await waitFor(() => s.runtime.run(legacy.id).status === 'completed');
  s.store.run('UPDATE runs SET request_id=? WHERE id=?', 'terminal:owner-ipc:legacy', legacy.id);
  expect(s.runtime.receipt('legacy', source)?.id).toBe(legacy.id);
  const duplicate = await s.runtime.channels.ingest('terminal', { requestId: 'legacy', conversationId: retained.id, text: 'same body' }, source);
  expect(duplicate.id).toBe(legacy.id);
  expect(s.faux.state.callCount).toBe(3);
});

it('accepts learned procedures scoped to newly registered channels without new permission grants', async () => {
  const s = instance(); s.runtime.channels.register(adapter('slack').channel);
  s.faux.appendResponses([
    fauxAssistantMessage([fauxToolCall('time', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('Demonstrated Slack procedure')]),
    fauxAssistantMessage([fauxText(JSON.stringify([{ name: 'Check time', scope: 'slack', instructions: 'Read the current time before reporting it.' }]))])
  ]);
  const run = await s.runtime.channels.ingest('slack', { requestId: 'learn', conversationId: s.runtime.newConversation('Slack', false, 'slack').id, text: 'Demonstrate a time check' }, { identity: 'owner', trustedOwner: true });
  await waitFor(() => s.runtime.run(run.id).status === 'completed');
  await s.runtime.extensions.background({ signal: AbortSignal.timeout(20_000), modelWorkAllowed: true, phase: 1 });
  expect(s.store.get<{ scope: string }>("SELECT scope FROM skills WHERE status='candidate'")?.scope).toBe('slack');
  expect(s.store.all('SELECT * FROM grants')).toEqual([]);
});

it('accepts only registered owner destinations for reminders and delivers through any adapter', async () => {
  const s = instance(), slack = adapter('slack', ['slack', 'slack:workspace:chat:thread']);
  s.runtime.channels.register(slack.channel);
  expect(s.runtime.scheduler.defaultDestination).toBe('slack');
  const definition = { text: 'Generic reminder', timezone: 'UTC', at: new Date(Date.now() + 60_000).toISOString(), kind: 'reminder', destination: 'slack:workspace:chat:thread', misfire: 'once' };
  expect(() => s.runtime.scheduler.create({ ...definition, destination: 'slack:stranger' }, 'unowned')).toThrow('not owner-configured');
  expect(() => s.runtime.scheduler.outbox('leak', 'telegram')).toThrow('not owner-configured');
  const schedule = s.runtime.scheduler.create(definition, 'owner instruction');
  s.store.run('UPDATE schedules SET next_due=1 WHERE id=?', schedule.id);
  await s.runtime.scheduler.tick(); await s.runtime.scheduler.tick();
  expect(slack.sent).toEqual([{ text: definition.text, id: `reminder:${schedule.id}:1` }]);
  expect(s.store.get<{ status: string }>('SELECT status FROM outbox')?.status).toBe('sent');
});

it('leaves unavailable channel schedules pending without blocking terminal reminders or cancellation', async () => {
  const s = instance(), slack = adapter('slack'); s.runtime.channels.register(slack.channel);
  const definition = { text: 'Waiting for Slack', timezone: 'UTC', at: new Date(Date.now() + 60_000).toISOString(), kind: 'reminder', destination: 'slack', misfire: 'once' };
  const offline = Array.from({ length: 20 }, () => s.runtime.scheduler.create(definition, 'owner'));
  const terminal = s.runtime.scheduler.create({ ...definition, text: 'Terminal still works', destination: 'terminal' }, 'owner');
  for (let i = 0; i < 5; i++) s.runtime.scheduler.outbox('Offline backlog', 'slack', `offline:${i}`);
  s.runtime.scheduler.outbox('Terminal delivery', 'terminal', 'terminal-backlog');
  s.store.run('UPDATE schedules SET next_due=1'); s.runtime.scheduler.deliveries.delete('slack');
  await s.runtime.scheduler.tick();
  expect(s.store.get<{ status: string }>('SELECT status FROM schedules WHERE id=?', offline[0]!.id)?.status).toBe('active');
  expect(s.store.get<{ status: string }>('SELECT status FROM schedules WHERE id=?', terminal.id)?.status).toBe('finished');
  expect(s.store.all("SELECT * FROM outbox WHERE destination='terminal' AND status='sent'")).toHaveLength(2);
  expect(s.store.all("SELECT * FROM outbox WHERE destination='slack' AND status='pending'")).toHaveLength(5);
  expect(slack.sent).toEqual([]);
  s.runtime.scheduler.manage(offline[0]!.id, 'pause');
  expect(() => s.runtime.scheduler.manage(offline[0]!.id, 'resume')).toThrow('not owner-configured');
  s.runtime.scheduler.manage(offline[0]!.id, 'cancel');
});

it('validates registration atomically and owns idempotent lifecycle and listener cleanup', async () => {
  const s = instance(), slack = adapter('slack');
  s.runtime.channels.register(slack.channel);
  expect(() => s.runtime.channels.register(adapter('slack').channel)).toThrow('already registered');
  expect(() => s.runtime.channels.register(adapter('schedule').channel)).toThrow('Reserved');
  expect(() => s.runtime.channels.register(adapter('bad:id').channel)).toThrow('Invalid input');
  expect(() => s.runtime.channels.register(adapter('whatsapp', ['whatsapp', 'slack:stranger']).channel)).toThrow('belong');
  expect(s.runtime.scheduler.deliveries.has('whatsapp')).toBe(false);
  await s.runtime.channels.start(); await s.runtime.channels.start();
  expect(slack.channel.start).toHaveBeenCalledTimes(1);
  expect(() => s.runtime.channels.register(adapter('whatsapp').channel)).toThrow('before starting');
  await s.runtime.channels.close(); await s.runtime.channels.close();
  expect(slack.channel.close).toHaveBeenCalledTimes(1);
  expect(s.runtime.scheduler.deliveries.size).toBe(0);
  expect(s.runtime.channels.list()).toEqual([]);
  s.runtime.emit({ type: 'status', data: {} }); expect(slack.events).toEqual([]);
});

it('attempts every adapter shutdown even when one fails', async () => {
  const s = setup(), broken = adapter('slack'), other = adapter('whatsapp');
  broken.channel.close.mockImplementation(() => { throw new Error('Transport shutdown failed'); });
  s.runtime.channels.register(broken.channel); s.runtime.channels.register(other.channel);
  try {
    await expect(s.runtime.close()).rejects.toThrow('Runtime shutdown failed');
    expect(broken.channel.close).toHaveBeenCalledTimes(1);
    expect(other.channel.close).toHaveBeenCalledTimes(1);
    expect(s.runtime.events.listenerCount('output')).toBe(0);
    expect(s.runtime.scheduler.deliveries.size).toBe(0);
  } finally { s.store.close(); rmSync(s.root, { recursive: true, force: true }); }
});

it('isolates synchronous and asynchronous output failures without leaking errors or diagnostic loops', async () => {
  const s = instance(), bad = adapter('slack'), other = adapter('whatsapp'), diagnostics: OutputEvent[] = [];
  bad.channel.onOutput.mockImplementation(() => { throw new Error('secret synchronous error'); });
  other.channel.onOutput.mockImplementation(async () => { throw new Error('secret asynchronous error'); });
  s.runtime.channels.register(bad.channel); s.runtime.channels.register(other.channel);
  s.runtime.events.on('output', event => { if (event.type === 'diagnostic') diagnostics.push(event); });
  s.runtime.emit({ type: 'status', data: {} });
  await waitFor(() => diagnostics.length === 2);
  expect(JSON.stringify(diagnostics)).not.toContain('secret');
  expect(diagnostics.map(event => (event.data as { component: string }).component).sort()).toEqual(['slack', 'whatsapp']);
});

it('starts injected daemon adapters, exposes discovery, and releases authority on startup failure', async () => {
  const s = instance(); atomicWrite(join(s.root, 'config.json'), JSON.stringify(s.config));
  const broken = adapter('whatsapp'); broken.channel.start.mockImplementation(() => { throw new Error('Transport failed'); });
  await expect(serve(s.root, { runtimeFactory: store => new Runtime(store, s.runtime.models), channels: () => [broken.channel] })).rejects.toThrow('Transport failed');
  expect(broken.channel.close).toHaveBeenCalledTimes(1);
  const slack = adapter('slack');
  const service = await serve(s.root, { runtimeFactory: store => new Runtime(store, s.runtime.models), channels: () => [slack.channel] });
  try {
    expect(slack.channel.start).toHaveBeenCalledTimes(1);
    const client = new Client(s.root);
    expect(await client.rpc('channels.list')).toEqual([{ id: 'terminal', destinations: ['terminal'] }, { id: 'slack', destinations: ['slack'] }]);
  } finally { await service.close(); }
  expect(slack.channel.close).toHaveBeenCalledTimes(1);
});

it('Telegram uses the shared registry while keeping sender-specific durable replies', async () => {
  const s = instance(); s.config.telegram = { allowedSenders: [123, 456], destination: 123 };
  const telegram = s.runtime.channels.register(new Telegram(s.runtime, '123456:fixture-only'));
  const sent: { chat: number; text: string }[] = [];
  telegram.bot.api.sendMessage = vi.fn(async (chat, text) => { sent.push({ chat: Number(chat), text }); return { message_id: 1 }; }) as any;
  telegram.bot.api.sendMessageDraft = vi.fn(async () => true) as any;
  telegram.bot.api.sendChatAction = vi.fn(async () => true) as any;
  telegram.bot.api.editMessageText = vi.fn(async () => true) as any;
  telegram.bot.api.deleteMessage = vi.fn(async () => true) as any;
  telegram.bot.api.setMessageReaction = vi.fn(async () => true) as any;
  reply(s.faux, 'Sender-specific answer');
  await telegram.accept({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false, first_name: 'owner' }, text: 'Hi' } });
  await waitFor(() => !!s.store.get("SELECT id FROM runs WHERE status='completed'"));
  expect(s.store.get<{ status: string }>('SELECT status FROM telegram_updates')?.status).toBe('processed');
  expect(s.store.get<{ destination: string }>("SELECT destination FROM outbox WHERE id LIKE 'reply:%'")?.destination).toBe('telegram:456');
  await s.runtime.scheduler.tick();
  expect(sent).toContainEqual({ chat: 456, text: 'Sender-specific answer' });
  expect(sent.every(message => message.chat === 456)).toBe(true);
  expect(telegram.bot.api.setMessageReaction).not.toHaveBeenCalled();
});
