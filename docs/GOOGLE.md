# Google integration

Google is an optional bundled **trusted in-process extension**, not a sandbox or a core provider client. It supplies Gmail, Docs, selected calendars, saved Contacts, Drive, Sheets and Tasks. Cloud infrastructure, accounts and credentials are never provisioned automatically.

## Setup

1. Create a Google Cloud project and OAuth **Desktop application** client. Enable only the APIs you need: Gmail, Docs, Calendar, Drive, People, Sheets and Tasks. Configure consent/test users externally.
2. Run `/integrations setup google` in a retained TUI session. Enter non-secret settings, then any client secret or Pub/Sub service-account JSON in separate masked dialogs. Blank secrets preserve existing credentials; never paste them into chat or arguments.
3. Run `/integrations auth google` and complete browser consent. Login uses PKCE/state and a bounded loopback callback; cancel with `/integrations cancel google`.
4. Inspect `/integrations status google`. Settings, authentication, missing scopes, push readiness and durable mail checkpoint are separate facts—not proof of end-to-end success.

A minimal non-secret configuration, keeping remote writes off:

```json
{
  "clientId":"YOUR_DESKTOP_CLIENT_ID",
  "mail":{"enabled":true,"send":false,"intervalMs":60000,"baselineMax":200},
  "docs":{"enabled":true,"readAll":false,"write":false,"discovery":false,"documentIds":[]},
  "calendar":{"enabled":true,"write":false,"calendarIds":["primary"]}
}
```

Enable optional `contacts`, `drive`, `sheets` or `tasks` sections deliberately; Sheets/Tasks writes have separate `write:false` defaults. Use one verified Google subject per instance. Later consent cannot silently switch accounts; disconnect removes local authentication, not the identity binding or retained data. Use a separate instance for another account.

Google may require app verification/security assessment, and Testing-state refresh grants can expire. Quotas, policy, billing and account access are external constraints.

## Scopes and capabilities

Scopes use the `https://www.googleapis.com/auth/` prefix except `openid`:

| Capability | Requested scope |
| --- | --- |
| Verified identity | `openid`, `userinfo.email` |
| Gmail read / separately enabled sending | `gmail.readonly` / additional `gmail.send` |
| Docs read / write | `documents.readonly` / `documents` |
| Optional Docs metadata discovery | `drive.metadata.readonly` |
| Calendar read / write | `calendar.readonly` / additional `calendar.events` |
| Saved Contacts | `contacts.readonly` |
| Drive search/download/export/import | `drive.readonly` |
| Sheets read / write | `spreadsheets.readonly` / `spreadsheets` |
| Tasks read / write | `tasks.readonly` / `tasks` |

Saved toggles do not grant OAuth scopes; obtain new consent after changes. Unexpected scopes are rejected. Application selection is **not a narrower Google OAuth grant**. Tokens/secrets stay in the private vault, excluded from application backup/export; no environment/Pi/other-account fallback is used.

For Contacts/Drive/Sheets/Tasks, enable **People API**, **Google Drive API**, **Google Sheets API**, **Google Tasks API** in the same project, enable their settings, then renew consent. A new API key/service account is not required for those user APIs.

## Tools and limits

| Tool | Behavior / boundary |
| --- | --- |
| `google_mail` | Paginated search/thread reads, selected attachment import and prepared sending. Compatibility `mail_search`/`mail_read` remain. |
| `google_docs` | Paginated/tab-aware text, optional metadata discovery, source-backed import and prepared create/append/unique-replace. |
| `google_calendar` | Selected calendars, interval/occurrence reads, free/busy and prepared event changes. |
| `google_contacts` | Bounded saved-contact list/search/exact reads, not directory sync or inferred recipient identity. |
| `google_drive` | Paginated file/shared-drive discovery and explicit bounded downloads/native exports; no crawler, sharing, upload/delete or automatic shortcut traversal. |
| `google_sheets` | Explicit tab-qualified A1 rectangles, at most 1000 cells; approved RAW literals, never formula execution or structural edits. |
| `google_tasks` | Task-list/task reads and approved mutations with ETag/If-Match; assigned Docs/Chat tasks refused. |
| `google_actions` | Local action summaries/exact receipts only, not network access, approval or replay authority. |

Continue returned page tokens. Preservation/import acknowledgment is not completed extraction. Follow the returned document ID with `documents read`; unsupported/encrypted/scanned originals retain their limitations.

Mail attachment IDs are stable opaque references bound to message and MIME part. Use the exact returned ID, never a guessed filename/download token. Imports fetch fresh metadata, reject mismatches/ambiguity, enforce size/cancellation/tombstones and reuse unchanged imports.

Docs JSON/text snapshots preserve external authorship, retrieval/revision metadata and warnings; they are not editable native originals or layout-perfect exports. Embedded images/comments/suggestions and complex layout are not fully understood. Drive native exports have format limits (for example CSV exports only the first spreadsheet tab). Imports do not automatically become personal-memory assertions.

