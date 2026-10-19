# Browser through MCP

An **opt-in prototype** for dynamic websites, accessibility snapshots, clicks, typing, screenshots, PDFs and downloads. Pikobot remains an MCP client: it does not ship a native browser engine or promise seamless browser parity, sandbox isolation or reliable interpretation of every site.

Both modes use a trusted, separately installed **Playwright MCP server** and installed **Google Chrome**. Neither installs software or discovers credentials on the model's behalf:

- **Dedicated profile** (default): separate Pikobot browser state on the daemon computer; never attaches to your regular browser or imports cookies/passwords.
- **[Personal Chrome on another computer](#personal-chrome-on-another-computer)**: explicit extension pairing and an authenticated browser-only bridge over a private SSH tunnel. Existing logins stay on that computer; selected page content can reach Pikobot and its model.

## Dedicated profile: set up once

Use Pikobot's [pinned Node/pnpm versions](INSTALLATION.md). Review and explicitly install the upstream server outside the Pikobot application and owner directories:

```sh
SERVER_HOME="$HOME/.local/share/pikobot-browser-server"
mkdir -p "$SERVER_HOME"
pnpm --dir "$SERVER_HOME" add --save-exact --ignore-scripts @playwright/mcp@0.0.83
```

This downloads trusted executable dependencies, not Chrome. Install Chrome separately if needed. `0.0.83` is the upstream version used for the local integration check; it includes a prerelease Playwright dependency. Changing versions is an explicit operator decision, not automatic compatibility or security assurance.

In the TUI, run:

```text
/mcp browser
```

Enter the **absolute path** to `SERVER_HOME/node_modules/@playwright/mcp/cli.js` in the separate setup prompt. Review the preset; **Reject is the default**. Saving adds server `browser`, preserves other servers and starts nothing. An existing `browser` entry is never overwritten.

CLI alternative (with your actual absolute path):

```sh
pikobot --instance PRIVATE_INSTANCE mcp browser "/absolute/server-home/node_modules/@playwright/mcp/cli.js"
```

Then connect and inspect:

```text
/mcp connect browser
/mcp catalog browser
/mcp status
```

The profile is `PRIVATE_INSTANCE/browser-mcp/profile`; outputs go to `browser-mcp/artifacts`. Both directories are private. Do not point another browser/client at that profile or add `--extension`, CDP, storage-state imports or an existing browser profile. Login state persists independently of chat sessions and is **not** included in Pikobot backups/exports.

New presets delegate their exact tool allowlist through `autonomousTools`. Existing browser configurations are **not silently widened**: if you configured the older approval-gated preset, use `/mcp setup` once to set that server's `autonomousTools` to the same exact names already in `tools`, leave `readOnlyTools: []`, save and reconnect. No profile reset or per-action approval is needed.

On Linux, manual handoff needs a working graphical session and explicitly configured display access. Without a display the upstream server can choose headless operation; headless mode does not provide a human login window. Use `/mcp setup` for deliberate non-secret display/browser configuration. Do not copy account credentials or disable Chrome's sandbox to make setup pass.

## Personal Chrome on another computer

```text
Telegram → Pikobot daemon → loopback SSH forward → desktop browser bridge
                                              → Playwright extension → selected Chrome profile
```

The desktop must be awake, reachable, and running Chrome/its graphical session, the bridge and the tunnel. No unattended login/CAPTCHA solver, automatic infrastructure provisioning, CDP exposure, cookie/profile copying or fallback to another browser is provided. This guided mode supports macOS/Linux and an exact **loopback `/mcp` endpoint**, not a public browser service. For containers, loopback means the Pikobot container's network namespace: a host-only SSH forward is not reachable there. Arrange a private forward inside that namespace deliberately; do not expose the host port publicly or change an owner deployment just to test this mode.

### 1. Pair the selected desktop profile once

On the **personal computer**, install the same reviewed Pikobot build/CLI with the pinned runtime; no Pikobot owner initialization, model credentials or inference is needed. Install Playwright MCP as above and the official [Playwright Chrome extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm). Review [upstream extension instructions](https://github.com/microsoft/playwright/tree/main/packages/extension); extension/server compatibility is a separate gate from Pikobot's transport tests.

In the intended Chrome profile, open `chrome://version` and note only the **last component** of Profile Path, for example `Default` or `Profile 2`. Open that profile's extension status page and copy its `PLAYWRIGHT_MCP_EXTENSION_TOKEN` into the following **separate masked prompt**, never chat, an argument or an environment export:

```sh
pikobot browser-bridge init "/absolute/server-home/node_modules/@playwright/mcp/cli.js" --profile "Default"
```

An explicit `--profile` is required; Pikobot never uses whichever profile happened to be active last. The token lets the official extension authenticate connections without its recurring selection/approval dialog. `init` starts nothing. It creates only `~/.local/share/pikobot-browser-bridge` (or explicit `--bridge-root PRIVATE_DIRECTORY`), with private config/vault files, an independent random bridge bearer and identity. It refuses a nonempty directory, including a Pikobot owner or Chrome profile. The extension token stays in the desktop vault and trusted backend process, not Pikobot-server settings or pairing output. Known bridge credentials are redacted from tool text and rejected in captured file bytes; this is not a defense against malicious trusted software or transformed/visually rendered secrets.

Run the foreground bridge in a desktop terminal:

```sh
pikobot browser-bridge serve
```

It launches only the explicitly installed MCP entrypoint, with `--extension`, the selected `--profile-dir-name`, a temporary output directory and the extension token. It binds authenticated MCP to **127.0.0.1:8931** only; rejects browser Origin headers, hostile Host names, unauthenticated/oversized requests and non-MCP paths. It exposes only the preset browser tools and opaque captured-artifact reads—not Pikobot owner RPC, memory, arbitrary filesystem reads, scripts or uploads. No automatic server restart/replay is attempted if the backend disappears. Use `--port PORT` during initialization if needed.

### 2. Connect the private tunnel and server vault

From another **desktop terminal**, using an already authorized SSH account and a verified server host key:

```sh
ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -R 127.0.0.1:8931:127.0.0.1:8931 SERVER
```

Keep it running. Require server SSH `GatewayPorts no` (the default), or `clientspecified` honoring the requested loopback bind, and verify the actual listener stays private. Never disable host-key verification, enable public forwarding, publish Chrome/CDP, or give the model SSH keys. The server-side forwarding port can differ if explicitly selected in both the tunnel and pairing URL. The bridge itself does not read SSH keys or manage infrastructure.

Send the **bridge bearer**, not the extension token, straight through a private pipe into the authenticated Pikobot owner's vault:

```sh
pikobot browser-bridge pair http://127.0.0.1:8931/mcp |
  ssh SERVER 'pikobot --instance PRIVATE_INSTANCE mcp browser-remote -'
```

Use actual installed CLI paths where SSH's non-interactive PATH differs. `pair` refuses terminal output because its JSON contains a credential; do not use `tee`, shell tracing, chat, shared logs or world-readable files. Alternatively `/mcp browser-remote` accepts that JSON only in a separate **masked** setup dialog and defaults to rejection. Saving adds `browser-remote`, preserves `browser` and other entries, binds credentials to the exact endpoint/bridge identity, starts nothing and refuses to replace an existing entry.

On Pikobot's owner terminal:

```text
/mcp connect browser-remote
/mcp catalog browser-remote
```

Then ask normally, including from trusted Telegram: “Use my personal browser to …”. Its exact browser allowlist is autonomous, including writes/sends; **no per-action approval** is needed. An unavailable desktop/tunnel or wrong profile/token is a blocker, not permission to silently switch accounts, launch a replacement profile or repeat an uncertain action. `connected` proves MCP discovery, not that Chrome is logged in or the website workflow succeeded.

### Handoff, artifacts and disconnect

**HTTP attachment downloads:** the bridge installs a trusted `--init-page` hook on its controlled tabs. It captures complete HTTP(S) attachment-navigation responses (`Content-Disposition: attachment`), then fulfills the same intercepted response so Chrome can continue its normal handling. It never re-fetches the URL, reads `~/Downloads`, copies a profile or changes browser-global download settings. The original site request—including a form submission—can already have taken effect; capture is not a second request or a retry.

Completed decoded bytes receive a generated `download-UUID.ext` filename and enter the same receipt-bound artifact cache as screenshots. Use that **reported generated filename**, not the website's suggested name. Pending captures can be observed with a fresh snapshot, never by repeating their triggering click/submission. An uncertain triggering call does not become successful just because a later observation finds bytes.

Capture is bounded to **10 MB/file**, 30 seconds/transfer and 16 staged transfer records. Oversized, stalled or failed captures can abort the original transfer and leave its site effects uncertain. Blob/data URLs, JavaScript/XHR-generated downloads, partial/range responses and arbitrary existing browser downloads are not supported. Missing bytes are a blocker, not permission to improvise host-file access. Captured content remains untrusted: it is not a Chrome safety verdict, proof of an accepted OS download, or confirmation of a website write. Chrome may independently retain its own download copy outside Pikobot erasure.

**Compatibility:** this hook uses the reviewed Playwright MCP `0.0.83` in-process tab-session internals because extension `0.4.0` rejects the public API's browser-level CDP attachment. It does not request that privilege or expose CDP/code execution to the model. Unsupported internals, active request routing or unexpected Fetch listeners fail closed. Revalidate vendor upgrades; this is not a stable upstream API.

**Live evidence:** an owner-authorized macOS personal-profile check with those versions captured/imported a real CSV through the bridge, using exactly **one HTTP GET**, seven journaled autonomous effects and zero inference/per-action approvals. The import was idempotent, the uniquely identified test tab was closed and temporary credentials removed. A separate fresh-profile headless check verified gzip-decoded CSV/binary POST bytes, the original synthetic HttpOnly cookie, one request per action and no capture from an unrelated tab. These synthetic-site checks do not establish arbitrary-site download support, two-machine SSH or live Telegram/model operation.

- Human handoff uses `/mcp pause browser-remote` and terminal-only `/mcp resume browser-remote`. Complete login/CAPTCHA on the personal computer itself; refresh the snapshot afterwards.
- The same `mcp_artifact_read` / `mcp_import` operations below accept `server: "browser-remote"`. Remote filenames are **not server-local paths**. A completed tool result pins captured bytes behind random, bridge-scoped resource handles and SHA-256/length metadata; Pikobot validates the receipt, connection/credential binding and returned bytes. Generic URL/filesystem fetching is not used.
- The desktop cache is volatile: at most **64 artifacts / 50 MB**, **10 MB per file** (also subject to Pikobot's attachment limit), and 16 files per result. Captured staging files are removed after pinning; old cache entries expire on eviction or bridge stop. Import promptly. Missing/expired/mismatched output fails explicitly—never repeat a browser effect to recover a file. Ordinary imports retain provenance, idempotency, erasure/restore semantics; source erasure during a remote read prevents a late import from resurrecting data.
- `/mcp disconnect browser-remote` closes Pikobot's connection, not personal Chrome or the independently running bridge/tunnel. Stop the bridge and SSH process in their own terminals to revoke reachability and clear the bridge cache. The extension status page can disconnect its clients; disabling/removing the extension revokes further Chrome access. Accepted website actions are not undone.
- Rotate/retarget by stopping the bridge, initializing a **new empty bridge root** with the intended profile/token, explicitly removing the old `browser-remote` entry through `/mcp setup`, and pairing again. Editing a bridge's identity/profile/entrypoint/port cannot inherit its old grant. Do not copy browser profiles, credentials or owner instances to repair it.

## Ask once, browse autonomously

From Telegram or the TUI, ask normally: “Open this public documentation page, inspect its navigation, capture a screenshot and send it to me.” Pikobot discovers the schemas and performs the configured browser actions **without per-action approval**, including navigation, clicks, typing, form submissions, screenshots and downloads. It can continue the workflow within the same foreground turn.

Choosing the preset delegates those exact tools to the assistant once. They remain **effects**, not falsely labelled read-only operations. Each dispatch has a canonical `mcp_autonomous` intention/result receipt; interrupted or lost acknowledgements remain uncertain and are never automatically replayed. Page content, snapshots and server annotations cannot expand the allowlist or grant new permissions. Generic MCP tools without explicit read-only or autonomous grants still use exact terminal approval; async server tasks and optional sampling/elicitation are separate controls, not part of this browser preset.

**Autonomy includes real writes and sends.** The assistant can make a mistaken click, submit information or perform an irreversible action on a logged-in site. Browser website access is independent of Google/API connector write settings. Never put passwords, one-time codes or payment details in chat or browser tool arguments: arguments and results are retained evidence. Login/CAPTCHA still belongs to the human.

The narrow preset excludes arbitrary JavaScript evaluation, `browser_run_code`, uploads, browser installation and page-advertised WebMCP tools. It does not declare any tool read-only and does not grant blanket access to future server tools.

### Read file-backed snapshots

Some Playwright MCP releases return a snapshot filename instead of inline text. Pikobot can use `mcp_artifact_read` with:

- `server: "browser"`;
- `sourceId`: the completed call's `originalResultSourceId` (or find it with `receipts_list`);
- `file`: only the reported filename, for example `page-…yml`;
- optional `fromOffset` / `maxChars` (at most 10,000); follow `nextOffset`.

This reads bounded UTF-8 output without another browser action or document import. Remote files may reconnect/authenticate the same explicitly paired bridge to read cached bytes, not navigate again. A missing/evicted file is an explicit failure. References are from that snapshot, not proof they still identify the same live element; obtain fresh evidence after navigation or human interaction.

## Human login and CAPTCHA

1. Pikobot calls `mcp_handoff`, or you run `/mcp pause browser`.
2. Dispatch stops while the browser stays open. Active calls must finish first; pausing does not cancel them. Pending approvals are invalidated.
3. Complete login/CAPTCHA **yourself in the selected browser**, not in Pikobot, a sampling/elicitation form or a tool argument. Pikobot does not solve challenges or obtain credentials for you.
4. Run `/mcp resume browser` from the authenticated owner terminal. Resuming performs no browser call or inference. Request a fresh snapshot, then continue autonomously. Previously prepared approvals remain invalid.

The pause survives daemon/module restart and blocks safe settings/code refresh until resolved. Status remains available; explicit disconnect can stop the owned server, not undo remote effects. Only the terminal can resume: no model tool or Telegram approval shortcut exists. Handoff is explicit, not an automatic login/CAPTCHA detector or a lock on independent server/browser background activity.

## Keep screenshots and downloads

Use `mcp_import` to retain an image block or download from a **completed canonical MCP tool receipt**:

```json
{"server":"browser","sourceId":"operation:COMPLETED_RECEIPT_ID","contentIndex":1}
```

`contentIndex` is the image block's actual index in the original MCP `content` array, not always 1. For a reported download:

```json
{"server":"browser","sourceId":"operation:COMPLETED_RECEIPT_ID","file":"report.csv","mime":"text/csv"}
```

Operator CLI: supply the same JSON (without `server`) through private stdin to `pikobot --instance PRIVATE_INSTANCE mcp import browser`. `mcp artifact browser` reads a reported text artifact using JSON stdin instead. Advanced RPCs are `extensions.mcp.import` and `extensions.mcp.artifact`.

Imports preserve original bytes as normal attachments/documents with the receipt source, external provenance and content hash. They do not repeat the browser action; remote file imports may reconnect to the same bridge's artifact cache. The same import is idempotent; changed bytes at that identity are rejected. Normal document processing, image-display/delivery services and source-linked forgetting apply. Retaining a format does not guarantee conversion or understanding.

Dedicated-profile file access requires the owner's explicit `artifactDirectory`, a filename reported by that server's receipt, size limits and regular-file checks. Traversal, hidden names, symlinks/hardlinks, arbitrary URLs/host paths, wrong-instance receipts and failed/uncertain receipts are rejected. Local file imports capture the **current output bytes**; remote imports verify the bridge-pinned captured bytes. Neither is cryptographic proof of the remote document's authenticity or of when the server wrote it. Forgetting removes managed imports and linked retained receipts/approval copies, and restore reapplies tombstones. Independent profile/output files and provider/site copies remain outside Pikobot erasure; inspect and clean them deliberately while the server is disconnected.

## Trust and verification

The server runs with your OS-user permissions. Its browser can execute page scripts, contact private/LAN services and retain authenticated sessions. Pikobot's public-only web-fetch restrictions do **not** constrain that browser; MCP transport controls do not proxy its traffic. Browser content can reach the selected model through approved tool results. Neither a dedicated directory, a tool allowlist nor a browser sandbox establishes whole-owner isolation.

Build first, then run `pnpm exec vitest run tests/mcp-browser.test.ts tests/browser-downloads.test.ts tests/browser-bridge.test.ts tests/browser-bridge-cli.test.ts tests/mcp-cli.test.ts tests/tui-setup.test.ts`. The default suite uses synthetic MCP modules, actual stdio/IPC, a faux-model trusted Telegram workflow without approvals, uncertainty/denial checks, and simulated TUI interactions; it does not run Chrome or contact websites. A separate local check used actual Playwright MCP/Chrome with a fresh disposable profile and a synthetic loopback site, including autonomous form submission without approval, not owner logins or a live model. The bridge suites additionally exercise actual authenticated HTTP, a TCP forwarder, owned stdio, compiled CLI/Unix IPC, identity/credential/profile-change denials, immutable remote artifacts, expiry, redaction and erase/read races with synthetic backends. They do **not** prove a real SSH deployment, separate-machine connectivity, extension pairing or personal Chrome/account access. Real sites, vendor login/CAPTCHA, phone delivery, graphical handoff and general browser reliability remain separate verification gates. See [MCP](MCP.md), [security](SECURITY.md) and [testing](TESTING.md).
