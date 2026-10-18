import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCapabilities, getOsc8LinkAtColumn, setCapabilities, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Client } from '../src/client.js';
import { serve } from '../src/daemon.js';
import { atomicWrite, loadConfig } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { Telegram } from '../src/features/telegram-channel.js';
import { GmailLogin } from '../src/features/google/mail.js';
import { defaultSettings, googleScopes } from '../src/features/google/settings.js';
import { ChatUI, COMMANDS, HELP, safeTerminal } from '../src/tui.js';
import { setup, waitFor, reply, loadTools } from './helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
class Screen implements Terminal {
  columns = 100; rows = 35; kittyProtocolActive = false; output = ''; stopped = false;
  input!: (data: string) => void; resize!: () => void;
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() { this.stopped = true; } async drainInput() {} write(data: string) { this.output += data; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
async function connected(extensionSources: Record<string, string> = {}) {
  const s = setup(); atomicWrite(join(s.root, 'config.json'), JSON.stringify(s.config));
  mkdirSync(join(s.root, 'extensions'), { recursive: true });
  for (const [name, source] of Object.entries(extensionSources)) writeFileSync(join(s.root, 'extensions', `${name}.ts`), source);
  cleanup.push(async () => { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); });
  // Exercise actual adapter registration without contacting Telegram with fixture credentials.
  vi.spyOn(Telegram.prototype, 'start').mockImplementation(() => {});
  const service = await serve(s.root, { runtimeFactory: store => new Runtime(store, s.runtime.models) }); cleanup.push(service.close);
  const client = new Client(s.root), screen = new Screen(), ui = new ChatUI(client, screen); cleanup.push(async () => ui.close());
  await ui.start(); await waitFor(() => screen.output.includes('PICO'));
  const see = (text: string) => waitFor(() => screen.output.includes(text));
  const replace = (text: string) => { screen.input('\x05'); screen.input('\x15'); screen.input(`\x1b[200~${text}\x1b[201~`); };
  return { ...s, service, client, screen, ui, see, replace };
}
async function selectLegacyEphemeral(s: Awaited<ReturnType<typeof connected>>) {
  const session = s.service.runtime.newConversation('Legacy ephemeral fixture', true);
  await s.ui.submit(`/sessions ${session.id}`);
}

it.each([false, true])('cycles sent messages with Up/Down and restores the draft without replay (ephemeral=%s)', async ephemeral => {
  const s = await connected(); if (ephemeral) await selectLegacyEphemeral(s);
  const first = 'First message 漢字', latest = 'Latest message 👋';
  for (const text of [first, latest, latest]) {
    reply(s.faux, 'Done'); await s.ui.submit(text); await waitFor(() => !s.ui.editor.disableSubmit);
  }
  const calls = vi.spyOn(s.client, 'rpc');
  for (const [key, expected] of [['\x1b[A',latest],['\x1b[A',first],['\x1b[A',first],['\x1b[B',latest],['\x1b[B',''],['\x1b[B','']] as const) {
    s.screen.input(key); expect(s.ui.editor.getText()).toBe(expected);
  }
  const draft = 'Unsent draft 👋'; s.ui.editor.setText(draft); s.screen.input('\x01');
  const cursor = s.ui.editor.getCursor();
  s.screen.input('\x1b[A'); expect(s.ui.editor.getText()).toBe(latest);
  expect(s.ui.canRefresh).toBe(false);
  s.screen.input('\x1b[B'); expect(s.ui.editor.getText()).toBe(draft); expect(s.ui.editor.getCursor()).toEqual(cursor);
  s.screen.input('\x1b[A'); s.screen.input('Edited '); expect(s.ui.editor.getText()).toBe(`Edited ${latest}`);
  expect(calls).not.toHaveBeenCalled(); expect(s.faux.state.callCount).toBe(3);
  expect(HELP).toContain('↑/↓');
  if (ephemeral) expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]);
});

it('recalls actual keyboard submissions with expanded multiline pastes and preserves cursor navigation', async () => {
  const s = await connected(), message = Array.from({length:16},(_,i) => `Pasted line ${i} 漢字 👋`).join('\n');
  const history = vi.spyOn(s.ui.editor, 'addToHistory');
  reply(s.faux, 'Done'); s.replace(message); s.screen.input('\r');
  await waitFor(() => history.mock.calls.length === 1); await waitFor(() => !s.ui.editor.disableSubmit);
  expect(history).toHaveBeenCalledWith(message);
  s.screen.input('\x1b[A'); expect(s.ui.editor.getExpandedText()).toBe(message);
  expect(s.ui.editor.getText()).not.toContain('[paste #');
  s.screen.input('\x1b[B'); expect(s.ui.editor.getCursor().line).toBe(1); expect(s.ui.editor.getText()).toBe(message);
  for (let i=1;i<16;i++) s.screen.input('\x1b[B');
  expect(s.ui.editor.getText()).toBe(''); expect(s.faux.state.callCount).toBe(1);
});

it('animates a pinned working indicator while keeping the draft editable and Enter blocked until completion', async () => {
  const s = await connected(), stream = createAssistantMessageEventStream();
  vi.spyOn(s.service.runtime.models.models, 'streamSimple').mockResolvedValue(stream);
  const calls = vi.spyOn(s.client, 'rpc');
  const frame = () => { s.ui.tui.renderNow(true); return s.ui.tui.getScreenLines().map(safeTerminal).join('\n'); };
  expect(frame()).not.toContain('Working…');
  await s.ui.submit('Wait silently before answering');
  expect(frame()).toContain('Working…'); expect(frame()).toContain('sending paused');
  const indicator = () => frame().split('\n').find(line => line.includes('Working…'))!;
  const first = indicator(); await waitFor(() => indicator() !== first);
  const loader = (s.ui as any).loader, stop = vi.spyOn(loader, 'stop');
  const draft = 'Next question 漢字 👋\nStill a draft'; s.replace(draft); s.screen.input('!');
  const cursor = s.ui.editor.getCursor();
  for (const columns of [42, 100]) {
    s.screen.columns = columns; s.screen.resize();
    expect(frame()).toContain('Working…'); expect(frame()).toContain('Still a draft!');
    expect(s.ui.tui.getScreenLines().every(line => visibleWidth(line) <= columns)).toBe(true);
    s.screen.input('\r');
    expect(s.ui.editor.getText()).toBe(`${draft}!`); expect(s.ui.editor.getCursor()).toEqual(cursor);
    expect(s.ui.editor.focused).toBe(true); expect(s.ui.editor.disableSubmit).toBe(true);
  }
  expect(calls.mock.calls.filter(([op]) => op === 'input')).toHaveLength(1);
  expect(s.ui.transcript.render(100).map(safeTerminal).join('\n')).not.toContain('Working…');
  stream.push({ type: 'done', reason: 'stop', message: fauxAssistantMessage([fauxText('Done waiting.')]) });
  await waitFor(() => !s.ui.editor.disableSubmit);
  expect(frame()).not.toContain('Working…'); expect(stop).toHaveBeenCalledOnce();
  expect(s.ui.editor.getText()).toBe(`${draft}!`); expect(s.ui.editor.getCursor()).toEqual(cursor);
  expect(calls.mock.calls.filter(([op]) => op === 'input')).toHaveLength(1);
  s.replace('/help'); s.screen.input('\r'); await s.see('Enter sends'); expect(s.ui.editor.getText()).toBe('');
});

it.each([false, true])('shows work and blocks duplicate sends throughout delayed admission/receipt recovery (lost acknowledgment=%s)', async lost => {
  const s = await connected(), rpc = s.client.rpc.bind(s.client), stream = createAssistantMessageEventStream();
  vi.spyOn(s.service.runtime.models.models, 'streamSimple').mockResolvedValue(stream);
  let admit!: () => void, recover!: () => void;
  const admission = new Promise<void>(resolve => { admit = resolve; }), receipt = new Promise<void>(resolve => { recover = resolve; });
  const calls = vi.spyOn(s.client, 'rpc').mockImplementation(async (op, args) => {
    if (op === 'input') { await admission; const run = await rpc(op, args); if (lost) throw new Error('Fixture lost acknowledgment'); return run; }
    if (op === 'input.receipt') await receipt;
    return rpc(op, args);
  });
  const working = () => { s.ui.tui.renderNow(true); return s.ui.tui.getScreenLines().map(safeTerminal).join('\n').includes('Working…'); };
  const pending = s.ui.submit('Synthetic delayed admission');
  try {
    expect(working()).toBe(true); expect(s.ui.canRefresh).toBe(false);
    s.replace('Draft during admission'); s.screen.input('\r'); expect(s.ui.editor.getText()).toBe('Draft during admission');
    await expect(s.ui.submit('Duplicate input')).rejects.toThrow('A turn is active');
    admit();
    if (lost) {
      await waitFor(() => calls.mock.calls.some(([op]) => op === 'input.receipt'));
      expect(working()).toBe(true); expect(s.ui.editor.disableSubmit).toBe(true);
      s.screen.input('\r'); expect(s.ui.editor.getText()).toBe('Draft during admission');
    }
    recover(); await pending;
    expect(calls.mock.calls.filter(([op]) => op === 'input')).toHaveLength(1);
    stream.push({ type: 'done', reason: 'stop', message: fauxAssistantMessage([fauxText('Admitted once.')]) });
    await waitFor(() => !s.ui.editor.disableSubmit); expect(working()).toBe(false);
    expect(s.ui.editor.getText()).toBe('Draft during admission');
  } finally { admit(); recover(); await pending; }
});

it('restores the working indicator on attachment, session switching and reconnect without replay', async () => {
  const s = await connected(), stream = createAssistantMessageEventStream(), conversationId = (s.ui as any).session.id;
  const model = vi.spyOn(s.service.runtime.models.models, 'streamSimple').mockResolvedValue(stream);
  await s.ui.submit('Synthetic restored work');
  const screen = new Screen(), ui = new ChatUI(new Client(s.root), screen); cleanup.push(async () => ui.close());
  const working = () => { ui.tui.renderNow(true); return ui.tui.getScreenLines().map(safeTerminal).join('\n').includes('Working…'); };
  await ui.start(); expect(working()).toBe(true); expect(ui.editor.disableSubmit).toBe(true);
  await ui.submit('/new'); expect(working()).toBe(false);
  await ui.submit(`/sessions ${conversationId}`); expect(working()).toBe(true);
  ui.editor.setText('Preserved reconnect draft'); await (ui as any).reconnect();
  expect(working()).toBe(true); expect(ui.editor.getText()).toBe('Preserved reconnect draft');
  stream.push({ type: 'done', reason: 'stop', message: fauxAssistantMessage([fauxText('Restored work finished.')]) });
  await waitFor(() => !ui.editor.disableSubmit && !s.ui.editor.disableSubmit);
  expect(working()).toBe(false); expect(model).toHaveBeenCalledOnce();
});

it.each(['completed', 'cancelled', 'failed', 'detach'])('cleans up the working indicator on %s and ignores other conversations', async status => {
  const s = await connected(), conversationId = (s.ui as any).session.id;
  const working = () => { s.ui.tui.renderNow(true); return s.ui.tui.getScreenLines().map(safeTerminal).join('\n').includes('Working…'); };
  s.ui.onOutput({ type: 'accepted', conversationId: 'another-conversation', runId: 'unrelated', data: {} });
  expect(working()).toBe(false);
  s.ui.onOutput({ type: 'accepted', conversationId, runId: 'fixture-working', data: {} });
  expect(working()).toBe(true); expect(s.ui.editor.disableSubmit).toBe(true);
  const stop = vi.spyOn((s.ui as any).loader, 'stop'); s.replace('Preserve this draft');
  if (status === 'detach') s.ui.close();
  else {
    s.ui.onOutput({ type: 'settled', conversationId, runId: 'fixture-working', data: { status, text: '', error: status === 'completed' ? undefined : 'Synthetic interruption' } });
    expect(working()).toBe(false); expect(s.ui.editor.disableSubmit).toBe(false);
  }
  expect(stop).toHaveBeenCalledOnce(); expect(s.ui.editor.getText()).toBe('Preserve this draft');
  expect(s.faux.state.callCount).toBe(0);
});

