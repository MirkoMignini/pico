# Model Context Protocol (MCP)

Pikobot is an **MCP client**, using the official TypeScript SDK. No servers are installed or connected by default. Configure only servers you trust: a local server is executable code with your OS-user permissions, **not a sandbox**. Remote servers receive your arguments and have their own retention, authentication and possible charges.

## Capabilities

| Feature | Behavior |
| --- | --- |
| Transports | Persistent stdio processes, Streamable HTTP, and legacy HTTP/SSE. |
| Protocols | SDK-supported 2025 handshakes and opt-in 2026 discovery/negotiation. HTTP defaults to `auto`; stdio/SSE default to `legacy`. Optional `{"pin":"2026-07-28"}` requires that modern revision. |
| Tools | Complete paginated discovery, collision-resistant Pikobot names, owner tool selection, input-schema validation, SDK output-schema validation, structured results, progress and cancellation. |
| Resources | Listing, URI templates, text/binary reads and connection-scoped change subscriptions. A resource URI is passed to the selected server, not fetched as an arbitrary URL/host path by Pikobot. |
| Prompts | Listing, string arguments, retrieval and argument completion for prompts/resource templates. Returned roles/messages remain external evidence, not new conversation instructions. |
| Authentication | Private environment variables/HTTP headers; OAuth discovery, PKCE, dynamic registration, pre-registered clients, issuer/resource binding, refresh, local logout and explicit client-credentials grants. |
| Server requests | Explicit roots; optional form/URL elicitation and bounded text sampling, each requiring a fresh owner-terminal response. Disabled by default. |
| Notifications | Catalog-change invalidation, resource changes, bounded logging/status and modern subscription streams. No automatic memory writes, resource reads or model calls. |
| Tasks | Experimental legacy task creation, list/status/results and cancellation. Creation/cancellation use exact approvals. Tasks removed from a modern protocol revision are rejected, not tunneled onto that revision. |

The daemon does not expose Pikobot owner RPC as an MCP server. The optional separately run desktop browser bridge exposes only browser tools and captured artifacts, not the owner agent/database. There is no automatic server marketplace installation, server-supplied code execution, private-context sharing, a native browser engine, mTLS/JWT/DPoP configuration or interactive audio playback. Sampling is text-only, without tools or private conversation context; unsupported requests are denied. Images can be included in model tool results; audio and other binary content remain represented in the retained result, not automatically imported/sent as attachments. The optional [browser MCP prototype](BROWSER.md) adds a dedicated-profile preset, explicit personal-Chrome pairing through a private desktop bridge/tunnel, human handoff, file-backed snapshot reads and source-linked screenshot/download imports.

## Setup

In the TUI:

```text
/mcp setup
/mcp secret SERVER
/mcp connect SERVER
/mcp status
/mcp catalog SERVER
```

`/mcp setup` edits a strict **non-secret** JSON object, then offers masked credentials for the newly selected servers. `/integrations setup mcp` uses the same flow. Saving configuration disconnects existing MCP connections but does not connect immediately. Enabled servers connect on the next daemon start; `/mcp connect SERVER` starts one now. A failed connection stays failed until an explicit connect or later owner tool request; failed/uncertain tool effects are never automatically replayed.

Start narrowly, for example with the public, credential-free Microsoft Learn server:

```json
{
  "servers": [
    {
      "id": "learn",
      "enabled": true,
      "transport": "http",
      "url": "https://learn.microsoft.com/api/mcp",
      "tools": ["microsoft_docs_search", "microsoft_docs_fetch"],
      "readOnlyTools": ["microsoft_docs_search", "microsoft_docs_fetch"],
      "resources": true,
      "prompts": true,
      "timeoutMs": 60000,
      "maxBytes": 8000000
    }
  ]
}
```

No credential is needed for that example. Availability, schemas and upstream policies can change. Model-driven use still requires your separately selected Pikobot model and can charge for inference.

A local server uses the same common fields, replacing HTTP fields with:

