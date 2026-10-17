# Evaluation rules

This directory contains **synthetic frozen inputs and grading expectations**, not owner data or published benchmark scores. Product code does not import gold answers. See [testing](../docs/TESTING.md) for commands, dependencies and authorization requirements.

## Maintained protocols

| Files | Purpose |
| --- | --- |
| `daily-assistant.json`, `daily-assistant-gold.json`, `daily-assistant-manifest.json` | Repeated whole-workflow regression and separately bound manual review. The runner verifies SHA-256 hashes before execution. |
| `knowledge-gold.json` | Document retrieval/answer probes against the cached conversion fixtures; fixed depth 10, supporting-evidence and answer gates assessed separately. |
| `mem0-validation.json` | Default natural-message memory/extraction validation. |
| `mem0-independent.json`, `mem0-sourced-recall.json`, `mem0-canonical.json` | Additional memory regressions covering sources, attribution and owner-namespace behavior. Select explicitly with `--fixtures`. |

These sets have been used during development. Do not call them untouched holdouts or tune product behavior to their answers and claim new generalization. Further quality tuning requires a newly frozen independent set.

## Safe execution

- Build first. Read the selected harness before running it.
- Local regression tests use fake providers and disposable synthetic instances. Live harnesses require explicit credential-service selection and authorization for all billed chat, extraction and embedding calls.
- Never point a synthetic reset/import/restore at an operational instance. Do not copy credentials or borrow another application's account.
- Keep generated reports outside Git, preferably in a new private path under the OS temporary directory. Preserve previous attempts; do not overwrite failures with a successful repeat.
- Document retrieval can download local QMD weights and consume several GiB of RAM. Memory evaluation uses the configured metered services, not an automatically selected free fallback.

## Memory measurements

`pnpm test:memory:live` ingests natural synthetic messages through the foreground runtime, runs extraction/indexing, reconstructs the runtime and asks fresh-conversation questions. It checks retained sources, inferred provenance, persistence, forgetting and ephemeral boundaries.

The foreground retrieval measurement is the **first model-selected memory search**, capped at ten results; no search means an empty result set. Standalone retrieval is a different measurement and must not be pooled with it. Retrieval support does not establish that every subfact of a multi-hop answer was retrieved or answered correctly.

Extraction coverage, precision, quote/context fidelity, person attribution, source recall, answer correctness and unknown-fact abstention are separate results. A substring/alias matcher is not a complete factuality grader. Inspect contradictions, current versus historical claims, quoted owner assertions, inferred facts and third-party identities against original evidence.

## Reporting

Include the exact protocol/build hashes, model/account type, embedding configuration, retrieval depth, all cases, failures, tool receipts, usage completeness and review method. Repeats show variation; they are not new independent questions. Distinguish a missing-credential blocker from a measured failure.

Never change gold, add expected answers to product/model context, increase retrieval depth, omit failures or silently retry uncertain effects to pass a gate. Keep raw automatic outcomes unchanged; put any source-grounded adjudication in a separate report bound to their exact hash. Review cannot waive an actual safety or functional failure.

Historical run outputs and deployment diaries are not distributed with the source tree. No previous score is a current release claim; maintainers must record the checks they actually run. Local mocks, successful process exit and valid citations are not proof of live correctness, delivery, isolation or production readiness.
