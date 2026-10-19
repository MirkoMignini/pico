# Try Pikobot without credentials

This short demo uses synthetic data, no provider accounts, no connector setup and no billed inference. It demonstrates deterministic skill execution and real local family transport—not live conversational quality or Telegram delivery.

Use the pinned Node/pnpm versions and complete the [quickstart install/build](../README.md#quickstart) first.

## 1. Run the portable sample skill

The example uses Node builtins only. It does not start a daemon, read an owner instance or use the network:

```sh
node examples/skills/text-statistics/scripts/test.mjs
printf '%s' '{"text":"Hello, world!"}' | node examples/skills/text-statistics/scripts/analyze.mjs
```

Expected statistics:

```json
{"characters":13,"words":2,"lines":1}
```

Read the [skill package](../examples/skills/text-statistics/SKILL.md) for counting rules, inputs and trust limits. This invokes the script directly, not through a model or Pikobot's managed skill service.

## 2. Exercise disposable independent assistants

```sh
pnpm test:family:local
```

This check creates fresh temporary instances and starts **only its own compiled daemon processes**. It exercises owner pairing, checklist sharing/revocation, reminder scheduling and terminal delivery, then gracefully stops its processes and removes their instances. It never attaches to your existing assistant, uses credentials, enables Telegram, invokes a model or launches Docker. Private diagnostic reports remain in the printed temporary directory; do not publish them unreviewed.

Read the [exact checks and limits](TESTING.md#compiled-process-local-integration-check). A successful result establishes these bounded local behaviors, not phone UX, model understanding, Internet federation or OS isolation.

## 3. Try conversational use separately

Follow [setup](SETUP.md) only when you are ready to configure your own accounts and accept provider costs. The README's conversational examples require that separate setup; this demo neither fakes model answers nor silently enables paid services.