```json
{
  "id": "local",
  "enabled": true,
  "transport": "stdio",
  "command": "/absolute/path/to/an-already-installed-server",
  "args": [],
  "cwd": "/explicit/working/directory",
  "tools": [],
  "readOnlyTools": [],
  "roots": [{ "uri": "file:///explicit/project", "name": "Selected project" }]
}
```

`tools: []` disables execution while allowing discovery. Omit `tools` to expose all discovered tools; **all still need approval unless their exact name is in `readOnlyTools` or explicitly delegated through `autonomousTools`**. Server `readOnlyHint`, descriptions, prompt messages and roots never grant authority or confinement. Declaring a tool read-only is your explicit delegated trust, not verification that the server cannot write. `autonomousTools` grants exact selected tools direct execution **including effects** without per-action approval; every name must also be explicitly in `tools` and cannot overlap `readOnlyTools`. The browser preset delegates its narrow tool allowlist this way. Saving settings never silently widens an older configuration.

Stdio gets a disposable HOME/XDG directory and a scrubbed environment: PATH, temporary directories, UTF-8 locale and explicitly configured variables. It does not inherit provider keys, `NODE_OPTIONS`, shell profiles or owner application credentials. Use masked credentials for secret environment values. Commands run without a shell; no implicit `$VARIABLE` expansion. An explicitly selected command such as `npx` can itself download/execute software: that is an operator trust decision, not Pikobot installing a server.

Stdio `auto`/pin probing happens **in the same owned process**, not a disposable second executable launch. An older server that exits on an unfamiliar probe can fail to connect; choose `legacy`, rather than relying on automatic process restart. Disconnect/shutdown terminates the owned process group and removes its temporary HOME. Escaping descendants, arbitrary host access and independent server state remain outside this cleanup guarantee.

### Configuration reference

- IDs: lowercase letter followed by up to 31 lowercase letters/digits/hyphens; unique within the instance; at most 64 servers.
- Common: `id`, `enabled`, optional exact `tools`/`readOnlyTools`/`autonomousTools`, `resources`/`prompts` (default true), local-file `roots`, `sampling`/`elicitation` (default false), `timeoutMs` (1,000–600,000), `maxBytes` (1,024–20,000,000), optional `artifactDirectory` (an absolute private directory explicitly authorizing receipt-reported local output reads/imports), `protocol` (`legacy`, `auto` or a version pin).
- Stdio: `transport: "stdio"`, `command`, optional `args`, absolute `cwd` and non-secret `env`.
- HTTP/SSE: `transport: "http"` or `"sse"`, exact `url`, optional non-secret `headers`, `allowPrivateNetwork`, `oauth`.
- OAuth: optional `clientId`, `issuer`, `grantType` (`authorization_code` or `client_credentials`), `callbackPort`, `scope`, `clientMetadataUrl`. Pre-registered clients require an explicit issuer; client-credentials also requires a client ID. A fixed callback port is useful for pre-registered redirect URIs.

Unknown properties and obvious URL/header/environment credentials are rejected. Never put secrets in URLs, command arguments or ordinary JSON settings. HTTP requires HTTPS and public DNS answers by default, checks every address and pins the connection. `allowPrivateNetwork: true` is an explicit **same-origin** exception for a selected LAN/loopback endpoint, including HTTP. It does not weaken Pikobot's web fetcher or permit cross-origin private OAuth requests. Redirects, compressed bodies, ambient cookies/proxy credentials and cross-origin resource endpoints are refused; configure the exact endpoint.

### Private credentials and OAuth

Enter one credential JSON object through `/mcp secret SERVER` or CLI private stdin:

```text
stdio:   {"env":{"SERVICE_TOKEN":"YOUR_VALUE"}}
HTTP:    {"headers":{"Authorization":"Bearer YOUR_VALUE"}}
OAuth:   {"oauthClientSecret":"YOUR_VALUE"}
```

Use only fields for the selected transport; custom gateway headers can accompany OAuth, but a static Authorization header cannot. `{}` explicitly replaces existing operator-supplied credentials with an empty object. Blank TUI setup input preserves existing credentials.

