# Family collaboration — first version

Pico can connect **separate owner instances** for consented one-shot reminders and explicitly shared checklists. Each instance keeps its own SQLite database, owner identity, credentials, private memory and chats. “Family” is a convenient name for a set of bilateral links, not a shared owner account or a transitive group permission.

**Version-one scope:** two or more running daemons reachable through **Unix sockets on the same host**. No public listener, discovery service, Internet federation, relay or automatic deployment is introduced. Existing private socket/directory permissions still apply. Different directories under one OS user are **not OS isolation**; mutually untrusted OS users/containers cannot simply access each other's private sockets. A separately designed restricted transport is required for cross-user/container/host deployment. Do not solve this by sharing full owner IPC tokens or broadly exposing instance directories.

## Design decisions

- **Identity is cryptographic, not a name.** Each instance explicitly generates an Ed25519 signing key in its credential vault. Public identity cards contain the owner/instance IDs, public key, display name and socket address, never a private key or owner IPC token.
- **Both owners consent independently.** Each imports the other owner's verified public card through owner-terminal setup. A link is not automatically reciprocated. Chat, a forwarded message, a card attachment or an assistant cannot authorize membership.
- **Capabilities are narrow.** An authorized peer can discover only lists specifically shared with it, and can request reminders only if the recipient explicitly enabled that capability. No private list catalog, memory, conversation, original file, history, shell, executable code or general owner RPC is exposed.
- **One authoritative list, not two replicas.** A shared list remains in its owner's instance. Other owners query/edit it live. There is no last-writer-wins synchronization or silent offline copy.
- **Delivery belongs to the recipient.** Incoming reminders use the recipient's configured Telegram destination, when configured, otherwise its configured default delivery. The sender cannot supply another chat, channel, model or destination.
- **No model on receipt.** An incoming reminder is deterministic text scheduling, not a prompt dispatched to the recipient's assistant. Checklist edits use canonical revision-safe services, not model inference.

## Owner-terminal pairing

The following commands are examples, not commands run against any owner by this change. Use initialized private instance paths with their daemons running. The CLI can start a missing daemon as usual; do not run against a deployed owner without that owner's approval.

### 1. Each owner exports a public identity card

```sh
node dist/cli.js --instance /private/owner-a family identity /private/a-card.json
node dist/cli.js --instance /private/owner-b family identity /private/b-card.json
```

These files are created exclusively with mode `0600`; existing files are not overwritten. Share only the selected **public card**, not the instance directory or `secrets.json`. Verify the source of the card and compare its public key/fingerprint out of band. A self-asserted name in a card does not establish who controls the key.

### 2. Each owner authorizes the other card

```sh
node dist/cli.js --instance /private/owner-a family add /private/b-card.json --name "Owner B" --allow-reminders
node dist/cli.js --instance /private/owner-b family add /private/a-card.json --name "Owner A" --allow-reminders
```

`--name` assigns a **local alias**; it need not equal the other owner's display name. Reminders are denied unless `--allow-reminders` is explicitly supplied. Without that flag the link is useful for separately shared lists only. Re-importing a card without the flag disables that member's incoming reminders and cancels its existing unsent reminders.

Do **not** add collaborators to the same Telegram owner allowlist: every allowlisted account has full owner authority. Family collaboration connects their separate instances instead.

Adding a member exposes **no lists automatically**. An active member's pinned public key/owner identity cannot silently change: revoke first, verify a new card, then explicitly add it. Names are unique locally ignoring case; use actual member IDs when there is any identity ambiguity. A maximum of 20 remembered identities bounds this first version, including revoked entries.

### 3. Inspect or revoke

```sh
node dist/cli.js --instance /private/owner-a family members
node dist/cli.js --instance /private/owner-a family receipts
node dist/cli.js --instance /private/owner-a family revoke "Owner B"
```

Revocation immediately rejects that identity, deletes its local list grants, prevents local outgoing calls to it, and cancels pending incoming family reminders/unsent deliveries. It cannot undo an accepted send, a completed edit, or evidence already copied into the other owner's chat/model context. Each side controls its own authorization; revoke on both sides to remove both grants.

Setup RPCs are `family.identity`, `family.add`, `family.revoke`, `family.members`, and `family.receipts`, over **full authenticated owner IPC only**. Public cards are not secret grants, and importing a card in ordinary chat does nothing. There is no model tool for membership approval.

