import { randomBytes } from 'node:crypto';
import { auth, UnauthorizedError, extractWWWAuthenticateParams, checkResourceAllowed, resourceUrlFromServerUrl, type FetchLike, type OAuthClientProvider, type OAuthClientInformationContext, type OAuthClientMetadata, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens } from '@modelcontextprotocol/client';
import type { Credentials } from './credentials.js';
import { hash, json } from './store.js';
import { mcpUrl, type McpServer } from './mcp-contracts.js';
import { readMcpCredentials } from './mcp-credentials.js';

type RemoteServer = Exclude<McpServer, { transport: 'stdio' }>;
interface OAuthState {
  binding: string; clients: Record<string, StoredOAuthClientInformation>; tokens: Record<string, StoredOAuthTokens>;
  issuer?: string; redirectUrl?: string;
}
export class McpOAuth implements OAuthClientProvider {
  private discovery?: OAuthDiscoveryState;
  private verifier?: string;
  csrf?: string;
  private staged: boolean;
  private authorizing?: Promise<void>;
  private constructor(readonly server: RemoteServer, private credentials: Credentials, private stateData: OAuthState, private secret: string | undefined, private handoff?: { redirectUrl: string; show: (url: URL) => void }) { this.staged = !!handoff; }
  static async create(server: RemoteServer, credentials: Credentials, handoff?: { redirectUrl: string; show: (url: URL) => void }): Promise<McpOAuth> {
    const binding = hash(json({ url: server.url, oauth: server.oauth }));
    const stored = await credentials.secret(`extensions.mcp.${server.id}.oauth`);
    const raw = stored ? JSON.parse(stored) as OAuthState : undefined;
    const state = raw?.binding === binding ? structuredClone(raw) : { binding, clients: {}, tokens: {} };
    if (handoff && state.redirectUrl !== handoff.redirectUrl && !server.oauth?.clientId) state.clients = {};
    const secret = (await readMcpCredentials(credentials, server)).oauthClientSecret;
    if (secret && (!server.oauth?.clientId || !server.oauth.issuer)) throw new Error('MCP OAuth client secrets require a configured clientId and issuer');
    return new McpOAuth(server, credentials, state, secret, handoff);
  }
  get ready(): boolean { return !!this.stateData.issuer && !!this.stateData.tokens[this.stateData.issuer]; }
  get redirectUrl(): string | undefined { return this.server.oauth?.grantType === 'client_credentials' ? undefined : this.handoff?.redirectUrl ?? this.stateData.redirectUrl; }
  get clientMetadataUrl(): string | undefined { return this.server.oauth?.clientMetadataUrl; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'Pico MCP', application_type: 'native', redirect_uris: this.redirectUrl ? [this.redirectUrl] : [], grant_types: this.server.oauth?.grantType === 'client_credentials' ? ['client_credentials'] : ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: this.secret ? 'client_secret_post' : 'none', ...(this.server.oauth?.scope ? { scope: this.server.oauth.scope } : {}) };
  }
  state(): string { this.csrf = randomBytes(32).toString('base64url'); return this.csrf; }
  private issuer(context?: OAuthClientInformationContext): string | undefined {
    const issuer = context?.issuer ?? this.stateData.issuer;
    if (issuer && this.server.oauth?.issuer && mcpUrl(issuer).href !== mcpUrl(this.server.oauth.issuer).href) throw new Error('MCP OAuth issuer differs from the operator-selected issuer');
    return issuer;
  }
  clientInformation(context?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    const issuer = this.issuer(context);
    if (!issuer) return undefined;
    if (this.server.oauth?.clientId) return { client_id: this.server.oauth.clientId, ...(this.secret ? { client_secret: this.secret } : {}), issuer };
    const client = this.stateData.clients[issuer];
    if (!client && !this.handoff) throw new Error('MCP authentication required; use /mcp auth SERVER');
    return client;
  }
  async saveClientInformation(client: StoredOAuthClientInformation, context?: OAuthClientInformationContext): Promise<void> {
    const issuer = this.issuer(context);
    if (!issuer) throw new Error('MCP OAuth registration has no issuer binding');
    this.stateData.clients[issuer] = client; await this.save();
  }
  tokens(context?: OAuthClientInformationContext): StoredOAuthTokens | undefined { const issuer = this.issuer(context); return issuer ? this.stateData.tokens[issuer] : undefined; }
  async saveTokens(tokens: StoredOAuthTokens, context?: OAuthClientInformationContext): Promise<void> {
    const issuer = this.issuer(context ?? (tokens.issuer ? { issuer: tokens.issuer } : undefined));
    if (tokens.issuer && tokens.issuer !== issuer) throw new Error('MCP OAuth token issuer binding mismatch');
    if (!issuer) throw new Error('MCP OAuth tokens have no issuer binding');
    this.stateData.tokens[issuer] = tokens; this.stateData.issuer = issuer;
    if (this.redirectUrl) this.stateData.redirectUrl = this.redirectUrl;
    await this.save();
  }
  redirectToAuthorization(url: URL): void {
    if (!this.handoff) throw new Error('MCP authorization required; use /mcp auth SERVER');
    mcpUrl(url.href);
    if (url.protocol !== 'https:' && !(this.server.allowPrivateNetwork && url.origin === new URL(this.server.url).origin)) throw new Error('MCP authorization requires HTTPS or explicit same-origin private-network access');
    this.handoff.show(url);
  }
  saveCodeVerifier(verifier: string): void { this.verifier = verifier; }
  codeVerifier(): string { if (!this.verifier) throw new Error('MCP OAuth verifier missing'); return this.verifier; }
  saveDiscoveryState(state: OAuthDiscoveryState): void { this.discovery = state; }
  discoveryState(): OAuthDiscoveryState | undefined { return this.discovery; }
  prepareTokenRequest(): URLSearchParams | undefined { return this.server.oauth?.grantType === 'client_credentials' ? new URLSearchParams({ grant_type: 'client_credentials', ...(this.server.oauth.scope ? { scope: this.server.oauth.scope } : {}) }) : undefined; }
  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL> {
    const expected = resourceUrlFromServerUrl(serverUrl);
    if (resource && !checkResourceAllowed({ requestedResource: expected, configuredResource: resource })) throw new Error('MCP OAuth resource audience mismatch');
    return expected;
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all' || scope === 'client') this.stateData.clients = {};
    if (scope === 'all' || scope === 'tokens') this.stateData.tokens = {};
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
    if (scope === 'all' || scope === 'discovery') this.discovery = undefined;
    await this.save();
  }
  async authorize(response: Response, fetchFn: FetchLike): Promise<void> {
    if (this.authorizing) return this.authorizing;
    const challenge = extractWWWAuthenticateParams(response);
    this.authorizing = (async () => {
      const result = await auth(this, { serverUrl: this.server.url, scope: this.server.oauth?.scope ?? challenge.scope, resourceMetadataUrl: challenge.resourceMetadataUrl, fetchFn });
      if (result !== 'AUTHORIZED') throw new UnauthorizedError('Complete MCP browser sign-in');
    })();
    try { await this.authorizing; } finally { this.authorizing = undefined; }
  }
  async finishAuth(params: URLSearchParams, fetchFn: FetchLike): Promise<void> {
    const code = params.get('code'); if (!code) throw new Error('MCP authorization code missing');
    const result = await auth(this, { serverUrl: this.server.url, authorizationCode: code, iss: params.get('iss') ?? undefined, scope: this.server.oauth?.scope, fetchFn });
    if (result !== 'AUTHORIZED') throw new Error('MCP authorization did not complete');
  }
  async commit(signal?: AbortSignal): Promise<void> {
    await this.credentials.setSecret(`extensions.mcp.${this.server.id}.oauth`, json(this.stateData), signal);
    this.staged = false; this.handoff = undefined;
  }
  private async save(): Promise<void> { if (!this.staged) await this.credentials.setSecret(`extensions.mcp.${this.server.id}.oauth`, json(this.stateData)); }
  secrets(): string[] { return [this.secret, this.verifier, ...Object.values(this.stateData.tokens).flatMap(token => [token.access_token, token.refresh_token]), ...Object.values(this.stateData.clients).map(client => 'client_secret' in client ? client.client_secret : undefined)].filter((value): value is string => typeof value === 'string' && !!value); }
}