The vault binds these credentials to the exact endpoint/command and selected account. Changing that identity requires explicitly re-entering credentials; old secrets are neither forwarded to the new server nor silently deleted. Saved changes to live credentials require disconnect/reconnect before further calls. OAuth grants are separately configuration/issuer/resource-bound. Tokens, refresh tokens, client registrations and client secrets stay in the vault, excluded from application backup/export. Literal/JSON-escaped known credential values are redacted from returned results; this is not protection against a malicious trusted server transforming or exfiltrating them.

For browser OAuth:

```text
/mcp auth SERVER
/mcp status
/mcp cancel SERVER
/mcp logout SERVER
```

Open the displayed link and complete consent in your browser. The callback listens only on `127.0.0.1`, requires the exact state and validates issuer/PKCE before committing a replacement grant. Replacement stays staged until a successful handshake and vault commit. Cancellation before commit preserves the previous grant; already accepted provider/vault updates cannot be undone by cancellation. The browser flow expires after ten minutes. Scope expansion is not automatic: update explicitly selected scopes and renew browser consent. Logout removes local OAuth state, not provider-side authorization or your separately supplied header/client-secret JSON.

For client-credentials, explicitly select `grantType: "client_credentials"`, `clientId`, `issuer`, scopes and the private client secret; connect without a browser. No account/provider credential fallback is used. Real vendor OAuth compatibility needs vendor-specific verification; synthetic OAuth tests are not that verification.

## Everyday use and approvals

After setup, ask Pikobot normally. It can use `mcp_catalog` and either a namespaced tool or `mcp_call`. Generic tools also include `mcp_resource`, `mcp_prompt`, `mcp_complete`, `mcp_tasks` and `mcp_status`. Namespaced tools accept an `arguments` object matching the catalog's original input schema.

Exact owner-delegated `autonomousTools` execute directly and retain effect history and canonical `mcp_autonomous` receipts. Failed/interrupted calls are uncertain, not safe to replay. Owner-declared reads remain separate. The [browser preset](BROWSER.md) uses autonomous execution so a trusted Telegram request can complete without terminal approvals.

Tools without either grant (and all async task requests) return a **prepared action**, not an executed result:

```text
/mcp actions
/mcp approve ACTION_ID
```

Review the exact server, tool name, arguments and connection-bound payload. Rejection is the default. Approvals expire, are single-use, and keep attempted-action tombstones across restore. Changed settings, credentials, connections or tool definitions cannot inherit an old approval. A tool error, timeout or lost acknowledgement can leave partial/uncertain effects; inspect the external service before preparing another action. Approval arguments are capped at 800,000 JSON characters to fit the private action record. Approved execution also has a canonical `mcp_approved` receipt; large acknowledgements point to that complete source instead of overflowing the action record or repeating the effect.

MCP access is denied in ephemeral, scheduled, review, untrusted and citation-repair execution. Foreground Telegram can prepare actions; only authenticated owner-terminal controls can approve them. A trusted server may still perform independent startup/background work outside Pikobot tool dispatch. Already accepted jobs/writes/charges cannot be undone by cancellation or disconnect.

Optional server requests appear in progress/status:

```text
/mcp requests
/mcp respond REQUEST_ID
```

This can be answered while the original foreground turn waits. Sampling approval explicitly permits one completion through the selected Pikobot model/account, subject to normal budgets and a 16,384-token cap; it can charge. Pikobot provides only the reviewed external text, not its chat, memory or tools. Requests with private context, multimodal content or tools are denied. Elicitation shows the exact request/schema before a masked JSON response; do not enter credentials. Responses go to the external server and can be echoed into retained tool results. Cancel/expired/original-call-ended requests cannot be reused.

Roots are advisory selected file URIs; they do not give an MCP server a Pikobot file-reader endpoint. Subscriptions and pending interactive requests last only for the connection. Notifications are diagnostic evidence, not completion or permission.

