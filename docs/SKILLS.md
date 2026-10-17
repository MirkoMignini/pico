# Standard Agent Skills

Pico supports the [Agent Skills format](https://agentskills.io/specification): a named directory with `SKILL.md`, YAML frontmatter, Markdown instructions, and optional scripts, references, assets and other supporting files. This is independent of Pi's coding-agent runtime and global plugins.

## Skill or extension?

| Use a skill | Use a trusted extension |
|---|---|
| Calculators, data transformations, reusable procedures, reports, local scripts and templates | Persistent integrations, channels, RPC routes, timers and daemon lifecycle hooks |
| Instructions and files load progressively; scripts execute only when called | Imports/factories execute in the daemon when enabled/loaded |
| One shared `skills_run` tool, temporary package work copy | Permanently registered native tools/hooks |

Both can execute code with the OS user's permissions. **Neither is a security sandbox.** A skill is the default for a text-analysis utility, not a way to make arbitrary downloaded code safe. `allowed-tools` is advisory metadata, never permission or a bypass of Pico's mode/ownership checks.

## Discovery

Drop packages into this private instance, without restarting:

```text
PRIVATE_INSTANCE/
  skills/                         # higher priority
    example-skill/
      SKILL.md
      scripts/calculate.mjs
      references/format.md
      assets/template.csv
  .agents/skills/                  # compatibility discovery root
    another-skill/SKILL.md
```

Pico scans at startup, in background work, before retained owner turns and before package operations. A duplicate lower-priority name is diagnosed, not merged. Invalid or missing packages are held inactive. Unchanged content retains its revision; changed valid content creates a new revision. Disabled packages remain disabled across edits/restarts. Filesystem drop-ins are an operator trust decision, not untrusted chat attachments.

There is no recursive search of arbitrary project/home folders, `~/.pi`, global skill/plugin discovery, symlink following or ambient credential import. Import an explicitly selected external directory instead. The daemon's host is authoritative: a client-side path on a remote computer is not an upload.

At conversation startup Pico supplies a bounded catalog of names, descriptions, hashes and package locations—not all procedure bodies. It selects matching skills by description, then reads `SKILL.md`; `$example-skill` explicitly activates it. Current instruction bodies are reinserted independently of history/compaction. References and scripts are read on demand, with text pagination; binary resources are available to scripts and ZIP export. At most eight active instruction sets and half the configured context-character budget are allowed per conversation. Keep SKILL.md short and move long material into references.

## Creation and existing files

Ask naturally:

- “Create a reusable utility for comparing the per-kilo prices in this CSV, test it, then use it.”
- “Import this skill ZIP and use it on the attached file.”
- “Use this existing Python script and spreadsheet as resources for a reusable skill.”
- “Create a reusable text-statistics skill and test it on an uploaded draft.”

`skill_build` generates a standard package with bounded format repairs and saves it immediately, without confirmation. It returns file metadata/hash, not a second copy of all generated code. Creation validates **format**, not correctness; the agent must read the installed instructions and run its tests before claiming they passed. Failed/uncertain provider requests, accepted publication and script effects are not automatically replayed as format repairs. Existing disabled status is preserved.

Supported imports: directories, a standalone SKILL.md, ZIP packages, public HTTP(S) URLs, retained uploaded attachments and immutable document originals. Repository ZIPs containing several skills require `subdirectory`, such as `repository/skills/example-skill`; siblings are not installed. A standalone URL/file imports only those bytes—it does not crawl a repository or invent missing referenced files. Import the package ZIP/directory, or explicitly add its support files and license.

Selected ordinary files can be copied into package assets, or supplied as per-execution inputs. Original bytes, including binary files, are preserved. `resources`/`inputs` select exactly one `attachmentId`, `documentId` with optional `revision`, or `localPath`, plus a package-relative `path`. Local imports require the exact absolute/`~/` path in the current authenticated owner message, or an explicit owner CLI/RPC call. Known credential filenames (including nested `secrets.json`, `credentials.json`, `auth.json`, `.env*` and private-key names) and global Pi configuration are refused. This is an accidental-import guard, not a semantic secret scanner or script sandbox. Do not put credentials or personal account setup in a skill.

## Model tools and canonical services

Load the tools through normal deferred discovery. Newly saved packages expose their read/run/management tools on the next model request.

- `skills_read {name,path?,fromOffset?,maxChars?}`: read current package content. The default `SKILL.md` activates **enabled** instructions for this conversation. Inactive canonical snapshots remain inspectable but cannot execute. Inspect `status`, `enabled`, `packageHash`, resource metadata and pagination. Legacy procedural reads retain `{id,version}`.
- `skills {action:"list",offset?,limit?}`: current enabled/inactive metadata and discovery diagnostics. Startup discovery includes only active skills.
- `skills {action:"validate",files}`: inert package-format checks; no script executes.
- `skills {action:"save",files,resources?,expectedHash?}`: complete package creation/replacement. Each file has `path`, `content`, optional `encoding:"utf8"|"base64"` and `executable`. Replacement requires its current hash.
- `skills {action:"write",name,path,content,encoding?,expectedHash}`: replace/add one file, preserving the rest. Renaming requires a new package. Pending publication conflicts must be resolved before another edit.
- `skills {action:"import",attachmentId?|documentId?|url?|localPath?,revision?,name?,filePath?,subdirectory?,expectedHash?}`: exactly one source. To add a non-skill file to an existing package, supply `name`, a non-SKILL.md `filePath`, and `expectedHash`.
- `skills {action:"enable"|"disable"|"delete"|"export",name}` and `{action:"rollback",name,version}`: enable/disable, dependency-aware forgetting, ZIP export, or publish an earlier snapshot as a new revision. Disable does not delete files/history. Model ZIP exports are bounded previews; use owner CLI for actual downloads.
- `skill_build {specification,resources?,expectedHash?}`: selected-model generation; no provider/credential fallback or dependency installation.
- `skills_run {name,script,args?,input?,stdin?,inputs?,outputs?,timeoutMs?,expectedHash?}`: run an installed script after reading the current SKILL.md. Use JSON `input` or text `stdin`, never both. The runtime pins the current immutable package hash before journaling. Identical arguments **and revision** within a run reuse their receipt; a changed revision cannot inherit old test results. Uncertain intentions and failed interpreter starts are not replayed.

Trusted extensions use the same canonical services: `context.services.readSkill({name,path?})`, `skills(request)` and `runSkill(request)`. Their schemas, identity, budgets, journals, mode denials and provenance are unchanged by the caller. Owner RPC routes are `skills.request`, `skills.read`, `skills.run`, `skills.build`; legacy `skills.learn/list/approve/rollback` remain for procedural records. Legacy name collisions fail explicitly rather than silently broadening scoped instructions into executable packages. Bounded workflows cannot generate/manage executable packages.

## Script execution

The runner copies the immutable DB snapshot into a private temporary directory. Current working directory is that package root; resolve `scripts/`, `references/` and `assets/` relative to it. Input files appear under `inputs/`; request retained output paths explicitly, normally under `outputs/`. Scripts can import sibling helpers. Temporary work is removed after settlement; publication does not execute imports or scripts.

Supported runtimes: Node.js (`.js/.mjs/.cjs/.ts/.mts/.cts`), Python (`python3`), Bash, Ruby and Perl **when installed**. Node uses the running pinned executable; TypeScript supports Node's erasable syntax, not JSX or runtime-only TS constructs. Other runtimes/dependencies must be installed explicitly by the operator; compatibility metadata describes prerequisites. Pico does not run pip/npm/uv installers, provision containers, borrow provider keys or translate arbitrary host-specific tool APIs automatically. An otherwise valid skill can need unavailable tools, dependencies or APIs; report the actual blocker rather than promising universal execution compatibility.

The child receives a small environment with temporary HOME/XDG/TMP locations, PATH and `PICO_SKILL_ROOT`, `PICO_SKILL_INPUTS`, `PICO_SKILL_OUTPUTS`; provider keys, `NODE_OPTIONS`, Python search paths and ambient secrets are not forwarded. **This does not stop trusted code from reading the host's files/vault or accessing the network.** PATH and installed interpreters are part of the trusted host.

Defaults/limits:

| Boundary | Limit |
|---|---|
| Discovery | 200 package directories per scan; scanning revalidates bounded package bytes, not an unlimited file watcher |
| Package | 256 files, 4 MB/file, 10 MB total; SKILL.md ≤128 KB |
| ZIP | 10 MB compressed/expanded total, 2,048 archive entries; traversal, duplicate/case/prefix collisions, links/special files and lying expansion sizes rejected |
| Metadata | Standard name ≤64 normalized lowercase Unicode letters/digits with single hyphens; description ≤1,024 characters; compatibility ≤500; metadata values strings |
| Instructions | >500 SKILL.md lines produce a recommendation warning, not an invented format requirement |
| Invocation | ≤64 string args; JSON/text stdin ≤200 KB; ≤16 selected input/output files; selected input resources ≤4 MB/file and 10 MB total |
| Execution | 30 seconds default, 60 seconds maximum, shared parent cancellation/deadline; Node heap bound 128 MiB, **not** a hard whole-process/OS resource cap |
| Streams | 1 MB combined stdout/stderr; limit terminates the process group |
| Returned files | 4 MB/file, 10 MB total; regular bounded files only, no links |

Timeout/cancellation terminates the invocation's POSIX process group, escalating to SIGKILL; a successful parent exit also cleans up its remaining group. Code can deliberately escape that group, consume host resources or perform irreversible effects. Receipts distinguish `completed`, `failed`, `cancelled`, `timed_out`, `output_limit`, exit code/signal, streams, duration and retained attachment IDs. Exit zero means the script returned, **not** accepted external delivery or mathematical correctness. Nonzero/unknown outcomes can still have effects. Never automatically rerun to recover an acknowledgment; inspect historical receipts.

## Retention, deletion and restore

Owner-scoped SQLite stores immutable package bytes, hashes, metadata, revisions and consulted-source dependencies. Private filesystem projections publish with a recoverable stage/rename journal; revision conflicts preserve existing files. No generated `dist/` or global plugin path is used.

Retained trusted owner foreground work alone can create/import/change or execute packages. Ephemeral chats can read existing instructions/resources without durable activation/lineage, but cannot install/run scripts. Scheduled/review/untrusted/citation-repair work cannot write or execute. Instructions and imported contents never become authority.

Forgetting a linked input erases dependent packages, managed files, script-output attachments, imported derivatives and conservative assistant/tool history. Tombstones prevent silent discovery/old-backup resurrection. Independently written host files, network effects, downloaded copies and OS/provider snapshots are outside this managed erasure boundary. Disabling/replacing/forgetting cancels tracked running package jobs, without undoing accepted writes.

Backups include authoritative package blobs and outputs, not credentials or temporary work directories. Restore verifies file/package integrity, applies deletion history, reconstructs only canonical packages and preserves disabled status. Existing/post-snapshot drop-in directories move to private `skill-recovery/UUID/` for review instead of silently becoming restored capabilities. Managed source forgetting cannot erase independently preserved external copies; protect/purge recovery copies accordingly.

## Operator examples

Normal use is through chat; commands are administrative controls, not a required daily workflow:

```sh
node dist/cli.js --instance PRIVATE_INSTANCE skills list
node dist/cli.js --instance PRIVATE_INSTANCE skills import /absolute/path/to/text-statistics
node dist/cli.js --instance PRIVATE_INSTANCE skills read text-statistics
printf '{"text":"hello world"}' | node dist/cli.js --instance PRIVATE_INSTANCE skills run text-statistics scripts/analyze.mjs -
node dist/cli.js --instance PRIVATE_INSTANCE skills export text-statistics /new/path/text-statistics.zip
node dist/cli.js --instance PRIVATE_INSTANCE skills disable text-statistics
```

TUI `/skills` lists package metadata/diagnostics; `/skills read NAME [PATH]`, `import PATH`, `enable NAME`, `disable NAME`, `delete NAME` and `rollback NAME VERSION` administer them. Existing procedural review/approval remains separate. These operator calls create operational receipts/activations; TUI read/import/change administration is refused in a selected ephemeral session—ask Pico in chat for volatile instruction/resource reads.

The [English text-statistics example](../examples/skills/text-statistics/SKILL.md) is a portable standard package with scripts, reference documentation, a sample asset, a license, JSON input/output and an optional report attachment. Run `node examples/skills/text-statistics/scripts/test.mjs`; the Vitest suite also covers Unicode/counting rules, invalid input, selected files, private non-overwriting output, compiled CLI and agent-core execution.

Repository examples are not installed automatically. Personal skills belong in the instance's private `skills/` directory and authoritative database, not `examples/skills/`. Removing or updating a repo example does not change an independently installed private package. The approved repo-local development instance is `.instances/dev`; its skills are Git-ignored, like future skills created there.

See [security](SECURITY.md), [SDK](SDK.md) and [verification limits](TESTING.md) for trust boundaries and executed versus unverified gates.