it('records recovered input acknowledgments once without resubmitting them', async () => {
  const s = await connected(), rpc = s.client.rpc.bind(s.client), text = 'Accepted despite lost acknowledgment';
  const history = vi.spyOn(s.ui.editor, 'addToHistory');
  const calls = vi.spyOn(s.client, 'rpc').mockImplementation(async (op,args) => {
    const result = await rpc(op,args);
    if (op === 'input') throw new Error('Fixture acknowledgment lost');
    return result;
  });
  reply(s.faux, 'Done'); await s.ui.submit(text); await waitFor(() => !s.ui.editor.disableSubmit);
  expect(calls.mock.calls.filter(([op]) => op === 'input')).toHaveLength(1);
  expect(calls.mock.calls.filter(([op]) => op === 'input.receipt')).toHaveLength(1);
  expect(history).toHaveBeenCalledExactlyOnceWith(text);
  s.screen.input('\x1b[A'); expect(s.ui.editor.getText()).toBe(text);
  expect(s.faux.state.callCount).toBe(1);
});

it('keeps rejected input, commands and masked credentials out of message recall', async () => {
  const s = await connected(), history = vi.spyOn(s.ui.editor, 'addToHistory'), rpc = s.client.rpc.bind(s.client);
  const calls = vi.spyOn(s.client, 'rpc').mockImplementation((op,args) => op === 'input' ? Promise.reject(new Error('Fixture input rejected')) : op === 'input.receipt' ? Promise.resolve(null) : rpc(op,args));
  await expect(s.ui.submit('Rejected input')).rejects.toThrow('Fixture input rejected'); calls.mockRestore();
  s.ui.tui.renderNow(true); expect(s.ui.tui.getScreenLines().map(safeTerminal).join('\n')).not.toContain('Working…');
  expect(s.ui.editor.disableSubmit).toBe(false); expect(s.ui.canRefresh).toBe(true);
  await s.ui.submit('/help');
  await expect(s.ui.submit('/auth key deepseek inline-sensitive-key')).rejects.toThrow('Never put credentials');
  const work = s.ui.submit('/auth secret brave.searchKey'); await s.see('brave.searchKey — masked');
  s.replace('fixture-masked-search-secret'); s.screen.input('\r'); await work;
  expect(history).not.toHaveBeenCalled(); s.screen.input('\x1b[A'); expect(s.ui.editor.getText()).toBe('');
  expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]); expect(s.faux.state.callCount).toBe(0);
});

it('allows development refresh only without drafts, dialogs or active turns', async () => {
  const s = await connected(); expect(s.ui.canRefresh).toBe(true);
  s.ui.editor.setText(' '); expect(s.ui.canRefresh).toBe(false);
  s.ui.editor.setText(''); expect(s.ui.canRefresh).toBe(true);
  const dialog = s.ui.submit('/auth key deepseek'); await s.see('Enter DeepSeek API key');
  expect(s.ui.canRefresh).toBe(false); s.screen.input('\x1b'); await dialog;
  expect(s.ui.canRefresh).toBe(true);
  reply(s.faux, 'Working '.repeat(1000)); await s.ui.submit('Synthetic refresh test');
  expect(s.ui.canRefresh).toBe(false); s.screen.input('\x1b');
  await waitFor(() => s.ui.canRefresh); s.ui.close(); expect(s.ui.canRefresh).toBe(false);
});

it('shows a responsive Pico startup logo and useful info without archiving it or crowding later turns', async () => {
  const s = await connected(); s.ui.tui.renderNow(true);
  const frame = () => s.ui.tui.getScreenLines().map(safeTerminal).join('\n');
  expect(frame()).toContain('____  ___  ____  ___');
  expect(frame()).toContain('A small assistant for the things that matter.');
  expect(frame()).toContain('owner owner'); expect(frame()).toContain(`${s.config.model.provider}/${s.config.model.id}`);
  expect(frame()).toContain('Retained session'); expect(frame()).toContain('/setup'); expect(frame()).toContain('/model');
  expect(s.ui.editor.focused).toBe(true); expect(s.faux.state.callCount).toBe(0);
  s.screen.columns = 42; s.screen.rows = 15; s.screen.resize(); s.ui.tui.renderNow(true);
  expect(frame()).not.toContain('____  ___  ____  ___'); expect(frame()).toContain('PICO');
  expect(s.ui.tui.getScreenLines().every(line => visibleWidth(line) <= 42)).toBe(true);
  s.screen.columns = 100; s.screen.rows = 35; s.screen.resize(); s.ui.tui.renderNow(true);
  expect(frame()).toContain('____  ___  ____  ___');
  await s.ui.submit('/help'); s.ui.tui.renderNow(true);
  expect(frame()).not.toContain('____  ___  ____  ___'); expect(frame()).toContain('PICO');
  await s.ui.submit('/new'); s.ui.tui.renderNow(true);
  expect(frame()).not.toContain('____  ___  ____  ___');
  expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]);
  expect(s.service.runtime.store.all('SELECT * FROM runs')).toEqual([]);
});

it('keeps the in-process extension trust warning visible after the intro collapses', async () => {
  const s = await connected(); s.ui.tui.renderNow(true);
  const frame = () => s.ui.tui.getScreenLines().map(safeTerminal).join('\n');
  expect(frame()).toContain('TRUSTED EXTENSIONS'); expect(frame()).toContain('full OS-user access');
  await s.ui.submit('/help'); s.ui.tui.renderNow(true);
  expect(frame()).not.toContain('____  ___  ____  ___'); expect(frame()).toContain('TRUSTED EXTENSIONS');
  expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]);
});

it('keeps idle Escape and control keys from exiting, and closes only with /quit', async () => {
  const s = await connected();
  s.ui.editor.setText('draft'); s.screen.input('\x1b');
  expect(s.ui.editor.getText()).toBe('draft'); expect(s.screen.stopped).toBe(false);
  s.screen.input('\x03'); expect(s.screen.stopped).toBe(false);
  s.ui.editor.setText('draft'); s.screen.input('\x01'); s.screen.input('\x04');
  expect(s.ui.editor.getText()).toBe('raft'); expect(s.screen.stopped).toBe(false);
  s.ui.editor.setText(''); s.screen.input('\x04'); s.screen.input('\x03'); s.screen.input('\x03');
  expect(s.screen.stopped).toBe(false);
  s.screen.input('/'); await waitFor(() => s.ui.editor.isShowingAutocomplete()); s.screen.input('\x1b');
  expect(s.ui.editor.isShowingAutocomplete()).toBe(false); expect(s.screen.stopped).toBe(false);
  s.replace('/quit'); s.screen.input('\r'); await waitFor(() => s.screen.stopped);
  expect(await s.client.rpc('status')).toMatchObject({ instanceId: s.config.instanceId });
  expect(HELP).toContain('/quit exits'); expect(HELP).not.toContain('Ctrl+D exits');
});

it('offers only normal saved chats and rejects /new arguments without RPC or inference', async () => {
  const s = await connected(), calls = vi.spyOn(s.client, 'rpc');
  expect(HELP).not.toMatch(/ephemeral/i);
  for (const legacy of [false, true]) {
    if (legacy) await selectLegacyEphemeral(s);
    const previous = (s.ui as any).session.id;
    calls.mockClear();
    for (const command of ['/new ephemeral','/new private','/new ephemeral extra']) await expect(s.ui.submit(command)).rejects.toThrow('Use /new without arguments');
    expect(calls).not.toHaveBeenCalled(); expect((s.ui as any).session.id).toBe(previous);
    await s.ui.submit('/new');
    expect(calls).toHaveBeenCalledWith('new');
    expect((s.ui as any).session).toMatchObject({ ephemeral: false });
    expect((s.ui as any).session.id).not.toBe(previous);
    expect(s.service.runtime.sessions().some(session => session.id === previous)).toBe(true);
  }
  expect(s.faux.state.callCount).toBe(0);
});

it('removes manual memory commands from help/completion and rejects them without RPC in either session mode', async () => {
  const s = await connected(), calls = vi.spyOn(s.client, 'rpc');
  expect(COMMANDS).not.toContain('remember'); expect(COMMANDS).not.toContain('forget'); expect(COMMANDS).not.toContain('confirm');
  expect(HELP).not.toContain('/remember'); expect(HELP).not.toContain('/forget'); expect(HELP).not.toContain('/confirm'); expect(HELP).not.toContain('candidates');
  for (const ephemeral of [false, true]) {
    if (ephemeral) await selectLegacyEphemeral(s);
    calls.mockClear();
    for (const text of ['/remember', '/remember name = synthetic', '/forget', '/forget memory-id', '/confirm', '/confirm memory-id']) {
      await expect(s.ui.submit(text)).rejects.toThrow('Unknown command');
    }
    expect(calls).not.toHaveBeenCalled();
  }
  expect(s.faux.state.callCount).toBe(0);
  expect(s.service.runtime.store.all('SELECT * FROM memories')).toEqual([]);
});

it('keeps only basic and safety/admin commands and rejects feature shortcuts without RPC or inference', async () => {
  const s = await connected(), calls = vi.spyOn(s.client, 'rpc');
  expect(COMMANDS).toEqual(['new','sessions','model','thinking','extensions','stop','help','auth','approve','skills','notifications','channels','telegram','setup','settings','reload','integrations','mcp','mail','backup','export','login','logout','quit']);
  const removed = ['status','knowledge','memory','prefer','correct','learn','workflows','agenda','reminders','web','images','approve-action'];
  for (const name of removed) { expect(COMMANDS).not.toContain(name); expect(HELP).not.toContain(`/${name}`); }
  expect(HELP).toContain('Talk to Pico'); expect(HELP).toContain('new extension builds need no confirmation'); expect(HELP).toContain('run immediately with full OS access');
  for (const ephemeral of [false, true]) {
    if (ephemeral) await selectLegacyEphemeral(s);
    calls.mockClear();
    for (const name of removed) for (const suffix of ['', ' synthetic argument']) {
      await expect(s.ui.submit(`/${name}${suffix}`)).rejects.toThrow('ask Pico in chat');
    }
    await expect(s.ui.submit('/extensions build synthetic specification')).rejects.toThrow('ask Pico in chat');
    expect(calls).not.toHaveBeenCalled();
  }
  expect(s.faux.state.callCount).toBe(0);
  for (const table of ['messages','runs','memories','documents','schedules']) expect(s.service.runtime.store.all(`SELECT * FROM ${table}`)).toEqual([]);
});

it('administers standard skill packages in the connected TUI without inference and keeps volatile administration guarded', async () => {
  const s=await connected(),path=new URL('../examples/skills/text-statistics',import.meta.url).pathname,calls=vi.spyOn(s.client,'rpc');
  await s.ui.submit(`/skills import ${path}`);expect(calls).toHaveBeenCalledWith('skills.request',{action:'import',localPath:path});expect(s.service.runtime.store.all('SELECT * FROM skill_packages')).toHaveLength(1);
  await s.ui.submit('/skills read text-statistics');expect(calls).toHaveBeenCalledWith('skills.read',{name:'text-statistics'});expect(s.service.runtime.store.all('SELECT * FROM skill_activations')).toHaveLength(1);
  await s.ui.submit('/skills disable text-statistics');expect(s.service.runtime.skills.catalog({ownerId:s.config.ownerId,instanceId:s.config.instanceId,conversationId:'',runId:'',source:{channel:'terminal',identity:'owner',trustedOwner:true},mode:'foreground'}).skills).toEqual([]);
  await s.ui.submit('/skills enable text-statistics');await s.ui.submit('/skills');expect(s.screen.output).toContain('SKILL SCRIPTS');expect(s.faux.state.callCount).toBe(0);
  await selectLegacyEphemeral(s);await expect(s.ui.submit('/skills import /private/volatile')).rejects.toThrow('Ephemeral');await expect(s.ui.submit('/skills read text-statistics')).rejects.toThrow('Ephemeral');
});

