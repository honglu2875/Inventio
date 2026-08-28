# `@inventio/codex-sim` — contract

A fake `codex` CLI that mirrors the `codex exec` surface of codex-cli 0.149.0
(DESIGN.md §8) and replays a scripted scenario instead of calling a model. It
exists so the orchestrator can be developed and tested — including crash,
malformed-output, hang and resume paths — without burning API quota.

Zero runtime dependencies, plain ESM, Node >= 20. `vitest` is the only
devDependency.

```
packages/codex-sim/
  bin/codex-sim.mjs   # executable (shebang + exec bit)
  lib/args.mjs        # argv parser
  lib/scenario.mjs    # scenario load, state dir, call selection
  lib/run.mjs         # main flow
  fixtures/*.json     # scenarios used by the tests
  test/sim.test.mjs   # vitest, spawns the real bin
```

---

## 1. Invocation

```
codex-sim exec [FLAGS] [PROMPT|-]
codex-sim exec resume <THREAD_ID> [FLAGS] [PROMPT|-]
```

The prompt comes from:

1. the single positional argument, if present and not `-`;
2. stdin, if the positional is `-`, or if there is no positional and stdin is
   not a TTY (piped). stdin is read to EOF and used **verbatim**, including any
   trailing newline;
3. otherwise the empty string (no positional, stdin is a TTY).

More than one positional argument is a usage error (exit 2) — `exec` takes a
single PROMPT. `--` ends flag parsing; everything after it is positional.

### Flags

Parsed correctly, mostly ignored semantically. Only `-C`, `--json` and
`--output-last-message`/`-o` change behavior.

| Flag | Value | Effect |
| --- | --- | --- |
| `--json` | — | emit the JSONL event stream. Without it, only the final message text is printed. |
| `--ignore-user-config` | — | accepted, ignored |
| `--strict-config` | — | accepted, ignored; production Codex validates Inventio's generated settings |
| `--skip-git-repo-check` | — | accepted, ignored |
| `--ephemeral` | — | accepted, ignored |
| `-C <dir>` | dir | `chdir` before anything else observable happens |
| `-s <mode>` | mode | accepted, ignored |
| `-m <model>` | model | accepted, ignored |
| `-p <profile>` | profile | accepted, ignored |
| `-c <key=val>` | repeatable | accepted, ignored |
| `--enable <f>` / `--disable <f>` | repeatable | accepted, ignored |
| `--output-schema <file>` | file | accepted, **content never read**; the sim does not validate the final message |
| `--output-last-message <file>`, `-o <file>` | file | write the final message text there |
| `--color <c>` | c | accepted, ignored |
| `-i <file>` | repeatable | accepted, ignored |

Both `--flag value` and `--flag=value` are accepted; short flags accept
`-C dir`, `-C=dir` and `-Cdir`.

**Any unknown flag or subcommand, or a value flag with no value, exits 2 with a
message on stderr** — this is deliberate, so orchestrator flag drift fails loudly.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | `ok` / `malformed-output` completed |
| 2 | usage error, bad/missing scenario, or no scenario call matched |
| 130 | SIGINT received (default policy) |
| `exitCode` | `crash-mid-stream` / `exit-nonzero` (default 1) |
| 70 | internal simulator error (should never happen) |

All simulator diagnostics are single stderr lines prefixed `codex-sim: `.

---

## 2. Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `INVENTIO_SIM_SCENARIO` | yes | path to the scenario JSON. Missing, unreadable or invalid → exit 2 with a stderr message. |
| `INVENTIO_SIM_STATE_DIR` | no | cross-invocation state dir. Default `<scenario path>.state/`. Created if missing. |
| `INVENTIO_TASK_TOKEN` | no | recorded verbatim in the call log as `taskToken` (`null` if unset). |

Relative paths in `INVENTIO_SIM_SCENARIO` / `INVENTIO_SIM_STATE_DIR` are
resolved against the cwd the process **started** in, i.e. before `-C`. Every
other path (`--output-last-message`) resolves against the cwd **after** `-C`.

### State dir contents

- **`consumed.json`** — JSON array of consumed call indices, ascending
  (e.g. `[0,1]`). Read-modify-write, single writer assumed, no locking. Absent
  until the first call is consumed. A malformed `consumed.json` is a hard error
  (exit 2) rather than a silent reset.
