# Browser through MCP

An **opt-in prototype** for dynamic websites, accessibility snapshots, clicks, typing, screenshots, PDFs and downloads. Pico remains an MCP client: it does not ship a native browser engine or promise seamless browser parity, sandbox isolation or reliable interpretation of every site.

The preset uses a trusted, separately installed **Playwright MCP server** and installed **Google Chrome**, with a dedicated Pico profile. It never attaches to your regular browser, imports cookies/passwords or installs software on the model's behalf.

## Set up once

Use Pico's [pinned Node/pnpm versions](INSTALLATION.md). Review and explicitly install the upstream server outside the Pico application and owner directories:

```sh
SERVER_HOME="$HOME/.local/share/pico-browser-server"
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
pico --instance PRIVATE_INSTANCE mcp browser "/absolute/server-home/node_modules/@playwright/mcp/cli.js"
```

Then connect and inspect:

```text
/mcp connect browser
/mcp catalog browser
/mcp status
```

The profile is `PRIVATE_INSTANCE/browser-mcp/profile`; outputs go to `browser-mcp/artifacts`. Both directories are private. Do not point another browser/client at that profile or add `--extension`, CDP, storage-state imports or an existing browser profile. Login state persists independently of chat sessions and is **not** included in Pico backups/exports.

New presets delegate their exact tool allowlist through `autonomousTools`. Existing browser configurations are **not silently widened**: if you configured the older approval-gated preset, use `/mcp setup` once to set that server's `autonomousTools` to the same exact names already in `tools`, leave `readOnlyTools: []`, save and reconnect. No profile reset or per-action approval is needed.

On Linux, manual handoff needs a working graphical session and explicitly configured display access. Without a display the upstream server can choose headless operation; headless mode does not provide a human login window. Use `/mcp setup` for deliberate non-secret display/browser configuration. Do not copy account credentials or disable Chrome's sandbox to make setup pass.

## Ask once, browse autonomously

From Telegram or the TUI, ask normally: “Open this public documentation page, inspect its navigation, capture a screenshot and send it to me.” Pico discovers the schemas and performs the configured browser actions **without per-action approval**, including navigation, clicks, typing, form submissions, screenshots and downloads. It can continue the workflow within the same foreground turn.

Choosing the preset delegates those exact tools to the assistant once. They remain **effects**, not falsely labelled read-only operations. Each dispatch has a canonical `mcp_autonomous` intention/result receipt; interrupted or lost acknowledgements remain uncertain and are never automatically replayed. Page content, snapshots and server annotations cannot expand the allowlist or grant new permissions. Generic MCP tools without explicit read-only or autonomous grants still use exact terminal approval; async server tasks and optional sampling/elicitation are separate controls, not part of this browser preset.

**Autonomy includes real writes and sends.** The assistant can make a mistaken click, submit information or perform an irreversible action on a logged-in site. Browser website access is independent of Google/API connector write settings. Never put passwords, one-time codes or payment details in chat or browser tool arguments: arguments and results are retained evidence. Login/CAPTCHA still belongs to the human.

The narrow preset excludes arbitrary JavaScript evaluation, `browser_run_code`, uploads, browser installation and page-advertised WebMCP tools. It does not declare any tool read-only and does not grant blanket access to future server tools.

### Read file-backed snapshots

Some Playwright MCP releases return a snapshot filename instead of inline text. Pico can use `mcp_artifact_read` with:

- `server: "browser"`;
- `sourceId`: the completed call's `originalResultSourceId` (or find it with `receipts_list`);
- `file`: only the reported filename, for example `page-…yml`;
- optional `fromOffset` / `maxChars` (at most 10,000); follow `nextOffset`.

This reads bounded UTF-8 output without another browser call, reconnect or document import. A missing/evicted file is an explicit failure. References are from that snapshot, not proof they still identify the same live element; obtain fresh evidence after navigation or human interaction.

## Human login and CAPTCHA

1. Pico calls `mcp_handoff`, or you run `/mcp pause browser`.
2. Dispatch stops while the browser stays open. Active calls must finish first; pausing does not cancel them. Pending approvals are invalidated.
3. Complete login/CAPTCHA **yourself in the dedicated browser**, not in Pico, a sampling/elicitation form or a tool argument. Pico does not solve challenges or obtain credentials for you.
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

Operator CLI: supply the same JSON (without `server`) through private stdin to `pico --instance PRIVATE_INSTANCE mcp import browser`. `mcp artifact browser` reads a reported text artifact using JSON stdin instead. Advanced RPCs are `extensions.mcp.import` and `extensions.mcp.artifact`.

Imports preserve original bytes as normal attachments/documents with the receipt source, external provenance and content hash. They do not reconnect or repeat the browser action. The same import is idempotent; changed bytes at that identity are rejected. Normal document processing, image-display/delivery services and source-linked forgetting apply. Retaining a format does not guarantee conversion or understanding.

File access requires the owner's explicit `artifactDirectory`, a filename reported by that server's receipt, size limits and regular-file checks. Traversal, hidden names, symlinks/hardlinks, arbitrary URLs/host paths, wrong-instance receipts and failed/uncertain receipts are rejected. File imports capture the **current output bytes**, not cryptographic proof of the remote document's authenticity or of when the server wrote it. Forgetting removes managed imports and linked retained receipts/approval copies, and restore reapplies tombstones. Independent profile/output files and provider/site copies remain outside Pico erasure; inspect and clean them deliberately while the server is disconnected.

## Trust and verification

The server runs with your OS-user permissions. Its browser can execute page scripts, contact private/LAN services and retain authenticated sessions. Pico's public-only web-fetch restrictions do **not** constrain that browser; MCP transport controls do not proxy its traffic. Browser content can reach the selected model through approved tool results. Neither a dedicated directory, a tool allowlist nor a browser sandbox establishes whole-owner isolation.

Build first, then run `pnpm exec vitest run tests/mcp-browser.test.ts tests/mcp-cli.test.ts tests/tui-setup.test.ts`. The default suite uses synthetic MCP modules, actual stdio/IPC, a faux-model trusted Telegram workflow without approvals, uncertainty/denial checks, and simulated TUI interactions; it does not run Chrome or contact websites. A separate local check used actual Playwright MCP/Chrome with a fresh disposable profile and a synthetic loopback site, including autonomous form submission without approval, not owner logins or a live model. Real sites, vendor login/CAPTCHA, phone delivery, graphical handoff and general browser reliability remain separate verification gates. See [MCP](MCP.md), [security](SECURITY.md) and [testing](TESTING.md).