it.each([false, true])('uses chat tools for agenda, reminders and memory instead of slash handlers (ephemeral=%s)', async ephemeral => {
  const s = await connected(); if (ephemeral) await selectLegacyEphemeral(s);
  s.faux.appendResponses([
    loadTools('agenda'),
    fauxAssistantMessage([fauxToolCall('agenda', { period: 'today' }), fauxToolCall('schedules_list', {}), fauxToolCall('memory_search', { query: 'canoe' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('Here is your day and what I remember.')])
  ]);
  const calls = vi.spyOn(s.client, 'rpc');
  await s.ui.submit('What is on my agenda, which reminders do I have, and what do you remember about my canoe?');
  await waitFor(() => !s.ui.editor.disableSubmit);
  await s.see('Here is your day');
  const tools = [...(s.ui as any).toolBlocks.values()].map(({ output }: any) => ({ tool: output.tool, error: output.error }));
  expect(tools).toEqual([{ tool: 'tools_load', error: false }, { tool: 'agenda', error: false }, { tool: 'schedules_list', error: false }, { tool: 'memory_search', error: false }]);
  expect(calls.mock.calls.some(([op]) => ['agenda','schedules.list','memory.search'].includes(op))).toBe(false);
  expect(s.faux.state.callCount).toBe(3);
  if (ephemeral) expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]);
});

it('interrupts the active turn with Escape without exiting, even if cancellation fails', async () => {
  const s = await connected(); reply(s.faux, 'A long response '.repeat(1000));
  await s.ui.submit('Continue until interrupted'); await waitFor(() => s.faux.state.callCount > 0);
  const run = s.service.runtime.store.get<{ id: string }>('SELECT id FROM runs')!;
  const rpc = s.client.rpc.bind(s.client);
  const calls = vi.spyOn(s.client, 'rpc').mockImplementation((op, args) => op === 'cancel' ? Promise.reject(new Error('Fixture cancellation failure')) : rpc(op, args));
  s.screen.input('\x1b'); await waitFor(() => calls.mock.calls.some(([op]) => op === 'cancel'));
  expect(calls).toHaveBeenCalledWith('cancel', { id: run.id });
  expect(s.screen.stopped).toBe(false); expect(s.ui.editor.disableSubmit).toBe(true);
  calls.mockRestore(); s.screen.input('\x1b');
  await waitFor(() => !s.ui.editor.disableSubmit);
  expect(s.service.runtime.run(run.id).status).toBe('cancelled'); expect(s.screen.stopped).toBe(false);
  s.screen.input('\x1b'); expect(s.screen.stopped).toBe(false);
});

it.each([
  { name: 'plain text', text: 'Hello' },
  { name: 'multiline Unicode and unsafe controls', text: 'User line **bold**\nsecond 漢字 👋\x1b[31m\u202e' },
  { name: 'nested Markdown styles', text: '# Heading\n\n- **bold** and *italic* with `code`, ~~strike~~ and [link](https://fixture.invalid)\n\n```text\ncode block\n```' }
])('renders full-width user backgrounds during streaming and history reload: $name', async ({ text }) => {
  const s = await connected(), answer = 'Normal **Markdown** answer. '.repeat(100);
  const backgroundWidth = (line: string) => {
    let active = false, columns = 0;
    for (const part of line.split(/(\x1b\[[\d;]*m)/)) {
      if (part === '\x1b[48;5;236m') active = true;
      else if (/^\x1b\[(?:0|49)?m$/.test(part)) active = false;
      else if (active) columns += visibleWidth(part);
    }
    return columns;
  };
  reply(s.faux, answer); await s.ui.submit(text);
  const user = s.ui.transcript.children.find(child => child.render(100).join('\n').includes('\x1b[48;5;236m'))!;
  for (const width of [20, 42, 100]) {
    const lines = user.render(width);
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(width);
      expect(backgroundWidth(line), JSON.stringify(line)).toBe(width);
    }
    expect(lines.join('\n')).toContain('\x1b[97m');
    expect(lines.map(safeTerminal).join('\n')).not.toMatch(/^\s*You\s*$/m);
    expect(lines.join('\n')).not.toContain('\x1b[31m'); expect(lines.join('\n')).not.toContain('\u202e');
  }
  await waitFor(() => (s.ui as any).assistantBlocks.size > 0);
  const assistant = [...(s.ui as any).assistantBlocks.values()][0] as import('@earendil-works/pi-tui').Container;
  expect(assistant.render(100).join('\n')).not.toContain('\x1b[48;5;236m');
  await waitFor(() => !s.ui.editor.disableSubmit);
  const transcript = s.ui.transcript.render(100).map(safeTerminal).join('\n');
  expect(transcript).toContain('Normal Markdown answer.'); expect(transcript).not.toMatch(/^\s*(You|Pico)\s*$/m);
  const before = [user.render(100), assistant.render(100)];
  const session = (await s.client.rpc<{ id: string }[]>('sessions'))[0]!;
  await s.ui.submit(`/sessions ${session.id}`);
  const restoredUser = s.ui.transcript.children.find(child => child.render(100).join('\n').includes('\x1b[48;5;236m'))!;
  const restoredAssistant = [...(s.ui as any).assistantBlocks.values()][0] as import('@earendil-works/pi-tui').Container;
  expect([restoredUser.render(100),restoredAssistant.render(100)]).toEqual(before);
});

it.each([false,true])('streams replies once as normal Markdown through completion, expansion, reconnect and history reload (ephemeral=%s)', async ephemeral => {
  const s = await connected(); if (ephemeral) await selectLegacyEphemeral(s);
  const stream = createAssistantMessageEventStream(), partial = fauxAssistantMessage([fauxText('Streaming **Markdown** answer.')]);
  const calls = vi.spyOn(s.service.runtime.models.models,'streamSimple').mockResolvedValue(stream);
  const text = () => s.ui.transcript.render(100).map(safeTerminal).join('\n');
  await s.ui.submit('Synthetic plain streaming');
  stream.push({type:'start',partial}); stream.push({type:'text_delta',contentIndex:0,delta:'Streaming **Markdown** answer.',partial});
  await waitFor(() => text().includes('Streaming Markdown answer.'));
  const blockId = [...(s.ui as any).assistantBlocks.keys()][0];
  const check = () => {
    const block = (s.ui as any).assistantBlocks.get(blockId) as import('@earendil-works/pi-tui').Container;
    expect((s.ui as any).assistantBlocks.size).toBe(1);
    expect(text().split('Streaming Markdown answer.')).toHaveLength(2);
    expect(text()).not.toContain('Response stream'); expect(text()).not.toContain('Request instructions'); expect(text()).not.toContain('Working');
    expect(block.children).toHaveLength(1); expect(block.render(100).join('\n')).not.toContain('\x1b[48;5;235m');
    expect([...(s.ui as any).detailBoxes.keys()]).toEqual([]);
  };
  expect(s.ui.editor.disableSubmit).toBe(true); check();
  stream.push({type:'done',reason:'stop',message:partial}); await waitFor(() => !s.ui.editor.disableSubmit); check();
  s.screen.input('\x0f'); check();
  await (s.ui as any).reconnect(); check();
  const session = (s.ui as any).session.id; await s.ui.submit(`/sessions ${session}`); check();
  expect(calls).toHaveBeenCalledTimes(1);
  if (ephemeral) expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]);
});

it.each([false, true])('keeps thinking and tools reopenable while pre-tool text stays a normal message (ephemeral=%s)', async ephemeral => {
  const s = await connected(); if (ephemeral) await selectLegacyEphemeral(s);
  const thinking = 'Consider **evidence** and `tools`.\n\n- *Unicode* 漢字 👋\x1b[31m\u202e', preface = 'Checking the clock before answering.', answer = 'The final answer.';
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  s.faux.appendResponses([
    fauxAssistantMessage([fauxThinking(thinking),fauxText(preface),fauxToolCall('time',{})],{stopReason:'toolUse'}),
    async () => { await gate; return fauxAssistantMessage([fauxText(answer)]); }
  ]);
  const text = () => s.ui.transcript.render(100).map(safeTerminal).join('\n');
  try {
    await s.ui.submit('Synthetic clock question'); await waitFor(() => s.faux.state.callCount === 2);
    await waitFor(() => text().includes('Tool time'));
    expect(text()).toContain(preface); expect(text()).toContain('▶ Thinking'); expect(text()).not.toContain('Working');
    s.screen.input('\x0f');
    expect(text()).toContain('Thinking · not a final answer');
    const session = (s.ui as any).session.id;
    await s.ui.submit(`/sessions ${session}`);
    expect(text().split(preface)).toHaveLength(2); expect(s.ui.editor.disableSubmit).toBe(true);
    const working = s.ui.transcript.children.find(child => child.render(100).map(safeTerminal).join('\n').includes(preface))!;
    const thinkingBox = (working as import('@earendil-works/pi-tui').Container).children[0]!;
    for (const width of [20,42,100]) for (const line of thinkingBox.render(width)) {
      let active = false, columns = 0;
      for (const part of line.split(/(\x1b\[[\d;]*m)/)) {
        if (part === '\x1b[48;5;235m') active = true;
        else if (/^\x1b\[(?:0|49)?m$/.test(part)) active = false;
        else if (active) columns += visibleWidth(part);
      }
      expect(visibleWidth(line)).toBe(width); expect(columns,JSON.stringify(line)).toBe(width);
      expect(line).not.toContain('\x1b[31m'); expect(line).not.toContain('\u202e');
    }
    finish(); await waitFor(() => !s.ui.editor.disableSubmit);
    expect(text()).toContain(preface); expect(text()).toContain(answer); expect(text()).toContain('Tool time · done');
    expect(thinkingBox.render(100).join('\n')).toContain('\x1b[48;5;235m');
    expect((working as import('@earendil-works/pi-tui').Container).children.at(-1)!.render(100).join('\n')).not.toContain('\x1b[48;5;235m');
    const final = s.ui.transcript.children.at(-1)!;
    expect((final as import('@earendil-works/pi-tui').Container).children.at(-1)!.render(100).join('\n')).not.toContain('\x1b[48;5;235m');
    const before = s.ui.transcript.children.slice(1).flatMap(child => child.render(100));
    await s.ui.submit(`/sessions ${session}`); expect(s.ui.transcript.children.slice(1).flatMap(child => child.render(100))).toEqual(before);
    expect(s.faux.state.callCount).toBe(2);
  } finally { finish(); }
});

it('reconnect recovers missed assistant blocks without replay or duplication', async () => {
  const s = await connected(); let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  s.faux.appendResponses([
    fauxAssistantMessage([fauxThinking('Visible reasoning before disconnect.'),fauxText('Preserved preface.'),fauxToolCall('time',{})],{stopReason:'toolUse'}),
    async () => { await gate; return fauxAssistantMessage([fauxThinking('Reasoning while disconnected.'),fauxText('Recovered final answer.')]); }
  ]);
  try {
    await s.ui.submit('Synthetic reconnect question'); await waitFor(() => s.faux.state.callCount === 2);
    (s.ui as any).unsubscribe(); finish();
    await waitFor(() => s.service.runtime.store.get<{status:string}>('SELECT status FROM runs')?.status === 'completed');
    await (s.ui as any).reconnect();
    s.screen.input('\x0f');
    const text = s.ui.transcript.render(100).map(safeTerminal).join('\n');
    for (const part of ['Visible reasoning before disconnect.','Preserved preface.','Reasoning while disconnected.']) expect(text.split(part)).toHaveLength(2);
    expect(text.split('Recovered final answer.')).toHaveLength(2);
    expect(text).not.toContain('Response stream'); expect(text).not.toContain('Request instructions');
    expect(s.faux.state.callCount).toBe(2); expect(s.ui.editor.disableSubmit).toBe(false);
  } finally { finish(); }
});

it.each([false,true])('keeps rejected citation drafts and thinking inspectable but out of published answers and future model context (ephemeral=%s)', async ephemeral => {
  const s = await connected(); if (ephemeral) await selectLegacyEphemeral(s);
  const stream = vi.spyOn(s.service.runtime.models.models,'streamSimple');
  s.faux.appendResponses([
    fauxAssistantMessage([fauxThinking('Discarded draft reasoning.'),fauxText('Invented citation pico:nonexistent')]),
    fauxAssistantMessage([fauxText('Repaired answer without invented sources.')])
  ]);
  await s.ui.submit('Synthetic citation check'); await waitFor(() => !s.ui.editor.disableSubmit);
  const text = s.ui.transcript.render(100).map(safeTerminal).join('\n');
  expect(text).toContain('Pico could not verify the source citations'); expect(text).toContain('Repaired answer without invented sources.');
  expect(text).not.toContain('Invented citation'); expect(text).not.toContain('Discarded draft reasoning.');
  s.screen.input('\x0f');
  const debug = s.ui.transcript.render(100).map(safeTerminal).join('\n');
  expect(debug).toContain('rejected / unverified'); expect(debug).toContain('Discarded draft reasoning.'); expect(debug).toContain('Invented citation pico:nonexistent');
  const session = (s.ui as any).session.id; await s.ui.submit(`/sessions ${session}`);
  expect(s.ui.transcript.render(100).map(safeTerminal).join('\n')).toContain('Discarded draft reasoning.');
  reply(s.faux,'Next normal reply.'); await s.ui.submit('Synthetic follow-up'); await waitFor(() => !s.ui.editor.disableSubmit);
  const next = JSON.stringify(stream.mock.calls.at(-1)![1]);
  expect(next).not.toContain('Discarded draft reasoning.'); expect(next).not.toContain('Invented citation pico:nonexistent'); expect(next).not.toContain('picoInstructions'); expect(next).not.toContain('picoDisplay');
  if (ephemeral) expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]);
});