- **`calls.log.jsonl`** — one line per invocation, appended **always** (matched
  or not):

  ```json
  {"ts":"2026-08-23T20:55:19.311Z","index":0,"argv":["exec","--json","..."],
   "cwd":"/abs/cwd/after/-C","prompt":"…","resumeOf":null,"taskToken":"tok-abc"}
  ```

  - `ts` — ISO-8601 UTC
  - `index` — selected scenario call index, or `-1` when nothing matched
  - `argv` — the arguments after the executable (`process.argv.slice(2)`)
  - `cwd` — cwd after `-C`
  - `prompt` — the resolved prompt (argv or stdin), verbatim
  - `resumeOf` — `<THREAD_ID>` for `exec resume`, else `null`
  - `taskToken` — `process.env.INVENTIO_TASK_TOKEN ?? null`

  This log is the assertion surface for orchestrator tests: it is how you check
  what the "codex" actually saw.

---

## 3. Scenario format

```json
{ "calls": [ {
   "match": { "promptContains": "substr", "resumeOf": "thread-id", "cwdContains": "substr" },
   "threadId": "sim-0001",
   "behavior": "ok",
   "stubbornSigint": false,
   "exitCode": 1,
   "delayMs": 0,
   "items": [ {"type":"reasoning","text":"…"},
              {"type":"command_execution","command":"…","aggregated_output":"…","exit_code":0} ],
   "finalMessage": {"any":"json"},
   "usage": {"input_tokens":1000,"cached_input_tokens":0,"cache_write_input_tokens":0,
             "output_tokens":200,"reasoning_output_tokens":50}
 } ] }
```

The document must be an object with a `calls` array; each call must be an
object with a known `behavior` and, if present, an array `items`. Anything else
→ exit 2.

### Selection

The chosen call is the **first index not listed in `consumed.json` whose `match`
block passes**. All present match keys must pass:

- `promptContains` — substring of the resolved prompt
- `cwdContains` — substring of the cwd *after* `-C`
- `resumeOf` — equals the `<THREAD_ID>` of the `exec resume` invocation

Resume pairing is exclusive in both directions:

- a call declaring `match.resumeOf` can only be selected by a resume invocation
  with exactly that thread id;
- a resume invocation only selects calls declaring a matching `match.resumeOf` —
  it never falls through to an ordinary call.

An absent `match` (or `{}`) matches any non-resume invocation.

No match → stderr `codex-sim: no scenario call matches`, exit 2, no events, no
consumption — but the invocation **is** appended to `calls.log.jsonl` with
`index: -1`.

On selection the index is written to `consumed.json` **immediately, before any
output is emitted**, so a crashing/hanging call is still consumed and the next
invocation advances.

### Fields

| Field | Default | Meaning |
| --- | --- | --- |
| `threadId` | `sim-000<index>` | `thread.started.thread_id`; **ignored on resume**, where the resumed `<THREAD_ID>` is echoed instead |
| `behavior` | `"ok"` | see below |
| `stubbornSigint` | `false` | ignore SIGINT (see §5) |
| `exitCode` | `1` | exit code for `crash-mid-stream` / `exit-nonzero` |
| `delayMs` | `0` | sleep this many ms **before each emitted line** |
| `items` | `[]` | item payloads, replayed in order |
| `finalMessage` | `""` | string → used as-is; anything else → `JSON.stringify(...)` |
| `usage` | all zeros | merged over the five zero-defaulted fields; extra keys pass through |

### Behaviors

- **`ok`** — emit the event sequence, write `--output-last-message`, exit 0.
- **`malformed-output`** — byte-for-byte identical to `ok`. The scenario author
  supplies a `finalMessage` that violates the orchestrator's expected schema;
  the sim never validates against `--output-schema`.
- **`crash-mid-stream`** — emit `thread.started`, `turn.started` and the
  `items`, then exit with `exitCode ?? 1`: **no** `agent_message`, **no**
  `turn.completed`, and `--output-last-message` is **not** written.
- **`hang`** — emit `thread.started`, `turn.started` and the `items`, then stay
  alive forever on a keepalive timer.
- **`exit-nonzero`** — print exactly one stderr line
  `codex-sim: simulated failure` and exit with `exitCode ?? 1`, emitting **no
  events at all** (the call is still consumed and logged).

---

## 4. Event sequence (`--json`, behaviors `ok` / `malformed-output`)

