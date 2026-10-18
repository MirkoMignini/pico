import { Container, Editor, Input, Image, Loader, Markdown, ProcessTerminal, ScrollView, SelectList, Text, TuiAltScreen, VStack, matchesKey, CombinedAutocompleteProvider, type Terminal, type Component, type Focusable, type MarkdownTheme, type TuiMouseEvent, truncateToWidth, visibleWidth, stripTerminalSequences } from '@earendil-works/pi-tui';
import { Client } from './client.js';
import { randomUUID } from 'node:crypto';
import { ConfigSchema, SettingsSchema, SECRET_NAMES, validate, type AuthProvider, type Config, type OutputEvent, type PicoChannel, type AssistantOutput, type ToolOutput } from './contracts.js';
import type { Run } from './runtime.js';
import type { ImageReference } from './images.js';
import type { AuthType } from '@earendil-works/pi-ai';
import { authEventText, loginProvider } from './auth-client.js';
import { McpCredentialsSchema, mcpSettings } from './mcp-contracts.js';
import { browserSettings, prepareBrowserDirectories, remoteBrowserSettings } from './mcp-browser.js';
import { ReadinessSchema, formatReadiness, type Readiness } from './readiness.js';
import { doctor, formatDoctor } from './doctor.js';

const color = (code: number | string) => (value: string) => {
  const prefix = `\x1b[${code}m`;
  return `${prefix}${value.replaceAll('\x1b[0m', `\x1b[0m${prefix}`)}\x1b[0m`;
};
const cyan = color(36), dim = color(90), bold = color(1);
const selectTheme = { selectedPrefix: cyan, selectedText: bold, description: dim, scrollInfo: dim, noMatch: dim };
const markdownTheme: MarkdownTheme = { heading: bold, link: cyan, linkUrl: dim, code: cyan, codeBlock: cyan, codeBlockBorder: dim, quote: dim, quoteBorder: dim, hr: dim, listBullet: cyan, bold, italic: color(3), strikethrough: color(9), underline: color(4) };
const PICO_LOGO = String.raw` ____  ___  ____  ___
|  _ \|_ _|/ ___|/ _ \
| |_) || || |   | | | |
|  __/ | || |___| |_| |
|_|   |___|\____|\___/`;
export function safeTerminal(text: string): string { return stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,''); }
const formatTokens = (count: number): string => count < 1000 ? String(count) : count < 1_000_000 ? `${Math.round(count / 1000)}k` : `${(count / 1_000_000).toFixed(1)}M`;
const THINKING_DESCRIPTIONS: Record<string, string> = { off: 'No reasoning', minimal: 'Very brief reasoning (~1k tokens)', low: 'Light reasoning (~2k tokens)', medium: 'Moderate reasoning (~8k tokens)', high: 'Deep reasoning (~16k tokens)', xhigh: 'Extra-high reasoning (~32k tokens)', max: 'Maximum reasoning' };
class DetailBox implements Component {
  collapsed = false;
  private complete = false;
  private toggled = false;
  constructor(public title: string, private body: Component, private readonly changed: () => void) {}
  update(title: string, body: Component, complete: boolean): void {
    this.title = title; this.body = body;
    if (!this.toggled && complete !== this.complete) this.collapsed = complete;
    this.complete = complete;
  }
  toggle(expanded = this.collapsed): void { this.collapsed = !expanded; this.toggled = true; this.changed(); }
  restore(previous: DetailBox): void { if (previous.toggled || previous.complete === this.complete) this.collapsed = previous.collapsed; this.toggled = previous.toggled; }
  invalidate(): void { this.body.invalidate(); }
  render(width: number): string[] {
    const label = `${this.collapsed ? '▶' : '▼'} ${this.title} · click to ${this.collapsed ? 'open' : 'collapse'}`;
    if (width < 4) return new Text(label,0,0).render(width);
    const innerWidth = width - 2, heading = truncateToWidth(`─ ${label} `,innerWidth,'');
    const bg = color('48;5;235');
    return [bg(dim(`┌${heading}${'─'.repeat(innerWidth-visibleWidth(heading))}┐`)),
      ...(!this.collapsed ? this.body.render(innerWidth).map(line => bg(`${dim('│')}${line}${' '.repeat(Math.max(0,innerWidth-visibleWidth(line)))}${dim('│')}`)) : []),
      bg(dim(`└${'─'.repeat(innerWidth)}┘`))];
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.y !== 0 || event.button !== 'left') return undefined;
    if (event.type === 'click') this.toggle();
    return event.type === 'press' || event.type === 'click' ? { handled: true } : undefined;
  }
}
const debugJson = (value: unknown) => safeTerminal(JSON.stringify(value, function(key, item) {
  return key === 'data' && this.type === 'image' && typeof item === 'string' ? `[image payload: ${item.length} base64 characters]` : item;
},2) ?? 'none');
function toolResultText(result: unknown): string {
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) return debugJson(result);
  const { content, ...metadata } = result;
  const text = content.map(block => block?.type === 'text' && typeof block.text === 'string' ? safeTerminal(block.text) : debugJson(block)).join('\n\n');
  const details = debugJson(metadata);
  return `${text}${details === '{}' ? '' : `\n\nMetadata\n${details}`}`;
}
export const COMMANDS = ['new','sessions','model','thinking','extensions','stop','help','auth','approve','skills','notifications','channels','telegram','setup','readiness','doctor','settings','reload','integrations','mcp','mail','backup','export','login','logout','quit'];
export const HELP = `**Pico** — Enter sends when idle (drafts stay editable while working) · ↑/↓ recalls sent messages · Alt+Enter inserts a line · Ctrl+O expands/collapses all debug boxes · Ctrl+T selects a box · click a box header to toggle · PgUp/PgDn scroll · Escape interrupts/cancels dialogs · /quit exits the client (daemon stays alive)

/new · /sessions [id] · /model [provider/id] · /model default provider/id · /thinking [level|Ctrl+S default]
/extensions [review approval-id|enable id|disable id|rollback id]
/skills [read name [path]|import path|enable name|disable name|delete name|rollback name version|approve id version hash]
Use $skill-name in chat to explicitly activate an installed skill. Drop standard packages in PRIVATE_INSTANCE/skills/NAME/SKILL.md, or ask Pico to create/import one. Prefer skills for calculators/utilities; extensions are for integrations and daemon lifecycle. Scripts run with OS-user access, not in a sandbox.
/approve approval-id artifact-hash (after reviewing exact code and permissions)
/setup · /readiness (local evidence, no probes) · /doctor (redacted local diagnostics) · /channels [telegram setup] · /telegram [status|check] · /settings [setting] · /reload
/login [provider] · /logout [provider] — Pi's built-in API-key/subscription setup
/auth [key provider|secret name|chatgpt|codex|accounts|select account|status|test]
/mcp [browser|browser-remote|setup|status|catalog|requests|actions] · /mcp [secret|connect|disconnect|pause|resume|auth|cancel|logout|ping] SERVER · /mcp [approve|respond] ID
/integrations [setup|auth|cancel|status|actions|approve|disconnect] ID · /mail [setup|auth|cancel|sync|rules] · /backup · /export · /notifications · /stop · /quit

Talk to Pico for memory, documents, notes, learning, workflows, appointments, reminders, web research and images. Routine changes and new extension builds need no confirmation; generated extensions run immediately with full OS access. Validation-only code and procedural approvals remain owner controls. Commands are only for chat controls, setup and safety/administration. Operator CLI/RPC remains available for advanced data recovery.

Setup uses separate dialogs; secrets are masked and never sent to the assistant. /reload applies saved settings without leaving the TUI.

Chats retain conversation history and evidence. Starting a new chat does not erase existing memory. Providers/Telegram/OS have separate retention.`;
interface Session { id: string; title: string; model: string; ephemeral: boolean }
export class ChatUI implements PicoChannel {
  readonly id = 'terminal';
  readonly tui: TuiAltScreen; readonly transcript = new Container(); readonly header = new Text('',1,0); readonly footer = new Text('',1,0); readonly editor: Editor;
  private session?: Session; private runId?: string; private live?: AssistantOutput; private unsubscribe?: () => void; private closed = false; private reconnecting = false;
  private assistantBlocks = new Map<string, Container>();
  private detailBoxes = new Map<string, DetailBox>();
  private toolBlocks = new Map<string, { output: ToolOutput; box: DetailBox; runId: string }>();
  private readonly scrollView = new ScrollView(this.transcript,{follow:'end',primary:true});
  private imageBlocks = new Map<string, {block:Container;bytes:number;loading:boolean}>();
  private footerStatuses = new Map<string, string>();
  private thinkingLevel = 'off';
  private context?: { tokens: number | null; contextWindow: number };
  private readonly editorArea = new Container();
  private readonly activityArea = new Container();
  private loader?: Loader;
  private inputPending = false;
  private readonly mainLayout: VStack;
  private introVisible = true;
  private readonly intro = new Text(`${PICO_LOGO.split('\n').map(line => cyan(bold(line))).join('\n')}\n\n${dim('A small assistant for the things that matter.')}`,1,1);
  private readonly introTips = new Text(`${cyan('/setup')} get started · ${cyan('/model')} choose model · ${cyan('/new')} start fresh\n${dim('Enter sends · Esc interrupts · /quit detaches')}`,1,1);
  private setupBusy = false;
  private cancelDialog?: () => void;
  private loginController?: AbortController;
  private seenSettled = new Set<string>();
  constructor(readonly client: Client, terminal: Terminal = new ProcessTerminal()) {
    this.tui = new TuiAltScreen(terminal);
    this.editor = new Editor(this.tui,{ borderColor: cyan, selectList: selectTheme },{paddingX:1});
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS.map(name => ({name,description: name})), '/nonexistent-pico-client-files'));
    this.editor.onSubmit = text => { this.editor.setText(''); void this.submit(text).catch(error => this.notice(`**Error**\n${error instanceof Error ? error.message : 'Operation failed'}`)); };
    this.editorArea.addChild(this.editor);
    const showIntro = ({width,height}: {width:number;height:number}) => this.introVisible && width >= 60 && height >= 24;
    this.mainLayout=new VStack([
      {component:this.intro,basis:'auto',shrink:0,visible:showIntro},
      {component:this.header,basis:'auto'},
      {component:this.introTips,basis:'auto',shrink:0,visible:showIntro},
      {component:this.scrollView,basis:0,grow:1,minSize:1},
      {component:this.activityArea,basis:'auto',shrink:0},
      {component:this.editorArea,basis:'auto',minSize:2,shrink:0},
      {component:this.footer,basis:'auto'}
    ]);
    this.tui.setLayoutRoot(this.mainLayout);
    this.tui.setFocus(this.editor);
    this.tui.addInputListener(data => {
      if (!this.cancelDialog && !this.loginController && (matchesKey(data,'ctrl+o') || matchesKey(data,'ctrl+t'))) {
        const boxes = [...this.detailBoxes.values()];
        if (matchesKey(data,'ctrl+o')) { const expand = boxes.some(box => box.collapsed); for (const box of boxes) box.toggle(expand); }
        else if (boxes.length) void this.choose(boxes.map((box,index) => ({value:String(index),label:`${box.collapsed ? '▶' : '▼'} ${box.title}`})),undefined,'Inspect a debug box').then(choice => {
          if (choice !== undefined) { const box = boxes[Number(choice)]!; box.toggle(); this.revealBox(box); }
        });
        return {consume:true};
      }
      if (matchesKey(data,'escape') || matchesKey(data,'ctrl+c')) {
        if (this.cancelDialog) { this.cancelDialog(); return {consume:true}; }
        if (this.loginController) { this.loginController.abort(); return {consume:true}; }
        if (this.runId) { void this.client.rpc('cancel',{id:this.runId}).catch(() => {}); return {consume:true}; }
      }
      return undefined;
    });
  }
  async start(): Promise<void> {
    await this.client.ensureDaemon();
    const sessions = await this.client.rpc<Session[]>('sessions'); this.session = sessions.find(s => !s.ephemeral) ?? await this.client.rpc<Session>('new');
    await this.loadHistory(); await this.refresh(); await this.connect(); this.tui.start();
  }
  private notice(text: string, userMessage = false): void { if (this.closed) return; this.transcript.addChild(new Markdown(safeTerminal(text),1,1,markdownTheme,userMessage ? {color:color(97),bgColor:color('48;5;236')} : undefined)); this.tui.requestRender(); }
  private detailBox(key: string, title: string, body: Component, complete: boolean): DetailBox {
    let box = this.detailBoxes.get(key);
    if (!box) { box = new DetailBox(title,body,() => { this.scrollView.scrollTo(this.scrollView.scrollTop,{disableFollow:true}); this.tui.requestRender(); }); this.detailBoxes.set(key,box); }
    box.update(title,body,complete); return box;
  }
  private revealBox(target: DetailBox): void {
    let row = 0;
    const find = (component: Component): boolean => {
      if (component === target) return true;
      if (component instanceof Container) { for (const child of component.children) if (find(child)) return true; }
      else row += component.render(this.scrollView.getContentWidth(this.tui.terminal.columns)).length;
      return false;
    };
    if (find(this.transcript)) this.scrollView.scrollTo(row,{disableFollow:true});
    this.tui.requestRender();
  }
  private showAssistant(output: AssistantOutput, runId?: string): void {
    let block = this.assistantBlocks.get(output.id);
    if (!block) {
      if (!output.text && !output.thinking && !output.rejectedDraft && !output.tools?.length) return;
      block = new Container(); this.assistantBlocks.set(output.id, block); this.transcript.addChild(block);
    }
    block.clear();
    const key = `Thinking:${output.id}`;
    if (output.thinking || output.rejectedDraft) {
      const body = new Container();
      if (output.thinking) body.addChild(new Markdown(safeTerminal(output.thinking),1,1,markdownTheme,{color:color('38;5;250'),italic:true}));
      if (output.rejectedDraft) body.addChild(new Text(`Rejected draft · inspection only\n\n${safeTerminal(output.rejectedDraft)}`,1,1));
      const title = `Thinking · ${output.rejectedDraft ? 'rejected / unverified · ' : ''}not a final answer${output.complete ? output.intermediate && !output.tools?.length ? ' · incomplete' : '' : ' · streaming'}`;
      block.addChild(this.detailBox(key,title,body,output.complete));
    } else this.detailBoxes.delete(key);
    if (output.text) block.addChild(new Markdown(safeTerminal(output.text),1,1,markdownTheme));
    for (const tool of output.tools ?? []) this.showTool(tool,runId);
    this.tui.requestRender();
  }
  private showTool(output: ToolOutput, runId = 'history'): void {
    const key = `tool:${runId}:${output.id}`, previous = this.toolBlocks.get(key);
    // A recovered call declaration must not downgrade its already received result.
    if (output.state === 'tool_call' && previous && !output.incomplete) return;
    output = { ...previous?.output, ...output, incomplete: !!output.incomplete };
    const done = output.state === 'tool_execution_end' || !!output.incomplete;
    const state = output.incomplete ? 'incomplete · outcome not confirmed' : output.error ? 'failed' : output.state === 'tool_execution_end' ? 'done' : output.state === 'tool_call' ? 'pending' : 'working';
    const body = new Text(`Call ${safeTerminal(output.id)}\n\nArguments\n${debugJson(output.args)}${output.result === undefined ? '' : `\n\n${done ? 'Result' : 'Partial result'}\n${toolResultText(output.result)}`}`,1,1);
    const box = this.detailBox(key,`Tool ${safeTerminal(output.tool)} · ${state}${output.durationMs === undefined ? '' : ` · ${Math.round(output.durationMs)} ms`}`,body,done);
    this.toolBlocks.set(key,{output,box,runId});
    if (!previous) this.transcript.addChild(box);
    this.tui.requestRender();
  }
  private finishTools(runId?: string): void {
    for (const {output,runId:toolRunId} of this.toolBlocks.values()) if ((!runId || toolRunId === runId) && output.state !== 'tool_execution_end') this.showTool({...output,incomplete:true},toolRunId);
  }
  private async showImage(reference: ImageReference): Promise<void> {
    const key=reference.attachmentId??`document:${reference.documentId}:r${reference.revision}`,previous=this.imageBlocks.get(key);
    if(previous?.bytes||previous?.loading)return;
    const sessionId=this.session?.id,entry=previous??{block:new Container(),bytes:0,loading:false};
    entry.loading=true;entry.block.clear();
    if(!previous){this.imageBlocks.set(key,entry);this.transcript.addChild(entry.block);}
    try {
      const image=await this.client.rpc<{data:string;mime:string;name:string;bytes:number;synthetic:boolean}>('images.preview',reference);
      if(this.closed||this.session?.id!==sessionId||this.imageBlocks.get(key)!==entry)return;
      if(!Number.isSafeInteger(image.bytes)||image.bytes<=0||image.bytes>20_000_000||!['image/png','image/jpeg','image/gif','image/webp'].includes(image.mime))throw new Error('Image preview exceeds limits');
      let cachedBytes=[...this.imageBlocks.values()].reduce((sum,item)=>sum+item.bytes,0);
      for(const [id,preview] of this.imageBlocks) {
        if(cachedBytes+image.bytes<=20_000_000)break;
        if(preview===entry||!preview.bytes)continue;
        cachedBytes-=preview.bytes;preview.block.clear();preview.block.addChild(new Text(`Image ${id} · preview not cached; reopen this conversation`,1,1));preview.bytes=0;
      }
      entry.block.addChild(new Text(`${image.synthetic?'Generated image · synthetic, not factual evidence':'Image · saved original (not verified evidence)'}\n${safeTerminal(image.name)}\n${key}`,1,1));
      entry.block.addChild(new Image(image.data,image.mime,{fallbackColor:dim},{filename:safeTerminal(image.name),maxWidthCells:60,maxHeightCells:18}));entry.bytes=image.bytes;
    } catch { if(!this.closed&&this.session?.id===sessionId&&this.imageBlocks.get(key)===entry)entry.block.addChild(new Text(`Image ${key} unavailable/expired`,1,1)); }
    finally {entry.loading=false;}
    this.tui.requestRender();
  }
  private async loadImages(runId?: string): Promise<void> {
    const conversationId=this.session?.id;
    try {
      if(!conversationId)return;
      const result=await this.client.rpc<{images:ImageReference[]}>('images.previews',{conversationId, ...(runId?{runId}:{})});
      if(this.session?.id!==conversationId||this.closed)return;
      for(const image of result.images)await this.showImage(image);
    } catch { /* History remains available when image inspection fails. */ }
  }
  private async refresh(): Promise<void> {
    if (this.closed) return;
    const status = await this.client.rpc<{ ownerName:string; ownerId:string; instanceId:string; model:{authentication:string;provider:string;model:string}; activeRuns:string[]; extensionsExecution?:{mode:string}; extensionStatus?:Record<string,string> }>('status');
    const selected=JSON.parse(this.session?.model??'{}');const capabilities=await this.client.rpc<{authentication:string}>('model.capabilities',{provider:selected.provider??status.model.provider,id:selected.id??status.model.model});
    this.context = this.session ? await this.client.rpc<{tokens:number|null;contextWindow:number}>('context.usage',{conversationId:this.session.id}) : undefined;
    if (this.session) this.thinkingLevel = (await this.client.rpc<{level:string}>('thinking.get',{conversationId:this.session.id})).level;
    this.header.setText(`${cyan('PICO')}  assistant  ·  owner ${bold(safeTerminal(status.ownerName).slice(0,120))} (${status.ownerId.slice(0,8)})  ·  instance ${status.instanceId.slice(0,8)}\n${this.session?.ephemeral ? 'EPHEMERAL · volatile · lost on restart' : 'Retained session'} ${this.session?.id.slice(0,8)} · ${capabilities.authentication}${status.extensionsExecution?.mode === 'in-process' ? '\n' + bold('TRUSTED EXTENSIONS / SKILL SCRIPTS · full OS-user access') : ''}`);
    if (!this.runId) for (const id of status.activeRuns) { const run=await this.client.rpc<Run>('run',{id});if(run.conversation_id===this.session?.id&&['queued','running'].includes(run.status)){this.runId=run.id;this.live=run.display??{id:`partial:${run.id}`,text:run.partial,thinking:'',intermediate:true,complete:false};this.showAssistant(this.live,run.id);for(const tool of run.tools??[])this.showTool(tool,run.id);break;} }
    this.footerStatuses = new Map(Object.entries(status.extensionStatus ?? {}));
    this.updateFooter(); this.updateActivity();
  }
  private updateActivity(): void {
    const working = !this.closed && (!!this.runId || this.inputPending);
    this.editor.disableSubmit = working || this.setupBusy;
    if (working && !this.loader) {
      this.loader = new Loader(this.tui,cyan,dim,'Working… · Esc interrupts · sending paused');
      this.activityArea.addChild(this.loader);
    } else if (!working && this.loader) {
      this.loader.stop(); this.loader = undefined; this.activityArea.clear();
    }
    this.tui.requestRender();
  }
  private updateFooter(): void {
    const statuses = [...this.footerStatuses].sort(([a],[b]) => a.localeCompare(b)).map(([key,text]) => safeTerminal(`${key}: ${text}`));
    this.footer.setText(dim([this.modelLine(), ...statuses].join('\n'))); this.tui.requestRender();
  }
  private modelLine(): string {
    const selection = JSON.parse(this.session?.model ?? '{}') as { provider?: string; id?: string };
    const name = selection.provider && selection.id ? `${selection.provider}/${selection.id}` : 'no model';
    const context = !this.context?.contextWindow ? '' : this.context.tokens === null ? `context ?/${formatTokens(this.context.contextWindow)}` : `context ${formatTokens(Math.max(0, this.context.contextWindow - this.context.tokens))} left of ${formatTokens(this.context.contextWindow)}`;
    return [name, `thinking ${this.thinkingLevel}`, context].filter(Boolean).join('  ·  ');
  }
  private async refreshContext(): Promise<void> {
    const conversationId = this.session?.id;
    if (!conversationId || this.closed) return;
    try {
      const context = await this.client.rpc<{tokens:number|null;contextWindow:number}>('context.usage',{conversationId});
      if (!this.closed && this.session?.id === conversationId) { this.context = context; this.updateFooter(); }
    } catch { /* Keep the last known estimate when context reading is unavailable. */ }
  }
  private async setThinking(level: string, persist: boolean): Promise<void> {
    const result = await this.client.rpc<{level:string}>('thinking.set',{conversationId:this.session!.id,level,persist});
    this.thinkingLevel = result.level; this.updateFooter();
  }
  private async loadHistory(): Promise<void> {
    const history = await this.client.rpc<{ role:string; run_id?:string; text?:string; display?:AssistantOutput; tool?:ToolOutput; content?:string|{type:string;text?:string}[] }[]>('history',{conversationId:this.session!.id});
    const previousBoxes = new Map(this.detailBoxes);
    this.transcript.clear(); this.assistantBlocks.clear(); this.detailBoxes.clear(); this.toolBlocks.clear(); this.imageBlocks.clear(); this.live = undefined;
    for (const row of history) {
      const text = row.text ?? (typeof row.content === 'string' ? row.content : row.content?.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n') ?? '');
      if (row.role === 'assistant' && row.display) this.showAssistant(row.display,row.run_id);
      else if (row.role === 'toolResult' && row.tool) this.showTool(row.tool,row.run_id);
      else if (row.role === 'user' || row.role === 'assistant') this.notice(text, row.role === 'user');
    }
    this.finishTools();
    for (const [key,box] of this.detailBoxes) { const previous = previousBoxes.get(key); if (previous) box.restore(previous); }
    if (!history.length) this.notice('Your personal assistant. Ask naturally, or type /help.');
    await this.loadImages();
  }
  private connect(): Promise<void> {
    this.unsubscribe?.();
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Event connection timed out')),5000);
      this.unsubscribe=this.client.subscribe(this.onOutput,()=>{clearTimeout(timeout);reject(new Error('Event connection lost'));void this.reconnect();},()=>{clearTimeout(timeout);resolve();});
    });
  }
  private async reconnect(): Promise<void> {
    if (this.closed || this.reconnecting) return; this.reconnecting = true;
    while (!this.closed) {
      await new Promise(resolve => setTimeout(resolve,1000));
      try {
        await this.connect(); await this.loadHistory(); await this.refresh();
        if (this.runId) { const run = await this.client.rpc<Run>('run',{id:this.runId}); if (!['queued','running'].includes(run.status)) this.onOutput({type:'settled',runId:run.id,conversationId:run.conversation_id,data:{status:run.status,text:run.partial,error:run.error,display:run.display}}); else { if (run.display) { this.live = run.display; this.showAssistant(run.display,run.id); } for (const tool of run.tools??[]) this.showTool(tool,run.id); } }
        break;
      } catch {}
    }
    this.reconnecting = false;
  }
  onOutput = (event: OutputEvent): void => {
    if (this.closed) return;
    if (event.type === 'status' && (event.data as { settingsApplied?: boolean }).settingsApplied) {
      void this.afterApply().catch(() => this.notice('Settings applied; reconnect or reselect your session if it is unavailable.')); return;
    }
    if (event.type === 'diagnostic') { this.transcript.addChild(new Text(`Diagnostic\n${debugJson(event.data)}`,1,1)); this.tui.requestRender(); return; }
    if (event.type === 'extension_status') { const data = event.data as {key:string;text:string|null}; if (data.text === null) this.footerStatuses.delete(data.key); else this.footerStatuses.set(data.key,data.text); this.updateFooter(); return; }
    if (event.type === 'notification') { const n = event.data as {text:string}; this.notice(`**Background notification**\n${n.text}`); return; }
    if (event.conversationId !== this.session?.id || (this.runId && event.runId !== this.runId)) return;
    if (event.type === 'accepted' && event.runId) { this.runId = event.runId; this.updateActivity(); return; }
    if (event.type === 'image') { const {attachmentId,documentId,revision}=event.data as ImageReference;void this.showImage(attachmentId?{attachmentId}:{documentId:documentId!,revision:revision!}); return; }
    if (event.type === 'assistant') { this.live = event.data as AssistantOutput; this.showAssistant(this.live,event.runId); }
    if (event.type === 'delta' && (!this.live || this.live.id.startsWith('partial:'))) { this.live = { id:`partial:${event.runId}`, text:(event.data as {partial:string}).partial, thinking:'', intermediate:true, complete:false }; this.showAssistant(this.live,event.runId); }
    if (event.type === 'tool') { const data = event.data as ToolOutput; this.showTool(data,event.runId); }
    if (event.type === 'settled') {
      if (event.runId && this.seenSettled.has(event.runId)) return;
      if (event.runId) {this.seenSettled.add(event.runId);if(this.seenSettled.size>20)this.seenSettled.delete(this.seenSettled.values().next().value!);}
      const result = event.data as {status:string;text:string;error?:string;display?:AssistantOutput};
      const output = result.display ?? this.live ?? { id:`partial:${event.runId}`, text:'', thinking:'', intermediate:true, complete:false };
      this.showAssistant({ ...output, text:`${result.text}${result.status === 'completed' ? '' : `\n[${result.status}: ${result.error ?? 'partial response'}]`}`, intermediate:result.status !== 'completed', complete:true },event.runId);
      this.finishTools(event.runId);
      if (result.status !== 'completed') this.notice(`**${result.status} · incomplete response**\n${result.error ?? 'Partial response; accepted tool effects are not undone.'}`);
      void this.loadImages(event.runId);
      this.live = undefined; this.runId = undefined; this.updateActivity(); void this.refreshContext();
    }
  };
  private choose(items: {value:string;label:string;description?:string}[], signal?: AbortSignal, question = 'Choose an option', onDefault?: (value: string) => void | Promise<void>): Promise<string|undefined> {
    if (this.closed || signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      let visible = 12, list = new SelectList(items,visible,selectTheme), listRow = 0;
      const title = new Text(bold(safeTerminal(question)),1,0), hint = new Text(dim(onDefault ? '↑↓ choose · Enter sets session · Ctrl+S sets default · Esc cancels' : '↑↓ choose · Enter confirms · Esc cancels'),1,0);
      const finish = (value?: string, asDefault = false) => {
        signal?.removeEventListener('abort', cancel); this.cancelDialog = undefined;
        this.editorArea.clear(); this.editorArea.addChild(this.editor); this.tui.setFocus(this.editor); this.tui.requestRender();
        if (value !== undefined && asDefault && onDefault) Promise.resolve(onDefault(value)).then(() => resolve(value), reject);
        else resolve(value);
      };
      const cancel = () => finish(); signal?.addEventListener('abort', cancel, { once: true });
      const dialog: Component = {
        render: width => {
          const heading = title.render(width), hints = hint.render(width);
          // Reserve one transcript row and one list scroll-indicator row.
          const nextVisible = Math.min(12,Math.max(1,this.tui.terminal.rows - this.header.render(width).length - this.footer.render(width).length - heading.length - hints.length - 2));
          if (nextVisible !== visible) {
            const selected = items.indexOf(list.getSelectedItem()!);
            visible = nextVisible; list = new SelectList(items,visible,selectTheme); list.setSelectedIndex(selected);
            list.onSelect = item => finish(item.value); list.onCancel = cancel;
          }
          listRow = heading.length; return [...heading,...list.render(width),...hints];
        },
        invalidate() { title.invalidate(); list.invalidate(); hint.invalidate(); },
        handleInput(data) { if (onDefault && matchesKey(data, 'ctrl+s')) { const item = list.getSelectedItem(); if (item) finish(item.value, true); return; } list.handleInput(data); },
        handleMouse(event) { return list.handleMouse({ ...event, y: event.y - listRow }); }
      };
      this.cancelDialog = cancel; list.onSelect = item => finish(item.value); list.onCancel = cancel;
      this.editorArea.clear(); this.editorArea.addChild(dialog); this.tui.setFocus(dialog); this.tui.requestRender();
    });
  }
  private prompt(label: string, options: { secret?: boolean; value?: string; required?: boolean; maxLength?: number; signal?: AbortSignal; check?: (value: string) => void } = {}): Promise<string | undefined> {
    if (this.closed || options.signal?.aborted) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const input = new class extends Input {
        render(width: number): string[] {
          if (!options.secret) return super.render(width);
          const value = this.getValue(); this.setValue('*'.repeat(value.length));
          try { return super.render(width); } finally { this.setValue(value); }
        }
      }();
      input.setValue(options.value ?? ''); input.handleInput('\x05');
      const title = new Text(bold(safeTerminal(label)), 1, 0), hint = new Text(dim('Enter confirms · Esc cancels'), 1, 0);
      let inputRow = 0;
      const dialog: Component & Focusable = {
        get focused() { return input.focused; }, set focused(value) { input.focused = value; },
        render(width) { const heading = title.render(width); inputRow = heading.length; return [...heading, ...input.render(width), ...hint.render(width)]; },
        invalidate() { title.invalidate(); input.invalidate(); hint.invalidate(); },
        handleInput(data) { input.handleInput(data); },
        handleMouse(event) { return input.handleMouse({ ...event, y: event.y - inputRow }); }
      };
      const finish = (value?: string) => {
        options.signal?.removeEventListener('abort', cancel); input.setValue(''); this.cancelDialog = undefined;
        this.editorArea.clear(); this.editorArea.addChild(this.editor); this.tui.setFocus(this.editor); this.tui.requestRender(); resolve(value);
      };
      const cancel = () => finish(); options.signal?.addEventListener('abort', cancel, { once: true });
      this.cancelDialog = cancel; input.onEscape = cancel;
      input.onSubmit = raw => {
        const value = raw.trim();
        try {
          if (value.length > (options.maxLength ?? 4000) || options.required && !value) throw new Error('Required value is missing or too long');
          options.check?.(value); finish(value);
        } catch { hint.setText('Invalid value. Check the requested format and try again · Esc cancels'); this.tui.requestRender(); }
      };
      this.editorArea.clear(); this.editorArea.addChild(dialog); this.tui.setFocus(dialog); this.tui.requestRender();
    });
  }
  private editJson(label: string, value: unknown): Promise<unknown | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const editor = new Editor(this.tui, { borderColor: cyan, selectList: selectTheme });
      editor.setText(JSON.stringify(value, null, 2));
      const title = new Text(`${safeTerminal(label)} — JSON, no secrets. Enter saves · Alt+Enter newline · Esc cancels`, 1, 0);
      let editorRow = 0;
      const dialog: Component & Focusable = {
        get focused() { return editor.focused; }, set focused(value) { editor.focused = value; },
        render(width) { const heading = title.render(width); editorRow = heading.length; return [...heading, ...editor.render(width)]; },
        invalidate() { title.invalidate(); editor.invalidate(); }, handleInput(data) { editor.handleInput(data); },
        handleMouse(event) { return editor.handleMouse({ ...event, y: event.y - editorRow }); }
      };
      const finish = (result?: unknown) => {
        editor.setText(''); this.cancelDialog = undefined;
        this.editorArea.clear(); this.editorArea.addChild(this.editor); this.tui.setFocus(this.editor); this.tui.requestRender(); resolve(result);
      };
      this.cancelDialog = () => finish();
      editor.onSubmit = text => {
        try { if (text.length > 100_000) throw new Error(); finish(JSON.parse(text)); }
        catch { title.setText('Invalid JSON or too long. Correct it and press Enter · Esc cancels'); this.tui.requestRender(); }
      };
      this.editorArea.clear(); this.editorArea.addChild(dialog); this.tui.setFocus(dialog); this.tui.requestRender();
    });
  }
  async submit(text: string): Promise<void> {
    if (!text.trim()) return;
    if (this.setupBusy || this.cancelDialog) throw new Error('Finish or cancel the current dialog before submitting another command');
    if (this.introVisible) { this.introVisible = false; this.tui.requestRender(); }
    if (text.startsWith('/')) { await this.command(text); return; }
    if (this.runId || this.inputPending) throw new Error('A turn is active. Cancel it or wait before submitting another.');
    this.notice(text, true); this.inputPending = true; this.updateActivity();
    const requestId = randomUUID();
    try { const run = await this.client.rpc<Run>('input',{requestId,conversationId:this.session!.id,text}); await this.watchReceipt(run); }
    catch (error) {
      // Do not replay a request whose durable acknowledgment was lost.
      const run = await this.client.rpc<Run|null>('input.receipt',{requestId}).catch(() => null);
      if (run) { this.notice('Input was accepted despite lost acknowledgment; watching its run without replay.');await this.watchReceipt(run); }
      else throw error;
    } finally { this.inputPending = false; this.updateActivity(); }
    this.editor.addToHistory(text);
  }
  private async watchReceipt(run:Run):Promise<void>{
    if(this.seenSettled.has(run.id)){this.runId=undefined;this.updateActivity();return;}
    this.runId=run.id;this.updateActivity();
    const current=await this.client.rpc<Run>('run',{id:run.id});
    if(this.runId===run.id&&!['running','queued'].includes(current.status))this.onOutput({type:'settled',runId:run.id,conversationId:run.conversation_id,data:{status:current.status,text:current.partial,error:current.error,display:current.display}});
  }
  private async command(text: string): Promise<void> {
    const [name,...rest] = text.trim().split(' '), arg = rest.join(' ').trim();
    const show = async (op:string,args:Record<string,unknown>={}) => this.notice(`\`\`\`json\n${JSON.stringify(await this.client.rpc(op,args),null,2)}\n\`\`\``);
    if (name === '/quit') { this.close(); return; }
    if (name === '/help') { this.notice(HELP); return; }
    if (name === '/readiness') { if (arg) throw new Error('Use /readiness without arguments'); await this.showReadiness(); return; }
    if (name === '/doctor') { if (arg) throw new Error('Use /doctor without arguments'); this.notice(formatDoctor(await doctor(this.client.root))); return; }
    if (name === '/setup') { if (arg) throw new Error('Use /setup without arguments'); await this.configure(() => this.setupMenu()); return; }
    if (name === '/login' || name === '/logout') {
      if (arg && !/^[a-z0-9-]{1,80}$/.test(arg)) throw new Error('Use /login or /logout with only a provider ID; never inline credentials');
      await this.configure(() => name === '/login' ? this.login(arg || undefined) : this.logout(arg || undefined)); return;
    }
    if (name === '/channels') {
      if (!arg) { await show('channels.list'); this.notice('Configure Telegram with /channels telegram setup. Only registered channels are listed above.'); return; }
      if (arg !== 'telegram setup') throw new Error('Use /channels telegram setup. Never put a token in a command.');
      await this.configure(() => this.telegramSetup()); return;
    }
    if (name === '/telegram') {
      if (!arg || arg === 'status') await show('telegram.status');
      else if (arg === 'check') await this.configure(() => show('telegram.check'));
      else throw new Error('Use /telegram status|check; never inline credentials'); return;
    }
    if (name === '/settings') { await this.configure(() => this.editSetting(arg)); return; }
    if (name === '/reload') { if (arg) throw new Error('Use /reload without arguments'); await this.configure(() => this.applySettings()); return; }
    if (name === '/mcp') {
      const [action = 'status', value, ...extra] = arg ? arg.split(/\s+/) : [];
      if (extra.length) throw new Error('Use /mcp ACTION [SERVER_OR_ID]; never inline credentials or approval answers');
      if (action === 'browser-remote' && !value) await this.configure(() => this.remoteBrowserSetup());
      else if (action === 'browser' && !value) await this.configure(() => this.browserSetup());
      else if (action === 'setup' && !value) await this.configure(() => this.integrationSetup('mcp'));
      else if (action === 'secret' && value) await this.configure(() => this.mcpSecret(value));
      else if (action === 'approve' && value) await this.configure(() => this.integrationApproval('mcp', value));
      else if (action === 'respond' && value) await this.mcpRespond(value);
      else if (action === 'auth' && value) await this.configure(() => this.integrationLogin('extensions.mcp.auth', { server: value }));
      else if (action === 'catalog') await this.configure(() => show('extensions.mcp.catalog', value ? { server: value } : {}));
      else if (!value && ['status', 'requests', 'actions'].includes(action)) await show(`extensions.mcp.${action === 'actions' ? 'actions.list' : action}`);
      else if (value && ['connect', 'disconnect', 'pause', 'resume', 'cancel', 'logout', 'ping'].includes(action)) await this.configure(() => show(`extensions.mcp.${action === 'cancel' ? 'auth.cancel' : action}`, { server: value }));
      else throw new Error('Use /mcp browser|browser-remote|setup|status|catalog|requests|actions, /mcp secret|connect|disconnect|pause|resume|auth|cancel|logout|ping SERVER, or /mcp approve|respond ID');
      return;
    }
    if (name === '/integrations') {
      const [action,moduleId,actionId,...extra]=arg.split(/\s+/);
      if(!arg){const modules=await this.client.rpc<{id:string;setup?:boolean}[]>('extensions.list');this.notice(modules.filter(module=>module.setup).map(module=>`${module.id}: /integrations setup ${module.id}`).join('\n')||'No enabled extension provides integration setup');return;}
      if(extra.length||!moduleId||!/^[a-z][a-z0-9-]{2,47}$/.test(moduleId))throw new Error('Use /integrations setup|auth|cancel|status|actions|approve|disconnect ID; never inline credentials');
      if(action==='setup'&&!actionId)await this.configure(()=>this.integrationSetup(moduleId));
      else if(action==='approve'&&actionId)await this.configure(()=>this.integrationApproval(moduleId,actionId));
      else if(action==='auth'&&!actionId)await this.configure(()=>this.integrationLogin(`extensions.${moduleId}.auth`));
      else if(!actionId&&['cancel','status','actions','disconnect'].includes(action!))await this.configure(()=>show(`extensions.${moduleId}.${action==='cancel'?'auth.cancel':action==='actions'?'actions.list':action}`));
      else throw new Error('Use /integrations approve EXTENSION ACTION_ID or /integrations setup|auth|cancel|status|actions|disconnect EXTENSION');return;
    }
    if (name === '/mail') {
      if (arg === 'setup') await this.configure(() => this.gmailSetup());
      else if (arg === 'auth') await this.configure(() => this.integrationLogin('mail.auth'));
      else if (arg === 'sync') await this.configure(() => show('mail.sync'));
      else if (arg === 'cancel') await show('mail.auth.cancel');
      else if (arg === 'rules') await show('mail.rules');
      else throw new Error('Use /mail setup|auth|cancel|sync|rules'); return;
    }
    if (name === '/backup' || name === '/export') { await show(name.slice(1)); return; }
    if (name === '/stop') { await show('cancel',this.runId ? {id:this.runId} : {}); return; }
    if (name === '/new') {
      if (arg) throw new Error('Use /new without arguments to start a normal saved chat');
      this.session = await this.client.rpc<Session>('new'); this.runId = undefined; this.live = undefined; this.updateActivity(); await this.loadHistory(); await this.refresh(); return;
    }
    if (name === '/sessions') {
      const sessions = await this.client.rpc<Session[]>('sessions'); const selected = arg || await this.choose(sessions.map(s => ({value:s.id,label:s.title,description:`${s.id} ${s.ephemeral ? 'ephemeral' : 'retained'}`})));
      if (selected) { const session = sessions.find(s => s.id === selected); if (!session) throw new Error('Session not found'); this.session = session;this.runId=undefined;this.live=undefined;this.updateActivity(); await this.loadHistory(); await this.refresh(); } return;
    }
    if (name === '/model') {
      if(arg.startsWith('default ')){const value=arg.slice(8),slash=value.indexOf('/');if(slash<1)throw new Error('Use /model default provider/id');await show('model.default',{provider:value.slice(0,slash),id:value.slice(slash+1)});return;}
      let choice = arg;
      if (!choice) { const models = await this.client.rpc<{provider:string;id:string;name:string}[]>('models', { available: true }); choice = await this.choose(models.map(m => ({value:`${m.provider}/${m.id}`,label:m.name,description:`${m.provider}/${m.id}`}))) ?? ''; }
      if (choice) { const slash = choice.indexOf('/'); await this.client.rpc('model',{conversationId:this.session!.id,provider:choice.slice(0,slash),id:choice.slice(slash+1)}); this.session!.model = JSON.stringify({provider:choice.slice(0,slash),id:choice.slice(slash+1)}); await this.refresh(); } return;
    }
    if (name === '/thinking') {
      const thinking = await this.client.rpc<{level:string;available:string[];default:string}>('thinking.get',{conversationId:this.session!.id});
      if (arg) {
        const level = thinking.available.find(candidate => candidate.toLowerCase() === arg.toLowerCase());
        if (!level) throw new Error(`Unknown thinking level "${arg}". Available levels: ${thinking.available.join(', ')}.`);
        await this.setThinking(level, false); return;
      }
      let persisted = false;
      const chosen = await this.choose(thinking.available.map(level => ({ value: level, label: `${level === thinking.level ? '✓ ' : '  '}${level}`, description: level === thinking.default ? `${THINKING_DESCRIPTIONS[level]} · default` : THINKING_DESCRIPTIONS[level] })), undefined, 'Thinking level', async level => { persisted = true; await this.setThinking(level, true); });
      if (chosen !== undefined && !persisted) await this.setThinking(chosen, false);
      return;
    }
    const persistentCommand=name==='/approve'
      ||name==='/extensions'&&/^(enable|disable|rollback)\b/.test(arg)
      ||name==='/skills'&&/^(approve|read|import|enable|disable|delete|rollback)\b/.test(arg);
    if (persistentCommand&&this.session?.ephemeral) throw new Error('Ephemeral mode does not retain these operations. Start a retained session; this creates an operational/personal record.');
    if (name === '/skills') {
      const [action,id,version,hash]=arg.split(' ');
      if (action==='approve') await show('skills.approve',{id,version:Number(version),hash});
      else if (action==='read') await show('skills.read',{name:id,...(version?{path:arg.split(' ').slice(2).join(' ')}:{})});
      else if (action==='import') { const localPath=arg.slice('import '.length).trim(); if(!localPath)throw new Error('Use /skills import PATH (a directory, SKILL.md or ZIP on the daemon host)'); await show('skills.request',{action,localPath}); }
      else if (['enable','disable','delete','rollback'].includes(action!)) await show('skills.request',{action,name:id,...(action==='rollback'?{version:Number(version)}:{})});
      else if (!arg || action==='list') await show('skills.request',{action:'list'});
      else throw new Error('Use /skills to inspect/import packages; ask in chat to create or use a skill');
      return;
    }
    if (name === '/notifications') { await show('notifications.list'); return; }
    if (name === '/approve') { const [approvalId,artifactHash] = arg.split(' '); await show('extensions.approve',{id:approvalId,hash:artifactHash,decision:true}); return; }
    if (name === '/extensions') {
      const [action,...details] = arg.split(' '), value = details.join(' ');
      if (['review','enable','disable','rollback'].includes(action!)) await show(`extensions.${action}`,{id:value});
      else if (!arg) await show('extensions.list');
      else throw new Error('Use /extensions review|enable|disable|rollback ID; ask Pico in chat to build an extension'); return;
    }
    if (name === '/auth') {
      const [action, value, ...extra] = arg.split(/\s+/);
      if (extra.length) throw new Error('Never put credentials in a command. Use /auth key provider or /auth secret name for a masked prompt.');
      if (action === 'key') await this.configure(() => this.login(value, 'api_key'));
      else if (action === 'secret') await this.configure(() => this.saveSecret(value));
      else if (action === 'select' && value) await this.configure(() => show('auth.select', { account: value }));
      else if (['chatgpt','codex'].includes(action!) && !value) await this.configure(() => this.login(action === 'codex' ? 'openai-codex' : 'openai', 'oauth'));
      else if (!value && action === 'test') await this.configure(() => this.testModel());
      else if (!value && ['status','accounts',''].includes(action!)) await show(action === 'accounts' ? 'auth.accounts' : 'auth.status');
      else throw new Error('Use /login, /logout, or /auth key provider|secret name|chatgpt|codex|accounts|select account|status|test'); return;
    }
    throw new Error('Unknown command. /help lists basic controls; ask Pico in chat for everything else.');
  }
  private async configure(task: () => Promise<unknown>): Promise<void> {
    if (this.session?.ephemeral) throw new Error('Ephemeral mode does not save configuration or credentials. Start a retained session with /new.');
    if (this.runId) throw new Error('Wait for the current turn to finish before setup');
    this.setupBusy = true; this.updateActivity();
    try { await task(); } finally { this.setupBusy = false; this.updateActivity(); }
  }
  private async showReadiness(): Promise<void> {
    this.notice(formatReadiness(validate<Readiness>(ReadinessSchema, await this.client.rpc('readiness', this.session ? { conversationId: this.session.id } : {}))));
  }
  private async testModel(): Promise<void> {
    const choice = await this.choose([
      { value: 'no', label: 'Cancel (default)', description: 'No network request, inference or charge' },
      { value: 'yes', label: 'Test selected conversation model once', description: 'Sends one fixed synthetic prompt via the selected Pico account; may charge. No personal context or tools.' }
    ], undefined, 'Explicit live model test — provider charges may apply');
    if (choice !== 'yes') return;
    const result = await this.client.rpc<{ tested: string }>('auth.test', { conversationId: this.session!.id });
    this.notice(`Model test ${result.tested}. This proves neither memory quality nor connector delivery; OAuth/account changes invalidate the observation.`);
    await this.showReadiness();
  }
  private async setupMenu(): Promise<void> {
    await this.showReadiness();
    const choice = await this.choose([
      { value: 'telegram', label: 'Telegram', description: 'Guided channel setup with masked token entry' },
      { value: 'login', label: 'Model authentication', description: 'Pi built-in providers, including ChatGPT and Codex subscriptions' },
      { value: 'api', label: 'Model API key', description: 'Pi provider-owned API-key setup; metered usage' },
      { value: 'integrations', label: 'Integrations', description: 'Google/Gmail, Docs, Calendar and other extension-provided setup' },
      { value: 'imageGeneration', label: 'Image generation', description: 'Optional metered OpenAI images; API key required, not a ChatGPT subscription' },
      { value: 'speech', label: 'Voice replies', description: 'On-request Telegram voice via metered OpenAI text-to-speech; API key required' },
      { value: 'transcription', label: 'Voice transcription', description: 'Optional metered OpenAI service; reuses a stored API key or service override' },
      { value: 'embeddings', label: 'Memory embeddings', description: 'Mem0: metered OpenAI (default) or local E5' },
      { value: 'search', label: 'Web search', description: 'DuckDuckGo without a key, or optional vault-backed Brave (may be metered)' },
      { value: 'settings', label: 'Settings', description: 'Timezone, model, quiet hours, retention and integrations' },
      { value: 'secrets', label: 'Service credentials', description: 'Masked entry for existing service secrets' },
      { value: 'readiness', label: 'Readiness overview', description: 'Configured, credential, authentication, reachability and actual test evidence; no probes' },
      { value: 'test', label: 'Test selected model', description: 'Explicit one-shot synthetic inference; asks before a potentially billed call' },
      { value: 'apply', label: 'Apply saved settings', description: 'Reload the backend using saved settings' }
    ]);
    if (choice === 'readiness') await this.showReadiness();
    else if (choice === 'test') await this.testModel();
    else if (choice === 'telegram') await this.telegramSetup();
    else if (choice === 'api') await this.login(undefined, 'api_key');
    else if (choice === 'login') await this.login();
    else if (choice === 'integrations') await this.integrationSetup();
    else if (choice === 'search') await this.searchSetup();
    else if (choice === 'settings') await this.editSetting();
    else if (choice === 'secrets') await this.saveSecret();
    else if (choice === 'apply') await this.applySettings();
    else if (choice === 'transcription' || choice === 'embeddings' || choice === 'imageGeneration' || choice === 'speech') await this.editSetting(choice);
  }
  private async searchSetup(): Promise<void> {
    this.notice('**Web search**\nDuckDuckGo is the default, no key required; its public HTML search can challenge or change. Brave is optional and may be metered. Search queries and fetched URLs are disclosed externally; there is no automatic fallback or page downloading.');
    const provider=await this.choose([{value:'duckduckgo',label:'DuckDuckGo (default)',description:'No API key; explicit failures on challenges/outages'},{value:'brave',label:'Brave Search',description:'Requires your instance-private API key; may charge'}]);
    if(!provider)return;
    let key='';
    if(provider==='brave') {
      const secrets=await this.client.rpc<Record<string,boolean>>('secret.status');
      const entered=await this.prompt(`Brave Search API key — masked${secrets['brave.searchKey']?'; leave blank to keep the saved key':''}`,{secret:true,required:!secrets['brave.searchKey']});
      if(entered===undefined)return;key=entered;
    }
    try {
      if(key)await this.client.rpc('secret.set',{name:'brave.searchKey',value:key});
      await this.client.rpc('settings.update',{search:{provider}});
    } catch {throw new Error('Search setup incomplete; inspect /settings search before retrying. A saved key may remain pending.');}
    finally {key='';}
    this.notice('Search settings saved, not live-verified. No search or billed model probe was performed.');
    await this.applySettings();
  }
  private async telegramSetup(): Promise<void> {
    this.notice('**Telegram setup**\nCreate a bot with @BotFather (/newbot), then obtain your own numeric Telegram user ID (for example using @userinfobot). Never allow a friend: each allowlisted ID receives owner authority. Open the bot and press Start after setup.');
    const config = await this.client.rpc<Config>('settings.get');
    const modules = await this.client.rpc<{ id: string; enabled: boolean }[]>('extensions.list');
    if (modules.some(module => module.id === 'telegram' && !module.enabled)) this.notice('The Telegram module is disabled. Setup preserves that choice; use /extensions enable telegram when ready to activate it.');
    const secrets = await this.client.rpc<Record<string, boolean>>('secret.status');
    let token = await this.prompt(`Telegram bot token — masked${secrets['telegram.token'] ? '; leave blank to keep the saved token' : ''}`, { secret: true, required: !secrets['telegram.token'], check: value => { if (value && !/^\d+:[A-Za-z0-9_-]+$/.test(value)) throw new Error(); } });
    if (token === undefined) return;
    const senders = await this.prompt('Allowlisted owner user IDs — JSON array, e.g. [123456789]. Every ID receives owner authority.', { value: JSON.stringify(config.telegram?.allowedSenders ?? []), required: true, check: value => {
      const ids = validate<number[]>(ConfigSchema.properties.telegram.properties.allowedSenders, JSON.parse(value));
      if (ids.some(id => !Number.isSafeInteger(id))) throw new Error();
    } });
    if (senders === undefined) { token = ''; return; }
    const allowedSenders = JSON.parse(senders) as number[];
    const destination = await this.prompt('Default reminder recipient — one of the allowlisted numeric user IDs', { value: String(config.telegram?.destination ?? allowedSenders[0]), required: true, check: value => {
      if (!/^\d+$/.test(value) || !allowedSenders.includes(Number(value))) throw new Error();
    } });
    if (destination === undefined) { token = ''; return; }
    const save = await this.choose([{ value: 'yes', label: 'Save Telegram configuration', description: `Replace the allowlist with ${allowedSenders.join(', ')}; reminders go to ${destination}` }, { value: 'no', label: 'Cancel', description: 'Keep current credentials and configuration unchanged' }]);
    if (save !== 'yes') { token = ''; return; }
    try {
      if (token) await this.client.rpc('secret.set', { name: 'telegram.token', value: token });
      await this.client.rpc('settings.update', { telegram: { allowedSenders, destination: Number(destination) } });
    } catch (error) { throw new Error(error instanceof Error && error.message.startsWith('Changing Telegram bot identity') ? error.message : 'Telegram setup was not completed. Inspect /settings before retrying; a saved token may remain pending.'); }
    finally { token = ''; }
    this.notice('Telegram settings saved, not yet connectivity-verified. After applying, use /telegram status and /telegram check (read-only Bot API requests). Press Start in your private bot chat; Pico admits only the allowlisted owner accounts. An existing webhook or another poller prevents polling.');
    await this.applySettings();
  }
  private async login(providerId?: string, type?: AuthType): Promise<void> {
    const providers = await this.client.rpc<AuthProvider[]>('auth.providers');
    if (!providerId) {
      type ??= await this.choose([{ value: 'oauth', label: 'Sign in with an account' }, { value: 'api_key', label: 'Sign in with an API key' }]) as AuthType | undefined;
      if (!type) return;
      providerId = await this.choose(providers.filter(provider => provider.methods.some(method => method.type === type)).map(provider => ({ value: provider.id, label: provider.name, description: provider.id })));
      if (!providerId) return;
    }
    const provider = providers.find(item => item.id === providerId);
    if (!provider || type && !provider.methods.some(method => method.type === type)) throw new Error('Unsupported provider authentication method; use /login to select a supported provider');
    type ??= provider.methods.length === 1 ? provider.methods[0]!.type : await this.choose(provider.methods.map(method => ({ value: method.type, label: method.label }))) as AuthType | undefined;
    if (!type) return;
    const controller = new AbortController(); this.loginController = controller;
    try {
      const status = await loginProvider(this.client, providerId, type, {
        signal: controller.signal, notify: event => this.notice(authEventText(event)),
        prompt: async prompt => {
          const answer = prompt.type === 'select'
            ? await this.choose(prompt.options.map(option => ({ value: option.id, label: safeTerminal(option.label), description: safeTerminal(option.description ?? '') })), prompt.signal, prompt.message)
            : await this.prompt(prompt.message, { secret: prompt.type !== 'text', required: prompt.type === 'secret', maxLength: 8192, signal: prompt.signal });
          if (answer === undefined) throw new Error('Login cancelled');
          return answer;
        }
      });
      if (status.state === 'completed') {
        this.notice(`Authenticated with ${provider.name}. Credentials are private to Pico. Select a model with /model; /auth test may incur provider charges.`);
        await this.refresh();
      }
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof Error && error.message === 'Login cancelled')) throw new Error('Provider login failed. Check /auth status and retry /login; saved credentials may remain.');
    } finally { this.loginController = undefined; }
  }
  private async logout(provider?: string): Promise<void> {
    if (!provider) {
      const providers = await this.client.rpc<AuthProvider[]>('auth.providers');
      provider = await this.choose(providers.map(item => ({ value: item.id, label: item.name, description: item.id })));
    }
    if (!provider) return;
    await this.client.rpc('auth.logout', { provider }); this.notice('Logged out. Provider-side tokens are not revoked.'); await this.refresh();
  }
  private async saveSecret(name?: string): Promise<void> {
    name ??= await this.choose(SECRET_NAMES.map(value => ({ value, label: value, description: 'Save a service credential through a masked prompt' })));
    if (!name) return;
    if (!SECRET_NAMES.some(value => value === name)) throw new Error('Unknown service secret');
    let value = await this.prompt(`${name} — masked`, { secret: true, required: true });
    if (value === undefined) return;
    try { await this.client.rpc('secret.set', { name, value }); }
    catch (error) { throw new Error(error instanceof Error && error.message.startsWith('Changing Telegram bot identity') ? error.message : 'Could not save the service credential. Check daemon connectivity before retrying.'); }
    finally { value = ''; }
    this.notice('Service credential saved. It is not part of conversation history.');
    if (name === 'telegram.token') await this.applySettings();
  }
  private async remoteBrowserSetup(): Promise<void> {
    let raw = await this.prompt('Browser bridge pairing JSON — masked; never paste it into chat', { secret: true, required: true, maxLength: 8192 });
    if (raw === undefined) return;
    let token: { token: string } | undefined;
    try {
      let data: unknown; try { data = JSON.parse(raw); } catch { throw new Error('Invalid browser bridge pairing JSON'); }
      const current = await this.client.rpc<{ settings: unknown }>('extensions.setup', { id: 'mcp' });
      const selected = remoteBrowserSettings(current.settings, data); token = selected.pairing;
      if (await this.reviewAction(`Personal Chrome on another computer — requires its authenticated loopback bridge and a private SSH tunnel. Delegates selected tools autonomously inside your logged-in accounts; cookies stay on that computer. No connection starts now.\n${JSON.stringify(selected.settings.servers.at(-1), null, 2)}`) !== 'yes') return;
      await this.client.rpc('extensions.configure', { id: 'mcp', settings: selected.settings });
      await this.client.rpc('extensions.secret', { id: 'mcp', name: 'browser-remote', value: JSON.stringify({ headers: { Authorization: `Bearer ${selected.pairing.token}` } }) });
      this.notice('Remote browser pairing saved in the private vault. Keep the desktop bridge and SSH tunnel running; /mcp connect browser-remote, then ask normally in Telegram. No per-action approval.');
    } finally { raw = ''; if (token) token.token = ''; }
  }
  private async browserSetup(): Promise<void> {
    const entrypoint = await this.prompt('Absolute path to an already installed, trusted Playwright MCP cli.js (no installation or existing browser logins)', { required: true, maxLength: 4000 });
    if (entrypoint === undefined) return;
    const current = await this.client.rpc<{ settings: unknown }>('extensions.setup', { id: 'mcp' });
    const settings = browserSettings(this.client.root, current.settings, entrypoint);
    if (await this.reviewAction(`Trusted browser MCP preset — not a sandbox. Uses installed Chrome and a private Pico-only profile, never existing browser sessions. Delegates the selected browser tools to act autonomously without per-action approval, including writes and sends. Review this trust decision once. No browser or server starts now.\n${JSON.stringify(settings.servers.at(-1), null, 2)}`) !== 'yes') return;
    prepareBrowserDirectories(this.client.root);
    await this.client.rpc('extensions.configure', { id: 'mcp', settings });
    this.notice('Autonomous browser preset saved. /mcp connect browser, then ask normally in Telegram or chat: selected browser actions need no per-action approval. Login/CAPTCHA must be manual: /mcp pause browser, use the dedicated browser, /mcp resume browser. Never put credentials in chat.');
  }
  private async integrationSetup(moduleId?:string):Promise<void>{
    if(!moduleId){const modules=await this.client.rpc<{id:string;setup?:boolean}[]>('extensions.list');moduleId=await this.choose(modules.filter(module=>module.setup).map(module=>({value:module.id,label:module.id,description:'Configure extension-owned accounts and permissions'})));}
    if(!moduleId)return;
    const setup=await this.client.rpc<{title:string;description:string;parameters:import('typebox').TSchema;settings:unknown;secrets:{name:string;label:string}[]}>('extensions.setup',{id:moduleId});
    this.notice(`**${safeTerminal(setup.title)}**\n${safeTerminal(setup.description)}\nEdit non-secret settings below. Configure only selected services/records; write permissions need new consent.`);
    const settings=await this.editJson(`${moduleId} integration`,setup.settings);if(settings===undefined)return;validate(setup.parameters,settings);
    const fields = moduleId === 'mcp' ? mcpSettings(settings).servers.map(server => ({ name: server.id, label: `${server.id}: MCP credential JSON (optional)` })) : setup.secrets;
    const secrets:{name:string;value:string}[]=[];
    try{
      for(const field of fields){const value=await this.prompt(`${field.label} — masked; leave blank to keep existing credentials`,{secret:true,maxLength:16_000});if(value===undefined)return;if(value){if(moduleId==='mcp'){try{validate(McpCredentialsSchema,JSON.parse(value));}catch{throw new Error('Invalid MCP credential JSON');}}secrets.push({name:field.name,value});}}
      const save=await this.choose([{value:'yes',label:'Save integration settings',description:'Save selected capabilities; this does not grant service consent or verify connectivity'},{value:'no',label:'Cancel',description:'Keep existing configuration'}]);if(save!=='yes')return;
      await this.client.rpc('extensions.configure',{id:moduleId,settings});
      for(const secret of secrets)await this.client.rpc('extensions.secret',{id:moduleId,...secret});
      this.notice(moduleId === 'mcp' ? 'MCP settings saved; no connection started now. Use /mcp connect SERVER, /mcp auth SERVER and /mcp status. Enabled servers connect on startup. Servers run with trusted OS/network access, not in a sandbox.' : `Settings saved. Credentials are not chat history. Start or renew browser consent with /integrations auth ${moduleId}; inspect /integrations status ${moduleId}.`);
    }catch{throw new Error('Integration setup incomplete; inspect its settings/status before retrying. Some saved settings or secrets may remain.');}
    finally{for(const secret of secrets)secret.value='';}
  }
  private reviewAction(reviewJson:string):Promise<string|undefined>{
    if(this.closed)return Promise.resolve(undefined);
    return new Promise(resolve=>{
      const body=new ScrollView(new Text(safeTerminal(reviewJson.replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,char=>`\\u${char.charCodeAt(0).toString(16).padStart(4,'0')}`)),1,1),{follow:'none',primary:true,overscroll:'contain',scrollbar:'always'});
      const list=new SelectList([{value:'no',label:'Reject action',description:'Do not perform this external effect'},{value:'yes',label:'Approve exact action',description:'Perform the reviewed payload once; unknown acceptance is never retried'}],2,selectTheme);
      let finished=false;
      const finish=(value?:string)=>{if(finished)return;finished=true;this.cancelDialog=undefined;this.tui.setLayoutRoot(this.mainLayout);this.tui.setFocus(this.editor);this.tui.requestRender();resolve(value);};
      const choices:Component={render:width=>list.render(width),invalidate:()=>list.invalidate(),handleInput:data=>{
        if(matchesKey(data,'pageUp')||matchesKey(data,'pageDown')){body.scrollBy((matchesKey(data,'pageUp')?-1:1)*Math.max(1,body.viewportHeight-1));this.tui.requestRender();return;}
        if(matchesKey(data,'ctrl+home')){body.scrollToStart();this.tui.requestRender();return;}if(matchesKey(data,'ctrl+end')){body.scrollToEnd();this.tui.requestRender();return;}
        list.handleInput(data);
      },handleMouse:event=>list.handleMouse(event)};
      list.onSelect=item=>finish(item.value);list.onCancel=()=>finish();this.cancelDialog=()=>finish();
      this.tui.setLayoutRoot(new VStack([{component:new Text(bold('Review exact external action'),1,0),basis:'auto',shrink:0},{component:body,basis:0,grow:1,minSize:1},{component:choices,basis:'auto',shrink:0},{component:new Text(dim('PgUp/PgDn scroll · Ctrl+Home/End · ↑↓ choose · Enter confirms · Esc cancels\nExternal effects cannot be undone by cancellation. Reject is the default.'),1,0),basis:'auto',shrink:0}]));
      this.tui.setFocus(choices);this.tui.requestRender();
    });
  }
  private async integrationLogin(op: string, args?: Record<string, unknown>): Promise<void> {
    const result = await (args ? this.client.rpc<{ url: string; allowInsecureLocal?: boolean }>(op, args) : this.client.rpc<{ url: string; allowInsecureLocal?: boolean }>(op));
    let target: URL;
    try {
      if (typeof result?.url !== 'string' || safeTerminal(result.url) !== result.url || /\s/.test(result.url)) throw new Error();
      target = new URL(result.url);
      if (target.protocol !== 'https:' && !(op === 'extensions.mcp.auth' && result.allowInsecureLocal && target.protocol === 'http:') || target.username || target.password) throw new Error();
    } catch { throw new Error('Invalid integration sign-in URL; cancel the pending login before retrying.'); }
    this.notice(`**Browser sign-in**\n[Open sign-in page — ${target.host}](<${target.href}>)\n\nCmd-click or Ctrl-click the link to open the complete URL. Do not copy wrapped URL text: inserted whitespace can break permissions. Complete consent in your browser, then check integration status.`);
  }
  private async mcpSecret(server: string): Promise<void> {
    let value = await this.prompt(`${server}: credential JSON — stdio: env; HTTP/SSE: headers or oauthClientSecret — masked`, { secret: true, required: true, maxLength: 16_000 });
    if (value === undefined) return;
    try {
      try { validate(McpCredentialsSchema, JSON.parse(value)); } catch { throw new Error('Invalid MCP credential JSON'); }
      await this.client.rpc('extensions.secret', { id: 'mcp', name: server, value });
      this.notice('MCP credentials saved outside chat. Disconnect and reconnect the server to apply changed credentials.');
    } finally { value = ''; }
  }
  private async mcpRespond(requestId: string): Promise<void> {
    if (this.session?.ephemeral) throw new Error('MCP approval is unavailable in ephemeral mode');
    this.setupBusy = true; this.updateActivity();
    try {
      const review = await this.client.rpc<{ id: string; digest: string; kind: string; expiresAt: number; request: { mode?: string } }>('extensions.mcp.requests.read', { id: requestId });
      if (review.expiresAt <= Date.now()) throw new Error('MCP request expired');
      const decision = await this.reviewAction(`${review.kind === 'sampling' ? 'Approving sampling may charge the currently selected model. No private conversation context or tools will be supplied.\n' : 'External MCP server request; never enter credentials.\n'}${JSON.stringify(review, null, 2)}`);
      if (!decision) return;
      let content: Record<string, unknown> | undefined;
      if (decision === 'yes' && review.kind === 'elicitation' && review.request.mode !== 'url') {
        let text = await this.prompt('Form response JSON — masked; never credentials', { secret: true, required: true, maxLength: 128_000 });
        if (text === undefined) return;
        try { content = JSON.parse(text) as Record<string, unknown>; } catch { throw new Error('Invalid MCP form JSON'); } finally { text = ''; }
      }
      this.notice(`\`\`\`json\n${JSON.stringify(await this.client.rpc('extensions.mcp.requests.respond', { id: review.id, digest: review.digest, action: decision === 'yes' ? 'accept' : 'decline', ...(content ? { content } : {}) }), null, 2)}\n\`\`\``);
    } finally { this.setupBusy = false; this.updateActivity(); }
  }
  private async integrationApproval(moduleId:string,actionId:string):Promise<void>{
    const action=await this.client.rpc<{id:string;digest:string;status:string;expiresAt:number}>(`extensions.${moduleId}.actions.review`,{id:actionId});
    if(action.status!=='pending'||action.expiresAt<=Date.now())throw new Error('Action is consumed, uncertain or expired; it cannot be approved');
    const reviewJson=JSON.stringify(action,null,2).replace(/[\u202a-\u202e\u2066-\u2069]/g,value=>`\\u${value.charCodeAt(0).toString(16).padStart(4,'0')}`);
    const decision=await this.reviewAction(reviewJson);if(!decision)return;
    this.notice(`\`\`\`json\n${JSON.stringify(await this.client.rpc(`extensions.${moduleId}.actions.approve`,{id:action.id,digest:action.digest,decision:decision==='yes'}),null,2)}\n\`\`\``);
  }
  private async gmailSetup(): Promise<void> {
    const status=await this.client.rpc<{settingsSource?:string}>('mail.status');
    if(status.settingsSource==='extension'){await this.integrationSetup('google');return;}
    this.notice('**Gmail setup**\nCreate a Google OAuth Desktop application and enable Gmail API outside Pico. Pico requests read-only access; browser consent is still required.');
    const config = await this.client.rpc<Config>('settings.get');
    const clientId = await this.prompt('Google OAuth Desktop client ID — not an API key', { value: config.gmail?.clientId, required: true });
    if (clientId === undefined) return;
    let secret = await this.prompt('Optional Google client secret — masked; leave blank to keep an existing secret', { secret: true });
    if (secret === undefined) return;
    const save = await this.choose([{ value: 'yes', label: 'Save read-only Gmail setup', description: 'Preserve existing polling limits, then offer backend reload and browser consent' }, { value: 'no', label: 'Cancel', description: 'Do not save any values' }]);
    if (save !== 'yes') { secret = ''; return; }
    try {
      if (secret) await this.client.rpc('secret.set', { name: 'gmail.clientSecret', value: secret });
      await this.client.rpc('settings.update', { gmail: { clientId, intervalMs: config.gmail?.intervalMs ?? 60_000, baselineMax: config.gmail?.baselineMax ?? 200 } });
    } catch { throw new Error('Gmail setup was not completed. Inspect /settings before retrying; a saved secret may remain pending.'); }
    finally { secret = ''; }
    if (await this.applySettings()) await this.integrationLogin('mail.auth');
  }
  private async editSetting(key?: string): Promise<void> {
    const config = await this.client.rpc<Record<string, unknown>>('settings.get');
    key ||= await this.choose(Object.keys(SettingsSchema.properties).map(value => ({ value, label: value, description: value==='search'?'DuckDuckGo or optional Brave; null restores DuckDuckGo':'Edit non-secret JSON; null disables an optional integration' })));
    if (!key) return;
    if (!Object.hasOwn(SettingsSchema.properties, key)) throw new Error('Unknown or protected setting');
    if(key==='gmail'&&(await this.client.rpc<{settingsSource?:string}>('mail.status')).settingsSource==='extension')throw new Error('Google extension settings supersede legacy Gmail settings; use /integrations setup google');
    if (key === 'transcription') this.notice('OpenAI transcription is optional and metered. It requires a stored OpenAI API key or /auth secret openai.mediaKey, not a ChatGPT subscription.');
    if (key === 'speech') this.notice('Telegram voice replies are optional and metered, on request or for the current chat until /new. Use a stored OpenAI API key or /auth secret openai.speechKey, not a ChatGPT subscription. Setup makes no speech request.');
    if (key === 'imageGeneration') this.notice('OpenAI image generation is optional and metered; one PNG per request. Enable explicitly and use a stored OpenAI API key or /auth secret openai.imageKey. No subscription/chat-provider fallback; setup makes no image request.');
    const defaults: Record<string, unknown> = { speech: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy' }, imageGeneration: { provider: 'openai', model: 'gpt-image-1', quality: 'low' }, transcription: { provider: 'openai', model: 'gpt-4o-mini-transcribe' }, search: { provider: 'duckduckgo' } };
    const value = await this.editJson(key, config[key] ?? defaults[key] ?? null);
    if (value === undefined) return;
    const input = { [key]: value }; validate(SettingsSchema, input);
    await this.client.rpc('settings.update', input);
    this.notice(`${key} settings saved. Identity, IPC and executable-module trust cannot be edited here.`);
    await this.applySettings();
  }
  private async applySettings(): Promise<boolean> {
    const choice = await this.choose([{ value: 'yes', label: 'Apply saved settings now', description: 'Reload the backend without leaving the TUI. Unsaved legacy sessions are lost; active/queued work must finish first.' }, { value: 'no', label: 'Later', description: 'Leave saved settings pending; use /reload when ready' }]);
    if (choice !== 'yes') return false;
    const result = await this.client.rpc('settings.apply');
    this.notice(`Settings applied. Retained conversations and schedules are preserved.\n${JSON.stringify(result)}`);
    return true;
  }
  private async afterApply(): Promise<void> {
    if (this.closed) return;
    const sessions = await this.client.rpc<Session[]>('sessions');
    if (this.closed) return;
    if (!sessions.some(session => session.id === this.session?.id)) {
      this.session = await this.client.rpc<Session>('new', { ephemeral: this.session?.ephemeral ?? false });
      this.runId = undefined; this.live = undefined; this.updateActivity(); await this.loadHistory();
      this.notice('Backend reloaded: the previous ephemeral session was lost. A new session keeps your previous retention mode.');
    }
    await this.refresh();
  }
  get canRefresh(): boolean { return !this.closed && !this.runId && !this.inputPending && !this.setupBusy && !this.cancelDialog && !this.loginController && !this.editor.getText(); }
  close(): void { this.closed = true; this.updateActivity(); this.loginController?.abort(); this.cancelDialog?.(); this.unsubscribe?.(); this.client.close(); this.tui.stop(); }
}
export async function chat(client: Client): Promise<void> { const channel: PicoChannel = new ChatUI(client); await channel.start(); }