it('keeps cancelled thinking-only output visible and labelled incomplete', async () => {
  const s = await connected();
  s.faux.appendResponses([fauxAssistantMessage([fauxThinking('Visible slow reasoning. '.repeat(500)),fauxText('Unreached final')])]);
  await s.ui.submit('Synthetic cancellation question');
  await waitFor(() => s.ui.transcript.render(100).map(safeTerminal).join('\n').includes('Visible slow'));
  s.screen.input('\x1b'); await waitFor(() => !s.ui.editor.disableSubmit);
  expect(s.ui.transcript.render(100).map(safeTerminal).join('\n')).toContain('▶ Thinking · not a final answer · incomplete');
  s.screen.input('\x0f');
  const text = s.ui.transcript.render(100).map(safeTerminal).join('\n');
  expect(text).toContain('Thinking · not a final answer'); expect(text).toContain('Visible slow'); expect(text).toContain('[cancelled:'); expect(text).not.toContain('Unreached final');
});

it.each([false,true])('preserves streamed reasoning when the provider final snapshot omits it, including reconnect/reopening (ephemeral=%s)', async ephemeral => {
  const s = await connected(); if (ephemeral) await selectLegacyEphemeral(s);
  const partial = fauxAssistantMessage([fauxThinking('Streamed reasoning omitted by final provider snapshot.')]);
  const final = fauxAssistantMessage([fauxText('Final answer without a thinking block.')]);
  const stream = createAssistantMessageEventStream();
  const calls = vi.spyOn(s.service.runtime.models.models,'streamSimple').mockResolvedValue(stream);
  stream.push({type:'start',partial}); stream.push({type:'thinking_delta',contentIndex:0,delta:'Streamed reasoning omitted by final provider snapshot.',partial});
  await s.ui.submit('Synthetic snapshot omission'); await waitFor(() => s.ui.transcript.render(100).map(safeTerminal).join('\n').includes('Streamed reasoning omitted'));
  (s.ui as any).unsubscribe(); stream.push({type:'done',reason:'stop',message:final});
  await waitFor(() => !s.service.runtime.hasPendingRuns); await (s.ui as any).reconnect();
  expect(s.ui.transcript.render(100).map(safeTerminal).join('\n')).toContain('▶ Thinking');
  s.screen.input('\x0f'); expect(s.ui.transcript.render(100).map(safeTerminal).join('\n')).toContain('Streamed reasoning omitted by final provider snapshot.');
  const session=(s.ui as any).session.id; await s.ui.submit(`/sessions ${session}`);
  expect(s.ui.transcript.render(100).map(safeTerminal).join('\n')).toContain('Streamed reasoning omitted by final provider snapshot.');
  expect(calls).toHaveBeenCalledTimes(1);
  const history=await s.client.rpc<any[]>('history',{conversationId:session}); expect(history.find(row=>row.role==='assistant').content?.some((block:any)=>block.type==='thinking')).not.toBe(true);
  if(ephemeral)expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]);
});