Calendar occurrence-expanded reads may include all-day events with exclusive end dates. `agenda` merges selected calendars without local copies or alerts. Writes require current ETags and explicit offsets; guest-bearing events, recurring-series mutations, invitations/sharing and automatic two-way sync are unavailable. Failed remote contributions mark agenda incomplete.

Tasks due dates are days, not timed reminders. **Sheets has no atomic compare-and-set for literal updates**: concurrent editors can race the approved preflight. Keep writes off for collaborative/high-stakes sheets unless this limit is acceptable.

## Google Docs read access

`docs.readAll:true` permits read or explicit import of any native Google Doc accessible to the connected account; it needs no extra scope beyond configured Docs reads. It does not bulk-download, grant Drive/Sheets/Slides access or bypass Google ACLs. Omitted/false restricts reads to selected/Pikobot-created documents.

This never authorizes an edit. Docs writes still need their toggle, additional consent, a selected/Pikobot-created mutation target, exact terminal approval and revision/tab checks. Optional metadata discovery has its own Drive scope/toggle.

## Exact approval for every remote write

**All Google writes start disabled.** Gmail send, Docs, Calendar, Sheets and Tasks each have independent settings/scopes.

1. Ask Pikobot to prepare an action. It records the exact sender/recipients/body/attachments or target/before/after payload, connection binding, digest and 15-minute expiry. Nothing has been sent/changed yet.
2. Run `/integrations approve google ACTION_ID`. The scrollable terminal review shows exact JSON (including Bcc and escaped directional controls) with **Reject as default**. Model tools/content cannot approve it.
3. Approval rechecks authenticated terminal identity, digest, account/settings/scopes, expiry, source dependencies, bytes and relevant revisions/ETags. Docs replacements must match one unique complete-tab span. Sheets rechecks cells but cannot isolate concurrent editors.
4. Intention and a single-use attempted-action tombstone commit **before** the network effect. Interrupted/lost acceptance becomes uncertain, never an automatic retry—even after restoring an older pending backup.

`/integrations actions google` inspects recent summaries; owner RPC pagination continues older pages. Accepted message IDs prove API acceptance, not recipient delivery. Inspect unknown outcomes in Google before deliberately preparing another action; disabling/forgetting cannot undo accepted sends or edits.

Mail sends support bounded plain text, To/Cc/Bcc, selected-message replies and existing retained file/document references. No host paths/URL attachments, HTML drafts, automatic replies or scheduled sends. Ephemeral/scheduled/review/untrusted/citation-repair mutations are denied.

## Gmail intake and Pub/Sub

Polling remains the basic path. Initial history is bounded and does not create a historical notification storm; expired cursors trigger a bounded rebaseline. Mail content never authorizes replies or becomes trusted owner input.

Optional `mail.push` settings use a topic and pull subscription in the same Cloud project as Gmail OAuth. Externally grant Gmail's service identity Publisher on the topic, give a separate service account only the required subscription access, and enter its JSON through the masked `subscriber` field. Protect/rotate that key and review Pub/Sub billing/IAM.

Push hints are mailbox-identity checked and acknowledged only after durable history catch-up. Periodic reconciliation remains for missed hints/outages. Failed push is degraded, not instant/lossless delivery. Disable/shutdown stops polling/pull cooperatively; remote watches/subscriptions can persist until expiry/cleanup and still incur cloud costs.

Opt-in deterministic `mail.rule` filters control notifications, cooldowns, quiet hours and destinations. They are not instructions from mail or arbitrary model-triggered automation. Intake/ad-hoc reads and local forgetting do not erase Google's originals.

## Troubleshooting and lifecycle

- Gmail login does not enable Calendar or its scope. Explicit calendar `list` needs `calendarId`, `from`, `to`; discover selected IDs first.
- Use the exact displayed browser URL/link. Do not edit scopes or reuse callback codes. Callback URLs contain temporary authorization secrets; never publish them.
- Status provides fixed failure stages and allowlisted codes: invalid client credentials, invalid/expired grant, missing offline token, scope mismatch, account binding, network or local storage. A callback reaching Pikobot does not prove the token exchange succeeded.
- `/extensions disable google` stops dispatch/intake without deleting records. Disconnect removes local OAuth, not Google-side authorization; revoke remotely when needed.
- Existing root Gmail settings/`mail.*` routes remain compatible until extension-owned settings are saved; thereafter generic integration setup is authoritative. Compatibility does not broaden consent or execute retired approvals.

State/snapshots and source dependencies use owner-scoped SQLite. Forgetting tombstones stable external sources across revisions/restores; independently authorized remote reads/storage remain separate. Generic setup/storage/agenda APIs for new providers are in the [SDK](SDK.md).

## Verification limits

Local tests use synthetic Google responses with real SQLite, approval journals, Unix IPC, cancellation, erasure and restore. They are not live consent, Cloud IAM, send/delivery, quota, export completeness or remote-write certification. Verify your own account/services with explicit authorization; do not infer readiness from a saved setting or local test count. [Testing](TESTING.md).