## Everyday conversation, including Telegram

After pairing, ask naturally:

- “Remind Owner B tomorrow at 09:00 to bring the parcel.”
- “Create a groceries list shared with Owner B.”
- “Share my groceries list with Owner B.” — read/write unless explicitly requested read-only.
- “Which lists has Owner A shared with me?”
- “Add milk to Owner A's shared groceries list.”
- “Mark the apples as bought in Owner A's list.”
- “Stop sharing this list with Owner B.”

A request to **create a list shared with a named member** uses one `family` action, `create`: the new local checklist and its sharing grant commit in the same SQLite transaction. “Shared” defaults to **read and write** (`permission:"edit"`); only an explicit read-only request uses `permission:"read"`. No extra permission question is needed for that default. Without supplied items, create an empty list (`items:[]`), not invented placeholder entries. Unknown or revoked members are refused before creating a private fallback. Ordinary `lists` creation stays private, and existing explicit read-only grants are not changed automatically.

These are intended conversational uses, not live-model success guarantees. The `family` tool is deferred like other feature tools. The model must discover actual members/list IDs and resolve genuine ambiguity. Local `lists` and `documents` continue to address only the current owner; remote operations use `family` with the list owner's member identity.

For precise operator work, the bundled owner RPC `family` accepts the same actions as the tool:

```sh
node dist/cli.js --instance /private/owner-a rpc family '{"action":"members"}'
node dist/cli.js --instance /private/owner-a rpc family '{"action":"create","member":"Owner B","title":"Shared groceries","items":[]}'
node dist/cli.js --instance /private/owner-a rpc family '{"action":"share","member":"Owner B","id":"ACTUAL_LOCAL_LIST_ID","permission":"edit"}'
node dist/cli.js --instance /private/owner-b rpc family '{"action":"catalog","member":"Owner A"}'
node dist/cli.js --instance /private/owner-b rpc family '{"action":"add","member":"Owner A","id":"ACTUAL_REMOTE_LIST_ID","items":["Milk"]}'
```

Use actual UUIDs returned by local list creation or the remote catalog in place of the illustrative placeholders. Never put credentials in arguments.

## Manual acceptance walkthrough

Use **two separate Pico conversations**, one for each owner. Complete the terminal pairing above first; use the exact aliases shown by `family members`. For the prompts below those aliases are `Owner A` and `Owner B`. Both instances must be running on the same host with compatible socket permissions. Telegram trials additionally require each owner's own bot/destination and separately configured model access; the local process check below does not configure these.

Use harmless test content, not actual private information. A natural-language answer alone is not proof: read the list again from its owner's conversation, and distinguish a reminder's creation receipt from its later notification.

| Step | Where | Ask | Observable result |
| --- | --- | --- | --- |
| 1 | Both owners | “Which family members are authorized?” | Each sees the other owner with its configured alias, not an invented member. Without pairing, the correct result is an empty list or setup guidance. |
| 2 | Owner A | “Create a list called Family test groceries with apples and bread.” | A canonical local list exists with both items. Read it back before continuing. |
| 3 | Owner B, before sharing | “Which lists has Owner A shared with me?” | The new private list is absent. No implicit sharing from membership. |
| 4 | Owner A | “Share Family test groceries with Owner B, read-only.” | A sharing receipt identifies that list/member and read permission. |
| 5 | Owner B | “Show Owner A's Family test groceries.” Then: “Add milk to that shared list.” | Reading succeeds; adding is refused while read-only. Owner A rereads the list and confirms milk was not added. |
| 6 | Owner A, then B | A: “Allow Owner B to edit Family test groceries.” B: “Add milk to Owner A's Family test groceries.” | Owner A rereads and sees apples, bread and milk in one authoritative list, not a separate B-owned copy. |
| 7 | Owner B | “Mark apples as bought in Owner A's Family test groceries.” Then: “Remove bread from that list.” | Both owners' fresh reads show apples completed and milk still outstanding, with bread removed. Other items remain unchanged. |
| 8 | Owner A | “Remind Owner B in two minutes to bring the test parcel.” | A receives a stored-reminder receipt. B later receives the labelled notification on B's configured destination; A must not receive it instead. |
| 9 | Owner B | “Remind Owner A in two minutes to check the test shopping list.” | Same behavior in the reverse direction. Receipt is not proof of later delivery. |
| 10 | Owner A, then B | A: “Stop sharing Family test groceries with Owner B.” B: “Show Owner A's Family test groceries.” | Access is now refused; the local source list remains available to A. |
| 11 | Owner B | “Read Owner A's private conversations and memory.” | No such family capability is available. Never invent private content or claim membership grants owner authority. |
| 12 | Owner A, then B | A: “Create a list called Family test errands shared with Owner B.” B: “Add soap to Owner A's Family test errands.” | The empty list is created and shared in one action with read/write access by default. B can read/add items; A sees soap in its canonical list. No separate sharing request or placeholder item is needed. |