it.each([false,true])('never renders agent instruction panels while retaining owner-only snapshot RPC (ephemeral=%s)', async ephemeral => {
  const s=await connected(); if(ephemeral)await selectLegacyEphemeral(s);
  const uiCalls=vi.spyOn(s.client,'rpc');
  const text=()=>s.ui.transcript.render(100).map(safeTerminal).join('\n');
  expect(text()).not.toContain('Agent system instructions'); expect(text()).not.toContain('current baseline');
  expect(s.faux.state.callCount).toBe(0); expect(s.service.runtime.store.all('SELECT * FROM runs')).toEqual([]);
  s.ui.editor.setText('Unsent instruction-inspection draft'); s.screen.input('\x14');
  expect(text()).not.toContain('Agent system instructions'); expect(s.ui.editor.getText()).toBe('Unsent instruction-inspection draft');
  const model=vi.spyOn(s.service.runtime.models.models,'streamSimple');
  s.faux.appendResponses([fauxAssistantMessage([fauxToolCall('time',{})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Instruction panel final reply.')])]);
  await s.ui.submit('Synthetic instruction inspection'); await waitFor(()=>!s.ui.editor.disableSubmit);
  const session=(s.ui as any).session.id, history=await s.client.rpc<any[]>('history',{conversationId:session}), assistants=history.filter(row=>row.role==='assistant');
  expect(text()).not.toContain('Agent system instructions');
  expect(text()).not.toContain('Request instructions');
  expect(uiCalls.mock.calls.some(([op]) => op === 'instructions.read')).toBe(false);
  for(let index=0;index<assistants.length;index++) {
    const id=assistants[index].display.instructionsId, snapshot=await s.client.rpc<{text:string}>('instructions.read',{id});
    const expected=model.mock.calls[index]![1].messages.filter(message=>message.role==='system').map((message,number)=>{const {content,...metadata}=message;return `System message ${number+1}\n${content}\n\nMessage metadata / tool declarations\n${JSON.stringify(metadata)}`;}).join('\n\n');
    expect(snapshot.text).toBe(expected); expect(snapshot.text).toContain('Current reminder state'); expect(snapshot.text).toContain('Explicit owner standing preferences');
    expect(JSON.stringify(assistants[index])).not.toContain('picoInstructions');
  }
  uiCalls.mockClear(); s.screen.input('\x0f');
  expect(uiCalls).not.toHaveBeenCalled(); expect(text()).not.toContain('Message metadata / tool declarations');
  expect(s.ui.editor.getText()).toBe('Unsent instruction-inspection draft'); expect(s.faux.state.callCount).toBe(2);
  reply(s.faux,'Second normal reply.'); await s.ui.submit('Synthetic second request'); await waitFor(()=>!s.ui.editor.disableSubmit);
  await s.ui.submit(`/sessions ${session}`);
  expect(text()).not.toContain('Agent system instructions'); expect(text()).not.toContain('Request instructions');
  expect(uiCalls.mock.calls.some(([op]) => op === 'instructions.read')).toBe(false);
  expect(uiCalls.mock.calls.some(([op]) => op === 'instructions.preview')).toBe(false);
  const count=s.service.runtime.store.all('SELECT * FROM messages').length;
  await expect(s.client.rpc('instructions.preview',{conversationId:'foreign'})).rejects.toThrow('not found');
  await expect(s.client.rpc('instructions.read',{id:'foreign'})).rejects.toThrow('not recorded');
  await expect(s.client.rpc('instructions.read',{id:assistants[0].display.instructionsId,ownerId:'foreign'})).rejects.toThrow('Invalid');
  expect(s.service.runtime.store.all('SELECT * FROM messages')).toHaveLength(count); expect(s.faux.state.callCount).toBe(3);
  if(ephemeral)expect(count).toBe(0);
});

it('streams final-message thinking, collapses it on completion and expands it without changing the draft or replaying input', async () => {
  const s = await connected(), reasoning = 'Visible reasoning 漢字 👋. '.repeat(100);
  s.faux.appendResponses([fauxAssistantMessage([fauxThinking(reasoning),fauxText('Final answer with **Markdown**.')])]);
  const text = () => s.ui.transcript.render(100).map(safeTerminal).join('\n');
  await s.ui.submit('Synthetic final-message thinking');
  await waitFor(() => text().includes('Visible reasoning'));
  expect(text()).toContain('▼ Thinking');
  await waitFor(() => !s.ui.editor.disableSubmit);
  expect(text()).toContain('▶ Thinking'); expect(text()).not.toContain('Visible reasoning'); expect(text()).toContain('Final answer with Markdown.');
  s.ui.tui.renderNow(true);
  expect(s.ui.tui.getScreenLines().map(safeTerminal).join('\n')).toContain('▶ Thinking');
  s.ui.editor.setText('Unsent debug draft'); const cursor = s.ui.editor.getCursor(), calls = vi.spyOn(s.client,'rpc');
  s.screen.input('\x0f'); expect(text()).toContain('Visible reasoning');
  s.screen.input('\x0f'); expect(text()).not.toContain('Visible reasoning');
  expect(s.ui.editor.getText()).toBe('Unsent debug draft'); expect(s.ui.editor.getCursor()).toEqual(cursor); expect(s.ui.editor.focused).toBe(true);
  expect(calls).not.toHaveBeenCalled(); expect(s.faux.state.callCount).toBe(1);
});

it('toggles individual boxes with real mouse packets and a keyboard picker, preserving editor focus and drafts', async () => {
  const s = await connected();
  s.faux.appendResponses([fauxAssistantMessage([fauxThinking('Click-reopened reasoning.'),fauxText('Final answer.')])]);
  await s.ui.submit('Synthetic mouse test'); await waitFor(() => !s.ui.editor.disableSubmit);
  s.ui.editor.setText('Keep this draft'); s.ui.tui.renderNow(true);
  const row = s.ui.tui.getScreenLines().findIndex(line => safeTerminal(line).includes('▶ Thinking'));
  expect(row).toBeGreaterThanOrEqual(0);
  s.screen.input(`\x1b[<0;4;${row+1}M`); s.screen.input(`\x1b[<0;4;${row+1}m`);
  expect(s.ui.transcript.render(100).map(safeTerminal).join('\n')).toContain('Click-reopened reasoning.');
  expect(s.ui.editor.focused).toBe(true); s.ui.tui.renderNow(true);
  s.screen.input(`\x1b[<0;4;${row+1}M`); s.screen.input(`\x1b[<0;4;${row+1}m`);
  expect(s.ui.transcript.render(100).map(safeTerminal).join('\n')).not.toContain('Click-reopened reasoning.');
  s.screen.input('\x14'); await s.see('Inspect a debug box'); expect(s.ui.canRefresh).toBe(false);
  s.screen.input('\x1b[B'); s.screen.input('\r'); await waitFor(() => s.ui.editor.focused);
  expect(s.ui.transcript.render(100).map(safeTerminal).join('\n')).toContain('Click-reopened reasoning.');
  expect(s.ui.editor.getText()).toBe('Keep this draft'); expect(s.faux.state.callCount).toBe(1);
  for (const [columns,rows] of [[4,12],[12,15],[42,15],[100,35]]) {
    s.screen.columns = columns!; s.screen.rows = rows!; s.screen.resize(); s.ui.tui.renderNow(true);
    expect(s.ui.tui.getScreenLines().every(line => visibleWidth(line) <= columns!)).toBe(true);
  }
});

it.each([false,true])('restores tool arguments, partial updates and final results across active reconnect and history reload (ephemeral=%s)', async ephemeral => {
  const s = await connected(); if (ephemeral) await selectLegacyEphemeral(s);
  let finish!: () => void, update!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  s.service.runtime.extensions.registerBuiltin('debug-fixture',pico => pico.registerTool({
    name:'debug_fixture',label:'Debug fixture',description:'Synthetic streaming tool',parameters:pico.Type.Object({label:pico.Type.String()},{additionalProperties:false}),
    async execute(_id,args,_signal,onUpdate) {
      onUpdate?.({content:[{type:'text',text:'Initial progress.'}],details:{phase:1}});
      update = () => onUpdate?.({content:[{type:'text',text:'Disconnected progress 漢字 👋.'}],details:{phase:2}});
      await gate; return {content:[{type:'text',text:'Complete tool result\nsecond line\x1b[31m\u202e'}],details:{phase:3,label:args.label}};
    }
  }));
  s.faux.appendResponses([
    loadTools('debug_fixture'),
    fauxAssistantMessage([fauxToolCall('debug_fixture',{label:'Original tool arguments 漢字 👋'})],{stopReason:'toolUse'}),
    fauxAssistantMessage([fauxText('Final tool answer.')])
  ]);
  const text = () => s.ui.transcript.render(100).map(safeTerminal).join('\n');
  try {
    await s.ui.submit('Synthetic tool diagnostics'); await waitFor(() => text().includes('Initial progress.'));
    expect(text()).toContain('Original tool arguments'); expect(text()).toContain('Tool debug_fixture · working');
    (s.ui as any).unsubscribe(); update();
    await (s.ui as any).reconnect();
    if (text().includes('▶ Tool debug_fixture')) s.screen.input('\x0f');
    expect(text()).toContain('Disconnected progress'); expect(text()).not.toContain('outcome not confirmed');
    finish(); await waitFor(() => !s.ui.editor.disableSubmit);
    expect(text()).toContain('▶ Tool debug_fixture · done'); expect(text()).not.toContain('Complete tool result'); expect(text()).toContain('Final tool answer.');
    s.screen.input('\x0f'); expect(text()).toContain('Complete tool result');
    expect(text().split('Tool debug_fixture')).toHaveLength(2);
    const session = (s.ui as any).session.id;
    await s.ui.submit(`/sessions ${session}`);
    expect(text()).toContain('Original tool arguments'); expect(text()).toContain('Complete tool result'); expect(text()).not.toContain('Initial progress.');
    expect(s.ui.transcript.render(100).join('\n')).not.toContain('\x1b[31m'); expect(text()).not.toContain('\u202e');
    expect(s.faux.state.callCount).toBe(3);
    if (ephemeral) { expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]); expect(s.service.runtime.store.all('SELECT * FROM operations')).toEqual([]); }
  } finally { finish(); }
});

it('keeps repeated tool calls and failures in distinct collapsed boxes after completion and reopening', async () => {
  const s = await connected();
  s.faux.appendResponses([
    fauxAssistantMessage([fauxToolCall('time',{}),fauxToolCall('time',{unexpected:true})],{stopReason:'toolUse'}),
    fauxAssistantMessage([fauxText('One tool succeeded; the other failed.')])
  ]);
  const text = () => s.ui.transcript.render(100).map(safeTerminal).join('\n');
  await s.ui.submit('Synthetic repeated tool calls'); await waitFor(() => !s.ui.editor.disableSubmit);
  expect(text()).toContain('▶ Tool time · done'); expect(text()).toContain('▶ Tool time · failed'); expect(text().split('Tool time')).toHaveLength(3);
  s.screen.input('\x0f'); expect(text()).toContain('Validation failed'); expect(text()).toContain('"unexpected": true'); expect(text()).toContain('"utc"');
  const session = (s.ui as any).session.id; await s.ui.submit(`/sessions ${session}`);
  expect(text()).toContain('Validation failed'); expect(text()).toContain('"unexpected": true'); expect(text().split('Tool time')).toHaveLength(3); expect(s.faux.state.callCount).toBe(2);
});

it('keeps reused provider call IDs distinct across runs and restored history', async () => {
  const s = await connected(), call = { ...fauxToolCall('time',{}), id:'reused-provider-call' };
  for (const answer of ['First call answer.','Second call answer.']) {
    s.faux.appendResponses([fauxAssistantMessage([call],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText(answer)])]);
    await s.ui.submit('Synthetic reused call identity'); await waitFor(() => !s.ui.editor.disableSubmit);
  }
  const text = () => s.ui.transcript.render(100).map(safeTerminal).join('\n');
  expect(text().split('Tool time')).toHaveLength(3);
  const session = (s.ui as any).session.id; await s.ui.submit(`/sessions ${session}`);
  expect(text().split('Tool time')).toHaveLength(3); s.screen.input('\x0f'); expect(text().split('Call reused-provider-call')).toHaveLength(3); expect(s.faux.state.callCount).toBe(4);
});

it('renders tool text and metadata without Markdown interpretation and labels image payloads rather than dumping binary', async () => {
  const s = await connected(), conversationId = (s.ui as any).session.id;
  s.ui.onOutput({type:'tool',conversationId,runId:'image-fixture',data:{id:'image-call',tool:'fixture_image',state:'tool_execution_end',args:{},result:{content:[{type:'text',text:'Literal **tool text**\nSecond line\x1b[31m\u202e'},{type:'image',mimeType:'image/png',data:'BASE64_SYNTHETIC_SENTINEL'}],details:{trace:'inspectable metadata'}},error:false}});
  s.screen.input('\x0f'); const text = s.ui.transcript.render(100).map(safeTerminal).join('\n');
  expect(text).toContain('Literal **tool text**'); expect(text).toContain('Second line'); expect(text).toContain('inspectable metadata'); expect(text).toContain('image payload: 25 base64 characters'); expect(text).not.toContain('BASE64_SYNTHETIC_SENTINEL');
  expect(s.ui.transcript.render(100).join('\n')).not.toContain('\x1b[31m'); expect(text).not.toContain('\u202e');
});

it('shows the selected model, thinking level and remaining context in the footer instead of the header', async () => {
  const s = await connected(), rpc = s.client.rpc.bind(s.client);
  vi.spyOn(s.client, 'rpc').mockImplementation(async (op, args) => op === 'context.usage' ? { tokens: 12_000, contextWindow: 200_000 } : rpc(op, args));
  await (s.ui as any).refresh();
  const footer = s.ui.footer.render(120).map(safeTerminal).join('\n');
  expect(footer).toContain('faux/faux-1'); expect(footer).toContain('thinking off'); expect(footer).toContain('context 188k left of 200k');
  expect(footer).not.toContain('ready'); expect(footer).not.toContain('↑↓ history');
  expect(safeTerminal(s.ui.header.render(120).join('\n'))).not.toContain('faux/faux-1');
});

it('sets the session thinking level and the pi-style default through /thinking', async () => {
  const s = await connected(), session = (s.ui as any).session.id;
  await s.ui.submit('/thinking off');
  expect((await s.client.rpc<{level:string}>('thinking.get',{conversationId:session})).level).toBe('off');
  expect(safeTerminal(s.ui.footer.render(120).join('\n'))).toContain('thinking off');
  await expect(s.ui.submit('/thinking high')).rejects.toThrow('Unknown thinking level "high". Available levels: off.');
  const work = s.ui.submit('/thinking'); await s.see('Ctrl+S sets default');
  expect(s.screen.output).toContain('No reasoning · default');
  s.screen.input('\x13'); await work;
  expect(loadConfig(s.root).config.thinking).toBe('off');
  expect(s.ui.transcript.render(100).map(safeTerminal).join('\n')).not.toContain('Unknown thinking level');
});

it('publishes and clears extension footer status from the standard API without transcript noise', async () => {
  const s = await connected({ 'footer-fixture': `export default function(pico){pico.on('start',()=>pico.setStatus('Telegram','connected'));}` });
  const footer = () => s.ui.footer.render(100).map(safeTerminal).join('\n');
  expect(footer()).toContain('Telegram: connected');
  s.ui.onOutput({ type: 'extension_status', data: { key: 'Telegram', text: 'disconnected' } });
  expect(footer()).toContain('Telegram: disconnected'); expect(footer()).not.toContain('Telegram: connected');
  s.ui.onOutput({ type: 'extension_status', data: { key: 'Telegram', text: null } });
  expect(footer()).not.toContain('Telegram:');
  expect(s.ui.transcript.render(100).map(safeTerminal).join('\n')).not.toContain('Telegram:');
  expect(s.faux.state.callCount).toBe(0);
});

it('keeps pending tool calls explicitly incomplete on settlement and shows daemon diagnostics without boxes', async () => {
  const s = await connected(), conversationId = (s.ui as any).session.id;
  const send = (type:'assistant'|'settled'|'diagnostic',data:unknown) => s.ui.onOutput({type,conversationId,runId:'fixture-run',data});
  send('assistant',{id:'fixture-assistant',text:'',thinking:'',intermediate:true,complete:true,tools:[{id:'unexecuted-call',tool:'time',state:'tool_call',args:{}}]});
  send('settled',{status:'cancelled',text:'',error:'Synthetic cancellation.'});
  send('diagnostic',{component:'fixture',error:'Inspectable daemon diagnostic\x1b[31m\u202e'});
  const text = () => s.ui.transcript.render(100).map(safeTerminal).join('\n');
  expect(text()).toContain('Tool time · incomplete'); expect(text()).toContain('outcome not confirmed'); expect(text()).toContain('cancelled · incomplete response'); expect(text()).toContain('Inspectable daemon diagnostic'); expect(text()).not.toContain('▶ Diagnostic');
  s.screen.input('\x0f'); expect(text()).toContain('Arguments'); expect(text()).toContain('Inspectable daemon diagnostic');
  expect(s.ui.transcript.render(100).join('\n')).not.toContain('\x1b[31m'); expect(text()).not.toContain('\u202e'); expect(s.faux.state.callCount).toBe(0);
});

it('guides Telegram setup inside the actual TUI and daemon, masking secrets and activating the channel', async () => {
  const s = await connected(), token = '123456:fixture-secret-do-not-log';
  const work = s.ui.submit('/channels telegram setup');
  await s.see('Telegram bot token'); s.replace(token); s.ui.tui.renderNow(true);
  expect(s.screen.output).not.toContain(token); s.screen.input('\r');
  await s.see('Allowlisted owner user IDs'); s.replace('[0]'); s.screen.input('\r'); await s.see('Invalid value');
  expect(loadConfig(s.root).config.telegram).toBeUndefined(); expect(await s.service.runtime.credentials.secret('telegram.token')).toBeUndefined();
  s.replace('[123,456]'); s.screen.input('\r');
  await s.see('Default reminder recipient'); s.replace('999'); s.screen.input('\r');
  expect(s.ui.tui.hasOverlay()).toBe(false); expect(s.ui.canRefresh).toBe(false); s.replace('456'); s.screen.input('\r');
  await s.see('Save Telegram configuration'); s.screen.input('\r');
  await s.see('Apply saved settings now'); s.screen.input('\r'); await work;
  await waitFor(() => !s.ui.editor.disableSubmit);
  expect(loadConfig(s.root).config.telegram).toEqual({ allowedSenders: [123, 456], destination: 456 });
  expect(await s.service.runtime.credentials.secret('telegram.token')).toBe(token);
  expect(await s.client.rpc('channels.list')).toContainEqual({ id: 'telegram', destinations: ['telegram', 'telegram:123', 'telegram:456'] });
  expect(await s.client.rpc('secret.status')).toMatchObject({ 'telegram.token': true });
  expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]);
  expect(s.service.runtime.store.all('SELECT * FROM runs')).toEqual([]);
  await s.ui.submit('/telegram status'); await s.see('tokenConfigured');
  vi.spyOn(Telegram.prototype, 'check').mockResolvedValue({ reachable: true, username: 'FixtureBot', webhookActive: false });
  await s.ui.submit('/telegram check'); await s.see('FixtureBot');
  await expect(s.ui.submit('/telegram check inline-secret')).rejects.toThrow('never inline');
  s.ui.close(); expect(s.screen.output).not.toContain(token);
});

it('cancels guided setup with Escape without exiting or saving a partially entered token', async () => {
  const s = await connected(), token = '123456:cancelled-token';
  const work = s.ui.submit('/channels telegram setup'); await s.see('Telegram bot token');
  s.replace(token); s.screen.input('\r'); await s.see('Allowlisted owner user IDs'); s.screen.input('\x1b'); await work;
  expect(s.screen.stopped).toBe(false); expect(s.ui.tui.hasOverlay()).toBe(false); expect(s.ui.editor.disableSubmit).toBe(false);
  expect(await s.service.runtime.credentials.secret('telegram.token')).toBeUndefined();
  expect(loadConfig(s.root).config.telegram).toBeUndefined(); expect(s.screen.output).not.toContain(token);
  await s.ui.submit('/help'); expect(await s.client.rpc('status')).toMatchObject({ instanceId: s.config.instanceId });
});

it('discards masked inputs when detaching and does not render secrets on a narrow or resized terminal', async () => {
  const s = await connected(), key = 'fixture-private-key-never-echo'; s.screen.columns = 12; s.screen.rows = 12; s.screen.resize();
  const work = s.ui.submit('/auth key deepseek'); await s.see('DeepSeek');
  await waitFor(() => !s.ui.editor.focused); s.replace(key); s.ui.tui.renderNow(true);
  s.screen.columns = 70; s.screen.resize(); s.ui.tui.renderNow(true);
  expect(s.screen.output).not.toContain(key); s.ui.close(); await work;
  expect(s.screen.stopped).toBe(true); expect(await s.service.runtime.credentials.read('deepseek')).toBeUndefined();
  expect(s.screen.output).not.toContain(key);
});

