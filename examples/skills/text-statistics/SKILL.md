---
name: text-statistics
description: Count characters, words and lines in supplied text or UTF-8 files using a deterministic local script. Use when the owner asks for text statistics or wants to check the length of a draft, note or uploaded text file.
license: MIT; see LICENSE.txt
compatibility: Requires Node.js 24. No external packages or network access.
metadata:
  author: Pico
  version: "1.0"
---

# Text statistics

Use this skill for mechanical counts, not summaries, readability scores or language-aware word segmentation. Reply in the owner's language; the instructions, script interface and reports are in English.

## Workflow

1. Read this SKILL.md before running scripts. Read [the format reference](references/format.md) when you need the counting rules or file examples.
2. For a new or modified installation, run `skills_run` with `name:"text-statistics"` and `script:"scripts/test.mjs"`. Check the actual status and exit code before claiming tests passed.
3. Analyze supplied text with `skills_run`:

   ```json
   {"name":"text-statistics","script":"scripts/analyze.mjs","input":{"text":"Hello, world!"}}
   ```

   The result is `{"characters":13,"words":2,"lines":1}`.
4. For an uploaded text file, select it through `inputs`, then use `args:["--file","inputs/draft.txt"]`. Omit JSON input/stdin in file mode. Packaged files work too: `args:["--file","assets/example.txt"]` analyzes the bundled sample.
5. To return a report attachment, add `args:["--output","outputs/report.json"]` and `outputs:["outputs/report.json"]` to a text request. File mode can combine `--file` and `--output`. Existing output files are never overwritten.
6. Report counts only when `status` is `completed`, `exitCode` is 0 and stdout is valid JSON. Explain genuine input errors rather than inventing a result. Help is available with `args:["--help"]`.

Do not automatically rerun an uncertain/timed-out invocation to recover its receipt. Use Pico's historical receipts instead.

## Counting rules

- Characters are Unicode code points, including spaces and line endings—not bytes or user-perceived grapheme clusters. A combining mark counts separately; an emoji represented by one code point counts once.
- Words are non-empty runs separated by JavaScript whitespace. Punctuation stays attached; this is not linguistic word segmentation.
- LF, CRLF and CR delimit lines. Empty text has zero lines; a final line ending does not create an extra empty line. Other blank lines do count.
- File mode requires UTF-8, ignores an initial UTF-8 BOM and fails on invalid encoding. It reads only a selected `assets/` or `inputs/` path relative to the skill work copy, not an arbitrary host path.

## Safety and portability

This is a small standard Agent Skills example: instructions, scripts, reference documentation, a sample asset and a license. It uses Node builtins, no Pico imports, credentials, external packages or network calls. It writes only an explicitly requested report under `outputs/`.

Pico runs it as the OS user in a private temporary copy. That is **not an OS security sandbox**; review any changes before trusting different code.