One JSON object per line on stdout, one `process.stdout.write` per line, each
flushed before the next is produced:

1. `{"type":"thread.started","thread_id":"<threadId>"}` — the resumed
   `<THREAD_ID>` for resume invocations.
2. `{"type":"turn.started"}`
3. For each entry of `items`, two lines with the identical item object:
   `{"type":"item.started","item":{"id":"item_N", …entry}}` then
   `{"type":"item.completed","item":{…same…}}`. Ids are sequential from
   `item_0`; a generated id always wins over an `id` present in the entry.
4. `{"type":"item.completed","item":{"id":"item_<items.length>","type":"agent_message","text":FINAL}}`
   — the final message continues the same id sequence and has **no**
   `item.started`.
5. `{"type":"turn.completed","usage":{…}}` with all five usage fields present,
   missing ones defaulted to 0.

`FINAL` = `finalMessage` when it is a string, otherwise
`JSON.stringify(finalMessage)`.

Without `--json`: no events; `FINAL` plus a trailing newline is printed to
stdout instead (still after `delayMs`).

`--output-last-message <file>` writes exactly `FINAL` (no trailing newline) for
`ok` / `malformed-output`, resolved against the cwd after `-C`; missing parent
directories are created. It is written **immediately before the
`turn.completed` line**, so an orchestrator that reacts to `turn.completed`
never sees a missing file.

---

## 5. Signals

- Default: the first SIGINT exits **130** immediately, with no further output.
- `stubbornSigint: true`: SIGINT is ignored — the first, the second, all of
  them — so a caller must escalate to SIGKILL. Combined with `behavior: "hang"`
  this exercises orchestrator kill escalation.

The handler is installed before any output is possible; the stubborn policy
takes effect as soon as the call is selected.

---

## 6. Resolved ambiguities

Points the frozen contract left open, and the choice made here:

1. **Relative `INVENTIO_SIM_SCENARIO` vs `-C`.** `-C` chdirs "before doing
   anything else", but the env paths are resolved against the *original* cwd so
   `-C` cannot move the scenario/state dir out from under the run. Absolute
   paths (the normal case) are unaffected.
2. **Scenario/env errors are not logged.** A missing/unreadable/invalid
   scenario exits 2 without touching `calls.log.jsonl` — the state dir location
   generally is not knowable at that point. Only *selection* failures are
   logged (`index: -1`), as specified.
3. **Missing `threadId`** defaults to `sim-` + the zero-padded call index.
   **Missing `finalMessage`** is the empty string.
4. **`match.resumeOf: null`** counts as "not declared", i.e. the call is
   selectable by non-resume invocations.
5. **Extra positionals** (`exec a b`) are a usage error rather than being
   silently joined, to catch quoting bugs in the orchestrator.
6. **Timing of the `--output-last-message` write**: immediately before
   `turn.completed` (see §4).
7. **`--output-last-message` content**: exactly `FINAL`, no trailing newline;
   parent directories are created rather than erroring.
8. **Malformed `consumed.json`** is a hard error (exit 2), not a silent reset —
   silently restarting a scenario would produce baffling test failures.
9. **Prompt from stdin is not trimmed** — the log records exactly what was fed
   in, so `promptContains` behaves predictably and the log is lossless.
10. **`-` with a TTY stdin** does not block; the prompt is the empty string.
11. **Unknown `behavior` values** are rejected at load time (exit 2) rather than
    treated as `ok`.
12. **`usage` extra keys** are preserved (the parser must tolerate unknown
    fields anyway, per §8.1).
13. **A literal prompt `"resume"`** after `exec` is always read as the resume
    subcommand; pass such a prompt via stdin if you need it.

---

## 7. Tests

`npm test -w @inventio/codex-sim` (vitest). Every test spawns the real bin in
a `fs.mkdtemp` temp dir with its own scenario copy and state dir, so the suite
is hermetic and parallel-safe. Coverage: full happy-path event order + output
file + log row + consumption; sequential consumption; resume exclusivity and
thread-id echo; no-match; crash-mid-stream; hang + SIGINT (130) and
stubbornSigint + SIGKILL; stdin prompts (`-` and piped); unknown flags; env
errors; `cwdContains`; `delayMs`; non-`--json` mode.

Install with `npm install` at the **workspace root** so vitest resolves from the
root `node_modules`.