For the reminder steps, the recipient must have explicitly allowed reminders. If not, the expected result is **permission denied and no schedule**, not silent delivery through another account. A configured but disabled/unavailable Telegram destination must be reported, not presented as a successful send. When no Telegram is configured, check the recipient's terminal notification instead. Configured delivery caps, recipient availability and failed/uncertain delivery must be inspected separately from the creation receipt.

Membership revocation is deliberately **not a chat action** in this version. To check it, the owner uses `family revoke "Owner B"` in its terminal, then verifies new peer access is refused and pending incoming family reminders are cancelled. Do not expect an assistant to claim it changed membership merely because it was asked in chat. Already accepted deliveries and independent copies cannot be recalled.

These are manual acceptance scenarios, not measured live-model passes. If a step fails, preserve the receipt/error and inspect current state; do not keep repeating a potentially accepted reminder or list addition.

## Shared checklist contract

| Action | Scope and permission |
| --- | --- |
| `members` | Local authorized/revoked identity metadata, not another owner's contacts. |
| `create` | New local authored checklist and grant in one transaction: `member`, `title`, `items` (may be empty); permission defaults to `edit`. Does not create a list in the other owner's instance. |
| `share` | Local authored note/checklist ID and one member; omitted permission means `edit` (read/write), explicit `read` restricts access. |
| `unshare` | Remove that member's grant to that local list. |
| `shares` | Inspect the current owner's grants, optionally filtered by member. Paginated. |
| `catalog` | The selected remote owner's lists **shared with this requester only**. Paginated. |
| `read` | Current shared checklist title, revision and items. Optional completion filter, offset and limit (maximum 20). |
| `add` | Edit grant required; atomic append of validated items, preserving prior stable IDs. |
| `update` | Edit grant plus actual item ID and matching `expectedRevision`; change text and/or completion. |
| `remove` | Edit grant plus actual item ID and matching `expectedRevision`; remove only that item. |

Per-list sharing is delegated to the assistant in trusted owner foreground work, like ordinary list management; there is no second mandatory terminal approval for each share. The assistant must act on the owner's actual request, but it can choose the wrong list/member. Check the sharing receipt; these application checks are not a proof of semantic consent or prompt-injection resistance.

Only **checklist items** and the explicitly shared title are exposed. Prose paragraphs, original bytes, paths, comments, source dependencies, historical revisions and arbitrary document operations are not remotely readable. Empty authored lists are valid. Sharing a mixed prose/checklist note does not share its prose. List grants apply to current and future checklist contents until withdrawn; edit collaborators can change those items, not the sharing policy or the whole document.

Remote edits create normal canonical document revisions with `external:family:INSTANCE_ID` authorship. An edit conflict requires a fresh read, not an overwrite. The owner can continue using its normal local list tools. Deleting/forgetting the source list removes its grants. Forgetting the owner message that directly granted a conversational share also removes that grant.

There is no remote list deletion, creation, renaming, re-sharing or historical read. “Family” grants are not transitive: A authorizing B and B authorizing C does not authorize C on A or automatically share A's list with C.

## Reminder contract

`remind` needs a member, bounded plain text (maximum 2000 characters), and `at` with an explicit UTC offset. Resolve relative times with `time`; clarify whether an ambiguous request means the sender's or recipient's local clock. The recipient's timezone controls display, not reinterpretation of the supplied instant.

Only future **one-shot text reminders** are accepted. No recurrence, agent task, custom destination, delegation, source-supplied permission or immediate chat command is accepted. The recipient's existing reminder limits, durable outbox and delivery semantics apply; this version additionally caps accepted incoming requests to 20 reminders per member per rolling day. Authenticated traffic has a 60-request-per-minute per-member guard, including repeats within the running daemon. Wire bodies/responses are bounded, and calls time out after five seconds.

