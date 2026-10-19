# Input and report format

## Text input

Send a JSON object containing exactly one `text` string on stdin:

```json
{"text":"Hello, world!"}
```

The script returns one JSON object on stdout:

```json
{"characters":13,"words":2,"lines":1}
```

Empty text is valid and returns three zeroes. Missing/non-string text, arrays, extra fields and malformed JSON fail with a diagnostic on stderr, no report and exit code 1. Successful invocations exit 0.

## Files and attachments

Use `--file assets/example.txt` for the bundled UTF-8 sample. It has 30 characters, four words and two lines, including its two LF characters in the character count.

To analyze an existing uploaded attachment through Pikobot:

```json
{
  "name":"text-statistics",
  "script":"scripts/analyze.mjs",
  "args":["--file","inputs/draft.txt","--output","outputs/report.json"],
  "inputs":[{"attachmentId":"RETAINED_ATTACHMENT_ID","path":"draft.txt"}],
  "outputs":["outputs/report.json"]
}
```

Select the actual retained attachment ID; never invent one. Document originals can use `documentId` with an optional immutable `revision` instead. Explicit input files are copied by Pikobot into `inputs/`; no host-directory scan or upload occurs inside this script.

The optional `--output outputs/report.json` saves the same JSON printed on stdout. Pikobot can retain that file as an owner-scoped attachment. Output files use private permissions and are not overwritten. Relative paths cannot traverse out of the named resource folders; this path validation is not an OS sandbox.

## Standalone use

From the skill directory:

```sh
node scripts/test.mjs
printf '{"text":"Hello, world!"}' | node scripts/analyze.mjs
node scripts/analyze.mjs --file assets/example.txt --output outputs/report.json
node scripts/analyze.mjs --help
```

Counts are deterministic code-point/whitespace/line counts, not a language-specific tokenizer, document converter or semantic analysis. For example, `"Hi 👋\nBye"` has eight characters, three words and two lines; `"e\u0301"` has two characters but may display as one glyph.
