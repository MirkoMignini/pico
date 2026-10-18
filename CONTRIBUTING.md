# Contributing to Pico

Small, complete changes are welcome: bug fixes, focused tests, clearer documentation and useful integrations. Pico is early-stage software; avoid unrelated refactors or new infrastructure for a narrow fix.

## Local setup

Use **Node 24.21.0** and **pnpm 11.2.2**, matching `.node-version` and `package.json`.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check && pnpm build && pnpm test
```

Build before tests: subprocess fixtures import compiled JavaScript from `dist/`. For a focused change, build first and run `pnpm exec vitest run tests/core.test.ts`, substituting the affected suite. [Testing](docs/TESTING.md) explains optional workflows and live-evaluation limits.

Use synthetic data and a disposable instance, never your operational assistant. The optional [development workspace](docs/DEVELOPMENT.md) provides separate TUI, daemon, logs and checks tabs. Do not start another daemon for an instance already in use.

## Documentation site

The [documentation site](https://mirkomignini.github.io/pico/) uses the existing `docs/*.md` guides directly. Edit those files, not generated HTML. The homepage and navigation live in `docs/index.md` and `docs/.vitepress/config.mts`; research proposals and internal comparisons are intentionally excluded. Links to source, fixtures and other repository-only files stay on GitHub.

```sh
pnpm docs:dev      # Local authoring preview
pnpm docs:build    # Production build plus local links, anchors and asset checks
pnpm docs:preview  # Serve the production build
```

The Documentation workflow checks every PR and publishes GitHub Pages after every push to `main`, including documentation-only updates. Failed builds do not replace the published site. Pages uses GitHub Actions as its deployment source; `workflow_dispatch` permits a manual rebuild. No provider credentials, instance data or running Pico daemon are needed.

## Making a change

- Follow the existing TypeScript/ESM style, strict schemas and ownership checks. Edit source, not `dist/`, dependencies or caches.
- Trace callers and update affected tools, RPC, clients, examples and documentation together.
- Add a focused regression for non-trivial behavior, especially denial/error paths. Reuse `tests/helpers.ts`; close stores/runtimes and remove temporary directories.
- Keep SQLite authoritative. Schema changes need ordered migrations, upgrade coverage and backup/restore checks without losing existing data.
- Prefer standard [skills](docs/SKILLS.md) for utilities/procedures; use [extensions](docs/SDK.md) for persistent integrations and daemon hooks. Repo examples must be generic and written in English. Personal skills belong in the private instance, outside Git.
- Keep current documentation useful. Do not add development diaries, machine-specific deployment notes or raw benchmark transcripts to the repo.

Read [security](docs/SECURITY.md) before changing authority, executable code, authentication, retention or forgetting. Coding agents must also follow [AGENTS.md](AGENTS.md).

## Pull requests

Explain what changed, why, the checks actually run and any unverified gates. Distinguish mocked tests, actual local processes and live provider/integration evidence. A successful command is not proof of answer quality, external delivery or isolation.

Never commit credentials, vaults, instance data, personal skills, private logs or generated evaluation reports. Keep synthetic fixtures and third-party license notices. Run `git diff --check` before submitting. Ignore rules are only a guardrail: review staged files, including binary/document metadata, before pushing.

CI checks frozen-lockfile installation, types, builds and the full local suite on Linux and macOS, plus a separate all-history Gitleaks scan. Actions are pinned to commit hashes; Dependabot proposes package/action updates. Production audit has exactly one documented [temporary advisory exception](docs/SECURITY.md#dependency-checks), not a claim of a clean raw audit. Required checks protect `main`; use a pull request for changes.

Live billed requests, connector activity, deployments, owner restarts and destructive operator checks require explicit authorization. Do not run them merely to obtain a green test result. Do not change frozen gold, omit failures or tune against consumed validation cases to claim a pass.

## Reporting problems

Include the Pico revision, Node/pnpm versions, platform, minimal synthetic reproduction and expected/actual behavior. Redact logs before sharing: prompts, instruction snapshots and tool receipts can contain private data.

Do not report credentials or exploitable private details in a public issue. See the [security reporting guidance](docs/SECURITY.md#reporting-a-security-issue).