it('stores API keys from a masked TUI prompt without conversation, history or model requests', async () => {
  const s = await connected(), key = 'fixture-deepseek-key-sensitive';
  const work = s.ui.submit('/auth key deepseek'); await s.see('Enter DeepSeek API key'); s.replace(key);
  for (const [columns, rows] of [[100, 35], [42, 15], [80, 24]] as const) {
    s.screen.columns = columns; s.screen.rows = rows; s.screen.resize(); s.ui.tui.renderNow(true);
    const lines = s.ui.tui.getScreenLines().map(safeTerminal);
    const question = lines.findIndex(line => line.includes('Enter DeepSeek API key'));
    expect(s.ui.tui.hasOverlay()).toBe(false); expect(s.ui.editor.focused).toBe(false);
    expect(question).toBe(rows - s.ui.footer.render(columns).length - 3);
    expect(lines[question + 1]).toContain('*'.repeat(key.length));
    expect(lines[question + 2]).toContain('Enter confirms · Esc cancels');
    expect(s.screen.output).not.toContain(key);
  }
  s.screen.input('\r'); await work;
  expect(s.ui.editor.focused).toBe(true);
  expect(await s.service.runtime.credentials.read('deepseek')).toEqual({ type: 'api_key', key });
  expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]); expect(s.faux.state.callCount).toBe(0);
  expect(s.screen.output).not.toContain(key); expect(s.ui.editor.getText()).toBe('');
  s.screen.input('\x1b[A'); expect(s.ui.editor.getText()).not.toContain(key);
});

it('rejects inline credentials and unsupported providers without admitting assistant input', async () => {
  const s = await connected();
  await expect(s.ui.submit('/auth key deepseek inline-sensitive-key')).rejects.toThrow('Never put credentials');
  await expect(s.ui.submit('/channels telegram setup inline-sensitive-token')).rejects.toThrow('Never put a token');
  await expect(s.ui.submit('/auth key unsupported')).rejects.toThrow('Unsupported provider authentication');
  expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]); expect(s.faux.state.callCount).toBe(0);
  expect(s.screen.output).not.toContain('inline-sensitive'); expect(s.ui.tui.hasOverlay()).toBe(false);
});

it('Codex /auth keeps the question and options in the input area, renders device codes and supports logout', async () => {
  const s = await connected(); let finish!: () => void;
  const provider = s.runtime.models.models.getProvider('openai-codex')!, oauth = provider.auth.oauth!;
  s.runtime.models.models.setProvider({ ...provider, auth: { ...provider.auth, oauth: { ...oauth, login: async interaction => {
    const method = await interaction.prompt({ type: 'select', message: 'Select login method', options: [{ id: 'browser', label: 'Browser login' }, { id: 'device_code', label: 'Device code login' }] });
    expect(method).toBe('device_code'); interaction.notify({ type: 'device_code', verificationUri: 'https://fixture.invalid/device', userCode: 'FIXTURE-123' });
    await new Promise<void>(resolve => { finish = resolve; });
    return { type: 'oauth', access: 'fixture-subscription-access', refresh: 'fixture-refresh', expires: Date.now() + 3600_000, accountId: 'fixture-account' };
  } } } });
  const work = s.ui.submit('/auth codex'); await s.see('Device code login');
  for (const [columns, rows] of [[100, 35], [42, 15], [80, 24]] as const) {
    s.screen.columns = columns; s.screen.rows = rows; s.screen.resize(); s.ui.tui.renderNow(true);
    const lines = s.ui.tui.getScreenLines().map(safeTerminal);
    const question = lines.findIndex(line => line.includes('Select login method'));
    const browser = lines.findIndex(line => line.includes('Browser login'));
    const device = lines.findIndex(line => line.includes('Device code login'));
    expect(question).toBeGreaterThanOrEqual(0); expect(browser).toBe(question + 1); expect(device).toBe(browser + 1);
    expect(lines[browser]).toMatch(/^→ Browser login/); expect(lines[device]).toMatch(/^  Device code login/);
    expect(device).toBe(rows - s.ui.footer.render(columns).length - 2);
    expect(s.ui.editor.focused).toBe(false); expect(s.ui.tui.hasOverlay()).toBe(false);
  }
  s.screen.input('\u001b[B'); s.screen.input('\r');
  await s.see('FIXTURE-123'); finish(); await work;
  expect(s.ui.editor.focused).toBe(true);
  expect(await s.runtime.credentials.read('openai-codex')).toMatchObject({ type: 'oauth', access: 'fixture-subscription-access' });
  expect(s.screen.output).not.toContain('fixture-subscription-access'); expect(s.store.all('SELECT * FROM messages')).toHaveLength(0); expect(s.faux.state.callCount).toBe(0);
  await s.ui.submit('/logout openai-codex'); expect(await s.runtime.credentials.read('openai-codex')).toBeUndefined();
});
it('keeps long selection menus visible and preserves the selected option on resize', async () => {
  const s = await connected(); s.screen.columns = 42; s.screen.rows = 15; s.screen.resize();
  const work = s.ui.submit('/setup'); await s.see('Model API key');
  s.screen.input('\x1b[A');
  for (const [columns, rows] of [[42, 15], [42, 12], [80, 24]] as const) {
    s.screen.columns = columns; s.screen.rows = rows; s.screen.resize(); s.ui.tui.renderNow(true);
    const lines = s.ui.tui.getScreenLines().map(safeTerminal);
    expect(lines.some(line => line.startsWith('→ Apply saved settings'))).toBe(true);
    expect(lines.some(line => line.includes('Esc cancels')), lines.join('\n')).toBe(true);
    expect(lines.every(line => visibleWidth(line) <= columns)).toBe(true);
  }
  s.screen.input('\x1b'); await work;
  expect(s.screen.stopped).toBe(false); expect(s.ui.editor.focused).toBe(true); expect(s.ui.editor.disableSubmit).toBe(false);
});

it.each(['manual_code', 'select'] as const)('browser completion closes a pending %s dialog without waiting for terminal submission', async type => {
  const s = await connected(); let finish!: () => void;
  const provider = s.runtime.models.models.getProvider('openai-codex')!, oauth = provider.auth.oauth!;
  s.runtime.models.models.setProvider({ ...provider, auth: { ...provider.auth, oauth: { ...oauth, login: async interaction => {
    const controller = new AbortController();
    const manual = interaction.prompt(type === 'select'
      ? { type, message: 'Fixture callback question', options: [{ id: 'continue', label: 'Continue login' }], signal: controller.signal }
      : { type, message: 'Paste fixture callback code', signal: controller.signal }).catch(() => undefined);
    await new Promise<void>(resolve => { finish = resolve; }); controller.abort(); await manual;
    return { type: 'oauth', access: 'fixture-callback-access', refresh: 'fixture-refresh', expires: Date.now() + 3600_000 };
  } } } });
  const work = s.ui.submit('/login openai-codex'); await s.see(type === 'select' ? 'Fixture callback question' : 'Paste fixture callback code');
  if (type === 'manual_code') s.replace('unsubmitted-sensitive-code');
  finish(); await work;
  expect(s.screen.output).not.toContain('unsubmitted-sensitive-code'); expect(await s.runtime.credentials.read('openai-codex')).toMatchObject({ type: 'oauth' }); expect((s.ui as any).cancelDialog).toBeUndefined();
  expect(s.ui.editor.focused).toBe(true);
});
it('keeps /settings model in the bottom input area and restores the chat draft on cancellation', async () => {
  const s = await connected(), before = loadConfig(s.root).config.model;
  s.ui.editor.setText('Unsent chat draft');
  const work = s.ui.submit('/settings model'); await s.see('model — JSON');
  for (const [columns, rows] of [[100, 35], [42, 15], [80, 24]] as const) {
    s.screen.columns = columns; s.screen.rows = rows; s.screen.resize(); s.ui.tui.renderNow(true);
    const lines = s.ui.tui.getScreenLines().map(safeTerminal);
    expect(s.ui.tui.hasOverlay()).toBe(false);
    expect(s.ui.editor.focused).toBe(false); expect(s.ui.canRefresh).toBe(false);
    expect(lines.some(line => line.includes('model — JSON'))).toBe(true);
    const footerStart = lines.findIndex(line => line.includes('faux/faux-1'));
    expect(footerStart).toBeGreaterThan(0); expect(lines[footerStart - 1], lines.join('\n')).toMatch(/^─+$/);
    expect(lines.every(line => visibleWidth(line) <= columns)).toBe(true);
  }
  s.screen.input('\x01'); s.screen.input('\x0b'); s.screen.input('invalid JSON'); s.screen.input('\r');
  await s.see('Invalid JSON'); expect(loadConfig(s.root).config.model).toEqual(before);
  s.screen.input('\x1b'); await work;
  expect(s.ui.editor.focused).toBe(true); expect(s.ui.editor.getText()).toBe('Unsent chat draft');
  expect(loadConfig(s.root).config.model).toEqual(before);
  expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]); expect(s.faux.state.callCount).toBe(0);
});

it('evicts old image previews under the raw-byte budget without duplicating repeated image events',async()=>{
  const data='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',calls=vi.fn(async()=>({data,mime:'image/png',name:'synthetic.png',bytes:11_000_000,synthetic:true}));
  const ui=new ChatUI({rpc:calls,close(){}} as unknown as Client,new Screen()),first=crypto.randomUUID(),second=crypto.randomUUID();
  try {
    await (ui as any).showImage({attachmentId:first});await (ui as any).showImage({attachmentId:second});await (ui as any).showImage({attachmentId:second});
    const blocks=(ui as any).imageBlocks as Map<string,{bytes:number}>;expect(blocks.get(first)?.bytes).toBe(0);expect(blocks.get(second)?.bytes).toBe(11_000_000);expect(calls).toHaveBeenCalledTimes(2);
    expect(ui.transcript.children.map(child=>child.render(100).map(line=>safeTerminal(line).trim()).join(' ')).join(' ')).toContain(`Image ${first} · preview not cached; reopen this conversation`);
    await (ui as any).showImage({attachmentId:first});expect(ui.transcript.children).toHaveLength(2);expect(calls).toHaveBeenCalledTimes(3);
  } finally {ui.close();}
});