## CLI and RPC

```sh
node dist/cli.js --instance PRIVATE_INSTANCE mcp configure SETTINGS.json
# Or pipe non-secret settings into: mcp configure -
node dist/cli.js --instance PRIVATE_INSTANCE mcp secret SERVER
node dist/cli.js --instance PRIVATE_INSTANCE mcp connect SERVER
node dist/cli.js --instance PRIVATE_INSTANCE mcp catalog SERVER
printf '%s' '{"query":"MCP initialization"}' |
  node dist/cli.js --instance PRIVATE_INSTANCE mcp call learn microsoft_docs_search
node dist/cli.js --instance PRIVATE_INSTANCE mcp read SERVER RESOURCE_URI
node dist/cli.js --instance PRIVATE_INSTANCE mcp prompt SERVER PROMPT_NAME
node dist/cli.js --instance PRIVATE_INSTANCE mcp tasks SERVER
node dist/cli.js --instance PRIVATE_INSTANCE mcp approve ACTION_ID
```

`call`/`prompt` arguments use optional JSON stdin, not credential arguments. `approve`/`respond` require an interactive owner terminal and default to rejection. Additional commands: `status`, `auth`, `cancel`, `logout`, `disconnect`, `ping`, `requests`, `respond`, `actions`. Browser presets: `/mcp browser` or CLI `mcp browser ENTRYPOINT` for a dedicated profile; `/mcp browser-remote` or CLI `mcp browser-remote -` for private pairing JSON. Desktop CLI `browser-bridge init|serve|pair` runs independently without a Pikobot owner. Explicit handoff uses `pause SERVER` / terminal-only `resume SERVER`. `mcp artifact SERVER` and `mcp import SERVER` accept bounded JSON stdin with a completed receipt source. See the [browser guide](BROWSER.md).

Advanced owner-terminal RPCs use `extensions.mcp.*`: `status`, `connect`, `disconnect`, `auth`, `auth.cancel`, `logout`, `catalog`, `call`, `resource`, `prompt`, `complete`, `tasks`, `ping`, `logging`, `requests`, `requests.read`, `requests.respond`, `artifact`, `import`, `pause`, `resume`, `actions.list`, `actions.review`, `actions.approve`. Payloads are defined in `src/mcp-contracts.ts`; generic `rpc OP -` accepts private stdin. Settings/secrets use the existing `extensions.configure`/`extensions.secret` routes, not a model-facing configurator.

Model-facing and CLI results preserve Pikobot's bounded-preview contract. If `truncated: true`, follow `originalResultSourceId` with `source_read` windows, or operator `rpc source.read` for the retained original tool result. **Do not repeat the external call to recover output.** The source contains the original `AgentToolResult`; its first text block encodes the MCP JSON result. Oversized transport/catalog/result data fails explicitly; incomplete catalogs are not published as exhaustive.

## Verification

Build first, then run:

```sh
pnpm exec vitest run tests/mcp.test.ts tests/mcp-oauth.test.ts tests/mcp-network.test.ts tests/mcp-cli.test.ts
pnpm exec vitest run tests/tui-setup.test.ts
```

These exercise actual local stdio/process groups, HTTP/SSE, modern and legacy SDK serving, compiled CLI/Unix IPC, synthetic HTTP OAuth/PKCE/refresh, masked TUI entry and denial/uncertainty paths. Model sampling uses the faux provider. They do not establish hosted OAuth, live model interpretation, physical-terminal behavior or sandbox isolation.

Separately authorized public-network interoperability check:

```sh
pnpm build
pnpm test:mcp:live
```

It uses only disposable stores and public, credential-free Microsoft Learn/DeepWiki read tools, with no model, owner credentials or remote writes. It follows canonical receipts for large responses instead of replaying requests. Every planned case, including failures, stays in a private temporary report outside Git. Endpoint availability can change; a live response is not semantic answer quality or general production reliability. See [Testing](TESTING.md) and [Security](SECURITY.md).
