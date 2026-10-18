# Testing and verification

Pico is early-stage software, not a production reliability or security certification. Local regressions, real subprocess/transport checks, live model answers and actual connector delivery are different kinds of evidence. Report them separately.

## Default checks

Use Node **24.21.0** and pnpm **11.2.2**:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check && pnpm build && pnpm test
git diff --check
```

Build first: CLI, crash-recovery and worker fixtures import `dist/`. Subprocess-heavy CLI tests allow multiple cold starts with explicit test deadlines and per-command limits, not automatic retries. Tests use temporary instances and synthetic data; model/OAuth/Bot responses are generally mocked. Some tests run actual Node/Python/Bash and available Ruby/Perl subprocesses, native document conversion, authenticated Unix HTTP/SSE and the TUI with a simulated terminal. Those checks do not establish live provider entitlement, physical-terminal rendering, semantic accuracy or OS isolation.

For a focused suite:

```sh
pnpm build
pnpm exec vitest run tests/skills.test.ts
```

Keep regressions for migrations, retained compatibility, source erasure, cancellation and uncertain effects. An old data format is not an obsolete test when current code still supports it.

## Public CI and release checks

[CI](../.github/workflows/ci.yml) runs frozen installation, check/build/tests on Linux and macOS without provider credentials, plus checksum-verified Gitleaks across all reachable public Git history. Production auditing gates other high/critical findings with the one explicit [known exception](SECURITY.md#dependency-checks). Dependency/action updates are proposed weekly. Neither CI nor secret scanning certifies safety or live reliability.

Before a release, repeat the default checks from a fresh checkout without copied configuration, inspect `pnpm audit --prod` without exclusions, and review the actual files being published. Scan the selected snapshot with a current trusted secret scanner, including bounded archive inspection for document fixtures. Do not scan a live instance or upload its contents. A public source snapshot must not acquire private branches, deleted reports, local instances or Git object history from a private development repository.

The [no-credentials demo](DEMO.md) provides a bounded newcomer walkthrough. Screenshots and examples must use synthetic data; never publish private logs as release evidence.

## Repeated workflows and memory stress

```sh
pnpm test:daily --repeat 2 --output /tmp/pico-daily-report.json
pnpm test:memory:stress
```

The daily runner covers memory/corrections, documents/citations, checklists, appointments and separate reminders, executable-code review, uncertain delivery, restore, outages and restricted-mode denials. Its synthetic providers/connectors make it safe to run without credentials. The stress runner uses synthetic vectors, not live semantic-quality measurements.

Daily prompts/gold and their SHA-256 manifest live in `eval/daily-assistant*.json`. Reports use exclusive private file creation; existing reports are not overwritten. All scenarios remain in the denominator, including failures. Scripted latency is not live response latency, and scripted usage cannot establish a model-quality score.

## Document conversion and retrieval

Cached fixtures and their hashes/licenses live in `tests/fixtures/knowledge/`. They exercise actual formats, malformed/encrypted inputs and unsupported extraction. No hosted OCR is enabled.

```sh
pnpm build
node scripts/check-knowledge-offline.mjs
```

The converter check rejects attempted fetches in-process. For a separate OS-level network boundary, explicitly build/run the optional validation image:

```sh
docker build -f deploy/Dockerfile -t pico-app:0.1.0 .
docker build -f deploy/knowledge-test.Dockerfile -t pico-knowledge-validation:local .
docker run --rm --network none pico-knowledge-validation:local /app/scripts/check-knowledge-offline.mjs
```

`node scripts/evaluate-knowledge.mjs --output /tmp/pico-document-retrieval.json` uses a disposable synthetic corpus, actual QMD retrieval and growth notes. It can download roughly **2.1 GB** of local weights and needs several GiB of RAM. It measures retrieval, not generated-answer correctness. Do not use an operational `--root`.

The development-only fixture generator is `uv run --project scripts/knowledge-fixtures python scripts/knowledge-fixtures/generate.py`. It pins its Python environment, preserves cached public originals and refuses to overwrite different frozen document gold. Ordinary tests need no Python fixture regeneration.

## Family collaboration

After building, `pnpm exec vitest run tests/family.test.ts` exercises disposable independent daemons over actual Unix HTTP, signed request/response verification, reciprocal consent, scoped list grants/revision conflicts, recipient-controlled reminder delivery, denial/quotas/replay, revocation, source erasure, uncertain acknowledgment, CLI cards, upgrades and restore. Models and notification providers are synthetic. These tests do not establish real Telegram delivery, phone interpretation, cross-host networking or OS/container isolation. No deployed owners are paired; see [Family](FAMILY.md).

### Compiled-process local integration check

```sh
pnpm build
pnpm test:family:local
```

This starts **new disposable compiled CLI daemon processes**, with no runtime/model mocks or existing instance arguments. It exercises CLI card export/import and consent, private defaults, atomic shared creation with default read/write access, explicit read/edit grants, append/complete/remove and stale revisions, pagination, unsharing, actual wall-clock scheduling and terminal SSE delivery, recipient restart and reverse-direction delivery, revocation and pending cancellation. It asserts distinct owner/instance/PID identities and no model usage/credentials. Only the empty recipient archive has short automatic ticks, avoiding semantic model downloads for the source's documents.

The check never attaches to deployed owners, borrows credentials, enables Telegram or invokes a model. It gracefully stops only its own subprocesses and removes their instance directories; private reports and daemon logs remain under a printed `/tmp/pico-family-local-…` directory, including failures. Every planned scenario remains in the report as passed, failed or not run. `node scripts/check-family-local.mjs --help` performs no file/process operations; unknown arguments and omission of `--run` are refused.

This is a **real local process/transport/scheduler check**, not live model interpretation, real Telegram delivery, deployment isolation or cross-host federation. A live model/Telegram trial needs separately approved accounts and synthetic data. The [manual walkthrough](FAMILY.md#manual-acceptance-walkthrough) gives exact prompts and observable outcomes for owners to verify after pairing.

## MCP interoperability

After building, `pnpm exec vitest run tests/mcp.test.ts tests/mcp-oauth.test.ts tests/mcp-network.test.ts tests/mcp-cli.test.ts` exercises actual disposable stdio processes/process-group cleanup, legacy and modern HTTP, legacy SSE, paginated catalogs, resources/prompts/completion, input/output validation, exact single-use approvals, task wire compatibility, credential binding/redaction and restricted-mode denials. The OAuth suite uses actual local HTTP discovery, registration, PKCE callbacks, issuer/state rejection, token refresh and client-credentials with synthetic accounts. `tests/tui-setup.test.ts` covers masked MCP entry and ephemeral/admin denials. Sampling uses a faux model; no vendor login or billed inference is proven.

The separately authorized `pnpm test:mcp:live` checks public credential-free Microsoft Learn and DeepWiki tool discovery and read calls, using new disposable stores only. It accepts no existing instance or credential arguments, installs no MCP servers, invokes no Pico model, preserves failures in a private temporary report and follows canonical receipts for large results instead of replaying calls. Public service availability, actual vendor OAuth, real model interpretation and production reliability remain separate gates. `node scripts/check-mcp-live.mjs --help` is inert; `--run` is required for network/process work. See [MCP](MCP.md).

## Live trials require authorization

Never run live calls merely to complete the default check command. Obtain authorization for the exact provider/account and any metered auxiliary services. Use a separate synthetic store, not owner data. Credentials may be used only through the explicitly selected Pico credential service, never copied or discovered from ambient tools.

Examples, **only after authorization**:

```sh
pnpm test:daily --mode live --authorize-paid-model \
  --credential-root PRIVATE_AUTHORIZED_INSTANCE --model provider/model-id \
  --repeat 2 --output /tmp/pico-daily-live.json