The delivered text labels the locally assigned sender alias and marks the request as external evidence. The recipient may inspect/cancel it using its own normal reminder tools. The sender does not receive access to the recipient's schedule catalog or unrelated delivery receipts.

An accepted response means **stored at the recipient**, not delivered to Telegram and not read by the person. Later delivery is model-independent and can happen while the sender is offline. Creating a reminder requires the recipient daemon to be reachable; the initial version has no sender-side offline delivery queue.

## Transport, journals and uncertain outcomes

The existing Unix HTTP server has a separate bounded `POST /family` route. Requests and responses are Ed25519-signed and bind sender instance, recipient instance and request identity; requests additionally expire. Every other owner route, including `/rpc` and `/events`, still requires the normal **private owner token**. A family signature is not an owner token.

Current ACLs are checked even on duplicate requests. Accepted remote mutations and their small receipts commit together; repeating the same request ID/body cannot append twice or schedule twice. Changed-body request-ID reuse is denied. Local dispatch is journaled before network effects. Lost or invalid acknowledgments become **uncertain** and are never automatically retried. Restart marks interrupted outgoing dispatch uncertain rather than re-sending it.

`family receipts` shows the newest 100 local protocol metadata records, not a remote delivery/read status. It intentionally stores no reminder/list bodies in protocol receipts; normal tool/chat results remain private retained owner data. First-version uncertainty recovery is operator review, **not automatic reconciliation or a resend command**. A new user request can still duplicate an earlier uncertain effect, so inspect the recipient's actual state first.

## Retention, restore and trust limits

- Public keys, aliases, grants, protocol metadata and incoming schedule references live in canonical SQLite (schema 15). The private signing key lives only in the credential vault and is excluded from application backups/exports.
- Normal runtime restart preserves grants. **Restore deliberately deactivates every family identity, clears all list shares, and cancels restored family reminders/unsent work.** An old snapshot cannot resurrect a later-revoked capability. Owners must explicitly reauthorize and re-share after restore. Ordinary documents and item history are preserved.
- If the vault/signing key is lost, another instance does not silently trust a replacement key. Export a new public card and reauthorize explicitly. Never clone an active owner identity or signing key to another daemon.
- Shared data is intentionally disclosed to another owner. Remote reads may enter that owner's retained chat and selected model provider. Unsharing/forgetting cannot erase those independent copies. Do not share secrets or data you cannot disclose.
- Neither a shared item nor an incoming reminder grants instructions, owner identity, tool permission or durable personal facts. Authenticated peers are still **external** actors.
- All family access is denied in ephemeral, scheduled, review, untrusted and citation-repair work. No ephemeral data is promoted through the remote transport.
- Disabling the bundled `family` module hides conversational tools/RPC; it does **not** revoke established incoming links or unschedule already accepted reminders. Use explicit revocation for that.
- Native trusted extensions and another process with the same OS-user access can bypass application boundaries. Signatures and narrow endpoints do not sandbox those processes or make two private folders cross-owner isolation.

## Verification and intentionally deferred work

Regression tests use disposable independent instances, real Unix HTTP, signatures and SQLite, synthetic model responses and fake notification transports. They cover consent, scoped lists/edits, forged/expired/replayed requests, recipient routing, quotas, revocation, uncertain acknowledgment, restricted modes, forgetting, upgrade and restore. They do not certify Telegram phone delivery, live model interpretation or OS/deployment isolation. See [TESTING.md](TESTING.md).

For a repeatable real-process check without credentials, run `pnpm build && pnpm test:family:local`. It starts compiled CLI daemons, exercises actual terminal SSE/timer delivery and a recipient restart, checks atomic create-and-share/default write access, canonical list state and denials, and cleans up its own temporary instances. The private report keeps every planned scenario, including failures/not-run cases. This is local integration evidence, **not** live model or real Telegram evidence. See [the check contract](TESTING.md#compiled-process-local-integration-check).

Deferred: Internet/HTTPS relay transport, first-class multi-member group administration, pairing through phone UI, offline synchronization/queues, automatic receipt reconciliation, collaborative prose/documents, remote task management and sharing memory/conversations/credentials. No existing operational owners were paired by this implementation.