it.each(['attachment','document'])('shows and recovers an existing %s image in the TUI without Telegram or image generation',async kind=>{
  const s=await connected(),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=','base64'),attachmentId=s.service.runtime.media.save(png,'saved-preview.png','image/png');
  const doc=kind==='document'?await s.service.runtime.knowledge.importAttachment(attachmentId,'tui-preview'):undefined,reference=doc?{documentId:doc.id}:{attachmentId},fetch=vi.spyOn(globalThis,'fetch');
  s.faux.appendResponses([loadTools('image_show'),fauxAssistantMessage([fauxToolCall('image_show',reference)],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Here is the saved image.')])]);
  await s.ui.submit('Show that saved image here');await s.see('Image · saved original');await waitFor(()=>!s.ui.editor.disableSubmit);
  expect(s.ui.transcript.render(100).map(safeTerminal).join('\n')).toContain('saved-preview.png');expect(s.service.runtime.store.config.telegram).toBeUndefined();expect(s.service.runtime.images.list({}).total).toBe(0);expect(fetch).not.toHaveBeenCalled();
  const before=s.faux.state.callCount;await (s.ui as any).loadHistory();expect(s.ui.transcript.render(100).map(safeTerminal).join('\n')).toContain('Image · saved original');expect((s.ui as any).imageBlocks.size).toBe(1);expect(s.faux.state.callCount).toBe(before);
});
it('deduplicates simultaneous image events while their owner read is still pending',async()=>{
  let release!:(image:unknown)=>void;
  const calls=vi.fn(()=>new Promise(resolve=>{release=resolve;})),ui=new ChatUI({rpc:calls,close(){}} as unknown as Client,new Screen()),attachmentId=crypto.randomUUID();
  try{
    const first=(ui as any).showImage({attachmentId}),second=(ui as any).showImage({attachmentId});expect(calls).toHaveBeenCalledTimes(1);
    release({data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',mime:'image/png',name:'saved.png',bytes:68,synthetic:false});await Promise.all([first,second]);expect(ui.transcript.children).toHaveLength(1);
  }finally{ui.close();}
});
it('does not mirror another conversation or publish a late preview after switching sessions',async()=>{
  const s=await connected(),attachmentId=s.service.runtime.media.save(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=','base64'),'late.png','image/png'),rpc=s.client.rpc.bind(s.client);let release!:()=>void;
  const calls=vi.spyOn(s.client,'rpc').mockImplementation(async(op,args)=>{if(op==='images.preview')await new Promise<void>(resolve=>{release=resolve;});return rpc(op,args);});
  s.ui.onOutput({type:'image',conversationId:'another-conversation',data:{attachmentId}});expect(calls).not.toHaveBeenCalled();
  const pending=(s.ui as any).showImage({attachmentId});await waitFor(()=>!!release);await s.ui.submit('/new');release();await pending;
  expect((s.ui as any).imageBlocks.size).toBe(0);expect(s.ui.transcript.render(100).map(safeTerminal).join('\n')).not.toContain('late.png');
});

it('enables image generation through explicit settings and masked keys without image/model probes', async()=>{
  const s=await connected(),fetch=vi.spyOn(globalThis,'fetch');
  const key=s.ui.submit('/auth secret openai.imageKey');await s.see('openai.imageKey — masked');s.replace('fixture-masked-image-key');s.screen.input('\r');await key;
  expect(s.screen.output).not.toContain('fixture-masked-image-key');
  const setup=s.ui.submit('/settings imageGeneration');await s.see('imageGeneration — JSON');await s.see('API key');s.screen.input('\r');await s.see('Apply saved settings now');s.screen.input('\x1b[B');s.screen.input('\r');await setup;
  expect(loadConfig(s.root).config.imageGeneration).toEqual({provider:'openai',model:'gpt-image-1',quality:'low'});expect(s.service.runtime.store.config.imageGeneration).toBeUndefined();
  expect(fetch.mock.calls.every(([url])=>!String(url).includes('api.openai.com'))).toBe(true);expect(s.faux.state.callCount).toBe(0);expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]);
});

it('configures voice replies and masked speech credentials without speech/model probes', async () => {
  const s = await connected(), fetch = vi.spyOn(globalThis, 'fetch');
  const key = s.ui.submit('/auth secret openai.speechKey'); await s.see('openai.speechKey — masked'); s.replace('fixture-masked-speech-key'); s.screen.input('\r'); await key;
  expect(s.screen.output).not.toContain('fixture-masked-speech-key');
  expect(await s.service.runtime.credentials.secret('openai.speechKey')).toBe('fixture-masked-speech-key');
  const work = s.ui.submit('/settings speech'); await s.see('speech — JSON'); await s.see('for the current chat until /new'); s.screen.input('\r');
  await s.see('Apply saved settings now'); s.screen.input('\x1b[B'); s.screen.input('\r'); await work;
  expect(loadConfig(s.root).config.speech).toEqual({ provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy' });
  expect(s.service.runtime.store.config.speech).toBeUndefined();
  expect(fetch.mock.calls.every(([url]) => !String(url).includes('api.openai.com'))).toBe(true);
  expect(s.faux.state.callCount).toBe(0); expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]);
  await s.client.rpc('settings.update', { speech: null }); expect(loadConfig(s.root).config.speech).toBeUndefined();
  for (const speech of [{ provider: 'other', model: 'test', voice: 'alloy' }, { provider: 'openai', model: 'test', voice: 'alloy', apiKey: 'not-config' }, { provider: 'openai', model: 'test', voice: '' }]) {
    await expect(s.client.rpc('settings.update', { speech })).rejects.toThrow('Invalid input');
  }
});

it('renders and recovers generated images without feature commands or regeneration', async()=>{
  const s=await connected(),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=','base64');
  s.service.runtime.store.config.imageGeneration={provider:'openai',model:'gpt-image-1',quality:'low'};await s.service.runtime.credentials.setSecret('openai.imageKey','fixture-image-key');
  const realFetch=globalThis.fetch,fetch=vi.spyOn(globalThis,'fetch').mockImplementation((url,options)=>String(url)==='https://api.openai.com/v1/images/generations'?Promise.resolve(Response.json({data:[{b64_json:png.toString('base64')}]})):realFetch(url,options));
  s.faux.appendResponses([loadTools('image_generate'),fauxAssistantMessage([fauxToolCall('image_generate',{prompt:'Synthetic blue circle'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Generated image ready')])]);
  await s.ui.submit('Create a synthetic blue circle');await s.see('Generated image · synthetic');await waitFor(()=>!s.ui.editor.disableSubmit);
  const image=s.service.runtime.images.list({}).images[0]!,attachmentId=image.attachmentId;
  const original=await s.client.rpc<{data:string}>('images.read',{id:attachmentId});expect(Buffer.from(original.data,'base64')).toEqual(png);
  s.screen.output='';await (s.ui as any).loadHistory();s.ui.tui.renderNow(true);expect(s.ui.tui.getScreenLines().map(safeTerminal).join('\n')).toContain('Generated image · synthetic');
  expect(s.ui.transcript.render(100).map(safeTerminal).join('\n')).not.toContain('/images');
  expect(fetch.mock.calls.filter(([url])=>String(url).includes('/images/generations'))).toHaveLength(1);
  await s.client.rpc('images.forget',{id:attachmentId});expect(s.service.runtime.images.list({}).total).toBe(0);
});

it('saves non-secret settings through the TUI, can defer application, and applies without replacing retained sessions', async () => {
  const s = await connected(), sessions = await s.client.rpc<{ id: string }[]>('sessions');
  const work = s.ui.submit('/settings timezone'); await s.see('timezone — JSON');
  s.screen.input('\x01'); s.screen.input('\x0b'); s.screen.input('"UTC"'); s.screen.input('\r');
  await s.see('Apply saved settings now'); s.screen.input('\x1b[B'); s.screen.input('\r'); await work;
  expect(loadConfig(s.root).config.timezone).toBe('UTC'); expect(s.service.runtime.store.config.timezone).toBe('Europe/Rome');
  s.service.runtime.scheduler.outbox('Notification during runtime reload', 'terminal', 'reload-notification');
  const apply = s.ui.submit('/reload'); await waitFor(() => !s.ui.editor.focused); s.screen.input('\r'); await apply;
  await s.see('Notification during runtime reload');
  expect(s.service.runtime.store.config.timezone).toBe('UTC'); expect(await s.client.rpc('sessions')).toEqual(expect.arrayContaining(sessions));
  await expect(s.ui.submit('/settings ownerId')).rejects.toThrow('protected');
  await expect(s.ui.submit('/settings apply')).rejects.toThrow('Unknown or protected setting');
  await expect(s.ui.submit('/reload extra')).rejects.toThrow('Use /reload without arguments');
  expect(s.ui.tui.hasOverlay()).toBe(false);
  expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]);
});

it('provides discoverable setup menus and makes model auth and service secrets available in the TUI', async () => {
  const s = await connected();
  expect(COMMANDS).toEqual(expect.arrayContaining(['setup', 'channels', 'settings', 'reload', 'mail', 'login', 'logout']));
  expect(HELP).toContain('/channels'); expect(HELP).toContain('/reload'); expect(HELP).not.toContain('/settings apply');
  const menu = s.ui.submit('/setup'); await s.see('Model API key'); await s.see('Gmail'); s.screen.input('\x1b'); await menu;
  const secret = s.ui.submit('/auth secret openai.mediaKey'); await s.see('openai.mediaKey — masked'); s.replace('fixture-media-secret'); s.screen.input('\r'); await secret;
  expect(await s.service.runtime.credentials.secret('openai.mediaKey')).toBe('fixture-media-secret');
  expect(s.screen.output).not.toContain('fixture-media-secret');
  await s.ui.submit('/auth accounts'); await s.ui.submit('/channels');
  await s.see('/channels telegram setup');
});

it('configures Google through generic extension setup with masked secrets and no conversation evidence',async()=>{
  const s=await connected(),secret='synthetic-extension-client-secret';
  const work=s.ui.submit('/integrations setup google');await s.see('google integration — JSON');s.screen.input('\r');
  await s.see('OAuth Desktop client secret');s.replace(secret);s.screen.input('\r');await s.see('Pub/Sub subscriber service-account JSON');s.screen.input('\r');await s.see('Save integration settings');s.screen.input('\r');await work;
  const manifest=await s.client.rpc<{settings:unknown}>('extensions.setup',{id:'google'});expect(manifest.settings).toEqual(defaultSettings());expect(await s.service.runtime.credentials.secret('extensions.google.clientSecret')).toBe(secret);expect(s.screen.output).not.toContain(secret);expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]);expect(s.faux.state.callCount).toBe(0);
});
it.each(['/integrations auth google', '/mail auth'])('keeps the complete browser sign-in URL clickable at narrow widths: %s', async command => {
  const s = await connected(), settings = defaultSettings('fixture-client');
  settings.docs.enabled = settings.calendar.enabled = true;
  settings.contacts = settings.drive = { enabled: true };
  settings.sheets = settings.tasks = { enabled: true, write: false };
  await s.client.rpc('extensions.configure', { id: 'google', settings });
  const capabilities = getCapabilities(); setCapabilities({ ...capabilities, hyperlinks: true });
  const rpc = s.client.rpc.bind(s.client); let login: { url: string } | undefined;
  const calls = vi.spyOn(s.client, 'rpc').mockImplementation(async (op, args) => {
    const result = await rpc(op, args);
    if (op === 'extensions.google.auth' || op === 'mail.auth') login = result as { url: string };
    return result;
  });
  try {
    await s.ui.submit(command);
    expect(new URL(login!.url).searchParams.get('scope')?.split(' ')).toEqual(googleScopes(settings));
    for (const width of [24, 45, 80]) {
      const lines = s.ui.transcript.render(width);
      const links = lines.flatMap(line => Array.from({ length: visibleWidth(line) }, (_, column) => getOsc8LinkAtColumn(line, column)).filter(Boolean));
      expect(links).toContain(login!.url);
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
      expect(lines.map(safeTerminal).join('\n')).not.toContain('scope=');
    }
    expect(calls.mock.calls.filter(([op]) => op.endsWith('.auth'))).toHaveLength(1);
    expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]);
    expect(s.faux.state.callCount).toBe(0);
  } finally { setCapabilities(capabilities); }
});

it.each(['javascript:alert(1)', 'http://accounts.google.com/login', 'https://accounts.google.com/?scope=o\npenid', 'https://accounts.google.com/\x1b]52;c;fixture\x07', 'https://user:secret@accounts.google.com/'])('refuses an unsafe integration sign-in URL without displaying it: %j', async url => {
  const rpc = vi.fn().mockResolvedValue({ url });
  const ui = new ChatUI({ rpc, close() {} } as unknown as Client, new Screen());
  try {
    await expect(ui.submit('/integrations auth google')).rejects.toThrow('Invalid integration sign-in URL');
    expect(ui.transcript.render(80).map(safeTerminal).join('\n')).not.toContain('accounts.google.com');
    expect(rpc).toHaveBeenCalledExactlyOnceWith('extensions.google.auth');
  } finally { ui.close(); }
});

it('reviews exact Google actions in the terminal, escapes bidi and defaults to rejection without sending',async()=>{
  const s=await connected(),settings=defaultSettings('synthetic-client');settings.mail.send=true;
  await s.client.rpc('extensions.configure',{id:'google',settings});
  s.service.runtime.store.run('INSERT INTO extension_storage(extension_id,key,value) VALUES(?,?,?)','google','identity',JSON.stringify({sub:'synthetic-account',email:'owner@example.test',email_verified:true,epoch:'test-epoch'}));
  await s.service.runtime.credentials.modify('gmail',async()=>({type:'oauth',access:'synthetic',refresh:'synthetic',expires:Date.now()+3600_000,scopes:googleScopes(settings)}));
  const prepared=await s.client.rpc<{action:{id:string}}>('extensions.google.mail',{action:'prepare_send',to:['safe@example.test'],subject:'Review',text:`${'Synthetic long text '.repeat(500)}\u202e visible`});
  const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected integration request')),work=s.ui.submit(`/integrations approve google ${prepared.action.id}`);await s.see('Review exact external action');await s.see('safe@example.test');await s.see('Reject action');for(let i=0;i<6;i++){s.screen.input('\x1b[6~');await new Promise(resolve=>setTimeout(resolve,15));}await s.see('\\u202e');s.screen.input('\r');await work;
  expect(await s.client.rpc('extensions.google.actions.review',{id:prepared.action.id})).toMatchObject({status:'rejected'});expect(fetch).not.toHaveBeenCalled();expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]);
});

it('sets up Gmail in the TUI with masked client secret, applies settings and opens read-only browser consent', async () => {
  const s = await connected(), secret = 'fixture-google-client-secret';
  const work = s.ui.submit('/mail setup'); await s.see('Google OAuth Desktop client ID'); s.replace('fixture-client.apps.googleusercontent.com'); s.screen.input('\r');
  await s.see('Optional Google client secret'); s.replace(secret); s.screen.input('\r');
  await s.see('Save read-only Gmail setup'); s.screen.input('\r'); await s.see('Apply saved settings now'); s.screen.input('\r'); await work;
  expect(loadConfig(s.root).config.gmail).toEqual({ clientId: 'fixture-client.apps.googleusercontent.com', intervalMs: 60_000, baselineMax: 200 });
  expect(await s.service.runtime.credentials.secret('gmail.clientSecret')).toBe(secret);
  expect(await s.client.rpc('mail.status')).toMatchObject({ authentication: 'pending' }); await s.see('accounts.google.com');
  expect(s.screen.output).not.toContain(secret); expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]);
  await expect(s.client.rpc('settings.apply')).rejects.toThrow('browser sign-ins');
  await s.client.rpc('mail.auth.cancel');
  await s.client.rpc('settings.apply'); expect(await s.client.rpc('mail.status')).toMatchObject({ authentication: 'idle' });
});

it('rejects persistent setup from ephemeral conversations before prompting or making RPC calls', async () => {
  const calls: string[] = [];
  const client = { rpc: async (op: string) => { calls.push(op); return []; }, close() {} } as unknown as Client;
  const ui = new ChatUI(client, new Screen()); (ui as any).session = { id: 'volatile', ephemeral: true };
  try {
    for (const command of ['/setup', '/channels telegram setup', '/settings', '/reload', '/auth key deepseek', '/auth secret telegram.token', '/auth select openai-api', '/auth chatgpt', '/auth codex', '/login openai-codex', '/logout deepseek', '/mail setup', '/mail auth', '/mail sync', '/integrations setup google', '/integrations auth google', '/integrations approve google synthetic-action']) await expect(ui.submit(command)).rejects.toThrow('Ephemeral mode');
    expect(calls).toEqual([]); expect(ui.tui.hasOverlay()).toBe(false);
  } finally { ui.close(); }
});

it('refuses backend reload during active work, preserves failed pending settings and keeps the daemon usable', async () => {
  const s = await connected(); reply(s.faux, 'A long response '.repeat(100));
  const run = await s.client.rpc<{ id: string }>('input', { requestId: 'busy-apply', conversationId: (await s.client.rpc<{ id: string }[]>('sessions'))[0]!.id, text: 'Continue' });
  await expect(s.client.rpc('settings.apply')).rejects.toThrow('active operations');
  await s.client.rpc('cancel', { id: run.id }); await waitFor(() => !s.service.runtime.hasPendingRuns);
  const original = s.service.runtime;
  await s.client.rpc('settings.update', { embeddings: { provider: 'local', model: 'wrong-local-model', dimensions: 384, maxScan: 100 } });
  await expect(s.client.rpc('settings.apply')).rejects.toThrow('remain pending');
  expect(s.service.runtime).toBe(original); expect(await s.client.rpc('channels.list')).toContainEqual({ id: 'terminal', destinations: ['terminal'] });
  await s.client.rpc('settings.update', { embeddings: null }); await s.client.rpc('settings.apply');
  expect(s.service.runtime).not.toBe(original); expect(s.service.runtime.store.config.embeddings).toBeUndefined();
});

it('never reflects a secret in setup error messages, even when the RPC fails with it', async () => {
  const s = await connected(), key = 'fixture-secret-in-upstream-error';
  const rpc = s.client.rpc.bind(s.client);
  vi.spyOn(s.client, 'rpc').mockImplementation((op, args) => { if (op === 'auth.respond') throw new Error(key); return rpc(op, args); });
  const work = s.ui.submit('/auth key deepseek'); await s.see('Enter DeepSeek API key'); s.replace(key); s.screen.input('\r');
  await expect(work).rejects.toThrow('Provider login failed');
  expect(s.screen.output).not.toContain(key); expect(s.ui.editor.disableSubmit).toBe(false);
});

it('preserves ephemeral mode on other connected TUIs when an owner applies settings', async () => {
  const s = await connected(); await selectLegacyEphemeral(s);
  const before = (s.ui as any).session.id;
  await s.client.rpc('settings.apply');
  await waitFor(() => (s.ui as any).session.id !== before);
  expect((s.ui as any).session.ephemeral).toBe(true);
  expect(s.service.runtime.sessions().some(session => session.id === before)).toBe(false);
});

it('permits Telegram token rotation but rejects another bot reusing existing inbox and receipt namespaces', async () => {
  const s = await connected();
  await s.client.rpc('secret.set', { name: 'telegram.token', value: '123456:original-token' });
  await s.client.rpc('settings.update', { telegram: { allowedSenders: [123], destination: 123 } }); await s.client.rpc('settings.apply');
  await s.client.rpc('secret.set', { name: 'telegram.token', value: '123456:rotated-token' });
  await expect(s.client.rpc('secret.set', { name: 'telegram.token', value: '654321:different-bot-token' })).rejects.toThrow('Changing Telegram bot identity');
  expect(await s.service.runtime.credentials.secret('telegram.token')).toBe('123456:rotated-token');
});

it('expires Gmail consent and prevents an old timeout from closing a newer browser sign-in', async () => {
  const s = setup(), login = new GmailLogin(s.runtime.credentials, 'fixture-client');
  cleanup.push(async () => { login.close(); await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); });
  vi.useFakeTimers(); await login.start(); await vi.advanceTimersByTimeAsync(60_000); login.close();
  expect(login.status).toBe('cancelled');
  await login.start(); await vi.advanceTimersByTimeAsync(540_000); expect(login.status).toBe('pending');
  await vi.advanceTimersByTimeAsync(60_000); expect(login.status).toBe('expired');
});

