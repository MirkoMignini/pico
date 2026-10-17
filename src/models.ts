import { clampThinkingLevel, createModels, type AuthInteraction, type AuthType, type Model, type ModelThinkingLevel, type MutableModels, type AssistantMessage, type Context, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { Credentials } from './credentials.js';
import type { Config, ProviderCapabilities } from './contracts.js';

// Pico's factory default; explicit settings override it, and the model clamps it.
export const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = 'low';

export class ModelAccess {
  readonly models: MutableModels;
  readonly nonAgentUsage:{at:number;model:string;provider:string;usage:AssistantMessage['usage']}[]=[];
  constructor(readonly credentials: Credentials, readonly config: Config, models?: MutableModels) {
    this.models = models ?? builtinModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  }
  providers() {
    return this.models.getProviders().map(provider => ({ id: provider.id, name: provider.name, methods: [
      ...(provider.auth.oauth ? [{ type: 'oauth' as const, label: provider.auth.oauth.loginLabel ?? 'Sign in with an account' }] : []),
      ...(provider.auth.apiKey?.login ? [{ type: 'api_key' as const, label: 'Sign in with an API key' }] : [])
    ] })).filter(provider => provider.methods.length);
  }
  async login(providerId: string, type: AuthType, interaction: AuthInteraction, account = 'default'): Promise<void> {
    const provider = this.models.getProvider(providerId);
    if (!provider) throw new Error('Unknown authentication provider');
    let models = this.models;
    const key = type === 'api_key' ? 'openai-api' : `chatgpt:${account}`;
    if (providerId === 'openai') {
      // Preserve existing named accounts without switching live inference during an unfinished login.
      models = createModels({ credentials: this.credentials.alias(providerId, key), authContext: { env: async () => undefined, fileExists: async () => false } });
      models.setProvider(provider);
    }
    await models.login(providerId, type, interaction, { agentName: 'Pico', getDeviceId: () => this.config.instanceId });
    if (providerId === 'openai') await this.credentials.selectOpenai(key);
    const result = await this.models.refresh({ providers: [providerId], signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(interaction.signal ? [interaction.signal] : [])]) });
    if (result.aborted || result.errors.size) interaction.notify({ type: 'info', message: 'Credentials saved, but the model catalog could not refresh. Retry models.refresh before selecting a newly available model.' });
  }
  model(selection = this.config.model): Model<any> {
    const model = this.models.getModel(selection.provider, selection.id);
    if (!model) throw new Error(`Unknown model ${selection.provider}/${selection.id}. Refresh the account catalog or select a supported model.`);
    return model;
  }
  async options(model: Model<any>, signal?: AbortSignal, ephemeral = false): Promise<SimpleStreamOptions> {
    return { signal, maxTokens: 4096, cacheRetention: ephemeral ? 'none' : 'short', headers: { 'User-Agent': 'Pico/0.1.0' } };
  }
  async complete(context: Context, signal?: AbortSignal, selection=this.config.model, structured: { json?: boolean; maxTokens?: number } = {}): Promise<AssistantMessage> {
    const model = this.model(selection), options = await this.options(model, signal), thinking = clampThinkingLevel(model, 'off');
    if (thinking !== 'off') options.reasoning = thinking;
    if (structured.maxTokens) options.maxTokens = structured.maxTokens;
    if (structured.json && model.provider === 'deepseek') options.onPayload = payload => ({ ...(payload as Record<string, unknown>), response_format: { type: 'json_object' } });
    const reply = await this.models.completeSimple(model, context, options);
    this.recordUsage(reply);
    if (reply.stopReason !== 'stop') throw new Error(reply.errorMessage ?? `Model response ${reply.stopReason}`);
    return reply;
  }
  recordUsage(reply: AssistantMessage): void {
    this.nonAgentUsage.push({at:Date.now(),model:reply.model,provider:reply.provider,usage:reply.usage});if(this.nonAgentUsage.length>100)this.nonAgentUsage.shift();
  }
  async capabilities(selection = this.config.model): Promise<ProviderCapabilities> {
    const model = this.model(selection), credential = await this.credentials.read(model.provider);
    return { provider: model.provider, model: model.id, text: true, tools: true, images: model.input.includes('image'), streaming: true,
      cancellation: true, structured: !!model.compat && 'supportsStrictMode' in model.compat && model.compat.supportsStrictMode === true, contextWindow: model.contextWindow,
      authentication: model.provider.startsWith('faux') ? 'fixture' : credential?.type === 'oauth' ? 'subscription' : credential?.type === 'api_key' ? 'api_key' : 'unconfigured',
      transcription: !!this.config.transcription && !!await this.credentials.secret('openai.mediaKey'),
      embeddings: !!this.config.embeddings && (this.config.embeddings.provider === 'local' || !!await this.credentials.secret('openai.embeddingKey')) };
  }
}
export const assistantText = (message: AssistantMessage): string => message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
export function parseModelJson(text:string):unknown {
  const blocks=[...text.trim().matchAll(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gim)];
  return JSON.parse(blocks.length===1?blocks[0]![1]!:text);
}