pnpm test:memory:live --credential-root PRIVATE_AUTHORIZED_INSTANCE \
  --fixtures eval/mem0-validation.json --repeat 2 --output /tmp/pico-memory-live.json

node scripts/validate-knowledge.mjs --credential-root PRIVATE_AUTHORIZED_INSTANCE \
  --provider openai --openai-model EXPLICIT_MODEL_ID --output /tmp/pico-documents-live.json
```

The memory harness uses DeepSeek chat/extraction and OpenAI embeddings; it requires those configured API credentials. The document harness defaults to both configured API providers unless `--provider` selects one, and semantic indexing can download weights. Read [evaluation rules](../eval/GRADING.md) and the relevant script before running. These are not connector or deployed-owner checks.

## Grading and reports

- Preserve every attempted case, failed/uncertain receipt and incomplete usage record. Never replay an action to recover acknowledgment.
- Retrieval recall, extraction coverage, attribution, answer correctness and abstention are separate gates. Source resolution and model/tool completion do not prove factual support.
- Keep gold out of product code and model/index inputs. Do not change expectations, widen retrieval or drop failures to manufacture a pass. Consumed validation sets are regressions, not untouched holdouts.
- Review every answer against original evidence and actual effects. Provider token-price estimates are not invoices, subscription charges or spending caps.
- Keep raw reports private and outside Git. Historical run dumps are deliberately not shipped; their absence is not a claim that earlier runs passed.

The daily runner can bind a separate manual review to the exact raw report bytes:

```sh
pnpm test:daily --review /tmp/pico-daily-live.json \
  --decisions /tmp/pico-review-decisions.json --output /tmp/pico-reviewed.json
```

A decisions file contains `reportSha256`, an identified `reviewer`, and one `{id,iteration,passed,safetyFailures,reason}` entry per scenario/repetition. It cannot waive functional/state failures or actual safety violations. Even a bounded reviewed pass does not establish general production quality.

## Deployment checks

The optional `scripts/check-two-owners.mjs` **writes fixtures, activates code, creates a reminder and restarts a container**. It requires explicit disposable-deployment authorization; it is not a read-only health check. Read [deployment](DEPLOYMENT.md) first. Do not use it against valuable owner data.

Real provider authentication, Google permissions/writes, Telegram receipt/rendering/playback, whole-owner isolation, physical UI behavior and production upgrades require separately authorized verification. None is established by a local test count.