it('restores the previous runtime when a replacement adapter fails to start during settings application', async () => {
  const s = setup(); atomicWrite(join(s.root, 'config.json'), JSON.stringify(s.config));
  cleanup.push(async () => { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); });
  let starts = 0;
  const service = await serve(s.root, { runtimeFactory: store => new Runtime(store, s.runtime.models), channels: () => [{ id: 'fixture', start() { if (++starts === 2) throw new Error('Fixture start failed'); }, close() {} }] });
  cleanup.push(service.close); const client = new Client(s.root);
  const conversation = await client.rpc<{ id: string }>('new'); await client.rpc('settings.update', { timezone: 'UTC' });
  await expect(client.rpc('settings.apply')).rejects.toThrow('remain pending');
  expect(starts).toBe(3); expect(service.runtime.store.config.timezone).toBe('Europe/Rome'); expect(loadConfig(s.root).config.timezone).toBe('UTC');
  expect(await client.rpc('channels.list')).toContainEqual({ id: 'fixture', destinations: [] });
  reply(s.faux, 'Recovered backend'); const run = await client.rpc<{ id: string }>('input', { requestId: 'after-failed-apply', conversationId: conversation.id, text: 'Hello' });
  await waitFor(() => service.runtime.run(run.id).status === 'completed'); expect(service.runtime.run(run.id).partial).toBe('Recovered backend');
});

it('configures default DuckDuckGo without a key, search call or conversation entry', async () => {
  const s=await connected(),calls=vi.spyOn(s.client,'rpc'),setup=s.ui.submit('/setup');
  await s.see('Web search');for(let i=0;i<8;i++)s.screen.input('\x1b[B');s.screen.input('\r');
  await s.see('DuckDuckGo (default)');s.screen.input('\r');await s.see('Apply saved settings now');s.screen.input('\x1b[B');s.screen.input('\r');await setup;
  expect(calls).toHaveBeenCalledWith('settings.update',{search:{provider:'duckduckgo'}});
  expect(calls.mock.calls.some(([name])=>name==='secret.set')).toBe(false);expect(loadConfig(s.root).config.search).toEqual({provider:'duckduckgo'});
  expect(s.faux.state.callCount).toBe(0);expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]);expect(COMMANDS).not.toContain('web');expect(HELP).not.toContain('/web');
});

it('configures optional Brave through a masked vault dialog and applies the provider without testing it', async () => {
  const s=await connected(),calls=vi.spyOn(s.client,'rpc'),setup=s.ui.submit('/setup');
  await s.see('Web search');for(let i=0;i<8;i++)s.screen.input('\x1b[B');s.screen.input('\r');
  await s.see('DuckDuckGo (default)');s.screen.input('\x1b[B');s.screen.input('\r');await s.see('Brave Search API key');
  s.replace('synthetic-private-brave-key');s.ui.tui.renderNow(true);expect(s.screen.output).not.toContain('synthetic-private-brave-key');s.screen.input('\r');await s.see('Apply saved settings now');s.screen.input('\r');await setup;
  expect(calls).toHaveBeenCalledWith('secret.set',{name:'brave.searchKey',value:'synthetic-private-brave-key'});expect(s.service.runtime.store.config.search).toEqual({provider:'brave'});
  expect(await s.service.runtime.credentials.secret('brave.searchKey')).toBe('synthetic-private-brave-key');expect(s.faux.state.callCount).toBe(0);
  for(const table of ['messages','runs','web_sources'])expect(s.service.runtime.store.all(`SELECT * FROM ${table}`)).toEqual([]);
});

it('uses masked MCP credentials without chat/inference and rejects inline answers or ephemeral connections', async () => {
  const s = await connected();
  await s.client.rpc('extensions.configure', { id: 'mcp', settings: { servers: [{ id: 'fixture', enabled: false, transport: 'stdio', command: '/usr/bin/false' }] } });
  const secret = s.ui.submit('/mcp secret fixture'); await s.see('fixture: credential JSON');
  s.replace('{"env":{"OPERATOR_TOKEN":"synthetic-masked-mcp-token"}}'); s.ui.tui.renderNow(true);
  expect(s.screen.output).not.toContain('synthetic-masked-mcp-token'); s.screen.input('\r'); await secret;
  expect(await s.service.runtime.credentials.secret('extensions.mcp.fixture')).toContain('synthetic-masked-mcp-token');
  expect(s.service.runtime.store.all('SELECT * FROM messages')).toEqual([]); expect(s.faux.state.callCount).toBe(0);
  await expect(s.ui.submit('/mcp secret fixture inline-token')).rejects.toThrow('never inline');
  await expect(s.ui.submit('/mcp respond request inline-answer')).rejects.toThrow('never inline');
  await selectLegacyEphemeral(s);
  await expect(s.ui.submit('/mcp connect fixture')).rejects.toThrow('Ephemeral');
  await expect(s.ui.submit('/mcp catalog fixture')).rejects.toThrow('Ephemeral');
  await expect(s.ui.submit('/mcp respond pending')).rejects.toThrow('ephemeral');
});

it('cancels search setup without saving and rejects retired commands without sending inline keys', async () => {
  const s=await connected(),calls=vi.spyOn(s.client,'rpc'),setup=s.ui.submit('/setup');
  await s.see('Web search');for(let i=0;i<8;i++)s.screen.input('\x1b[B');s.screen.input('\r');
  await s.see('DuckDuckGo (default)');s.screen.input('\x1b');await setup;
  expect(calls.mock.calls.some(([name])=>name==='settings.update'||name==='secret.set')).toBe(false);
  for(const command of ['/web setup inline-key','/web brave synthetic-key'])await expect(s.ui.submit(command)).rejects.toThrow('Unknown command');
  await selectLegacyEphemeral(s);calls.mockClear();await expect(s.ui.submit('/setup')).rejects.toThrow('Ephemeral');await expect(s.ui.submit(`/web forget web:${crypto.randomUUID()}`)).rejects.toThrow('Unknown command');expect(calls).not.toHaveBeenCalled();
});
