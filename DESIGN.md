# Inventio — system and interface design

Inventio is a local system that attacks difficult mathematics problems
with a council of Codex agents under the constitution in `PROTOCOL.md`.
This document is the complete engineering specification: architecture,
domain and event model, the Conductor state machine, Research Manager integration,
worker execution, the memory service, the HTTP API, and the frontend.
It is written so that a fresh session can resume implementation from it
plus `PLAN.md` without re-deriving decisions.

Decisions already made with the owner (do not relitigate):

- Orchestration brain: **one recurrent LLM Research Manager + a deterministic
  Conductor in code**. The Manager owns every intellectual choice; the
  Conductor validates and executes a bounded action space.
- Stack: **TypeScript end-to-end** — Node ≥ 20 backend, React frontend,
  one shared schema package.
- Autonomy: **full-auto by default** with a directive inbox; per-project
  gated mode available. Intake confirmation is always on.
- Candidates: **lineage-aware data model, one active lineage in v1.**
- Interrupts: **soft by default** (stop new dispatch, reconvene early);
  hard kill is an explicit separate control.
- Round findings: **built deterministically** from structured returns; the
  Research Manager interprets them and rewrites its current mathematical view.
- Workers are **sealed by construction** (jailed packet directories) and
  **hermetic** (`--ignore-user-config`).
- Docs: `PROTOCOL.md` (research constitution), this file (runtime design),
  `packages/ui/UI-SPEC.md` (interface design), and `PLAN.md` (implementation
  history). Repository development guidance lives in `AGENTS.md`.

## 1. Architecture

```text
┌─────────────────────────── browser ────────────────────────────┐
│ React SPA: Research · Manager · Evidence · Library · Steering  │
└──────────────┬────────────────────────────▲────────────────────┘
        REST (control)                 SSE (events, task tails)
┌──────────────▼────────────────────────────┴────────────────────┐
│                     conductor (Node process)                   │
│  HTTP server (Fastify)      per-project ProjectEngine          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ state machine · scheduler/worker pool · budget metering  │  │
│  │ packet composer · output validator · docket builder      │  │
│  │ acceptance predicate · event log (append-only JSONL)     │  │
│  └───────┬──────────────────────┬───────────────────────────┘  │
│          │ codex exec --json    │ MCP streamable HTTP           │
│          ▼ (one process/task)   ▼ (loopback, bearer per task)   │
│ worker / manager calls     memory service (search/expand)       │
└────────────────────────────────────────────────────────────────┘
                projects/<slug>/  = durable source of truth
```

One Node process hosts everything: the HTTP/SSE server, one
`ProjectEngine` per open project, the shared worker pool, and the memory
MCP service. Codex work happens in short-lived `codex exec` child
processes — one per assignment or Manager call — so isolation, budget limits,
and crash recovery are process-level facts. The browser is a pure
projection: any reload rebuilds from a snapshot plus the event stream.

## 2. Repository layout and stack

```text
inventio/
├── PROTOCOL.md            # constitution (see there)
├── DESIGN.md              # this file
├── PLAN.md                # milestone tracker (resumable)
├── package.json           # npm workspaces root; scripts: dev, build, test, smoke
├── tsconfig.base.json
├── packages/
│   ├── schema/            # @inventio/schema — zod models, events, reducer, graph projection
│   ├── conductor/         # @inventio/conductor — backend; src/prompts/ is the model-instruction boundary
│   ├── ui/                # @inventio/ui — Vite + React SPA
│   └── codex-sim/         # @inventio/codex-sim — fake codex binary + scenarios
└── projects/              # runtime data, one dir per project (gitignored by default)
```

- Node ≥ 20, ESM everywhere, TypeScript strict.
- `schema`: zod v4 (source of truth for every cross-boundary shape),
  plus the **pure snapshot reducer** and **graph projection** used by both
  backend and frontend. No Node-only imports here.
- `conductor`: Fastify 5, `@modelcontextprotocol/sdk` (memory service),
  no database — append-only JSONL + Markdown files.
- `ui`: Vite, React 18, `@xyflow/react` (React Flow 12), zustand,
  react-markdown + remark-math + rehype-katex, KaTeX. Layout is
  hand-rolled and deterministic (§11.4) — no force simulation, no elkjs.
- `codex-sim`: zero-dep Node script emitting the verified JSONL dialect.

Verified against codex-cli 0.149.0 (`codex exec --json` event shapes and
flags were captured live; see §8.1). Pin expectations there, not here.

## 3. Identity and IDs

- Project: lowercase-hyphen slug, e.g. `virasoro-quartic-3fold`.
- Waves `W001…`, tasks `T001…` (project-global), attempts `A001…`,
  explorations `E001…`, reviews `R001…`, lineages `C001…` with frozen
  versions `C001.v1`, `C001.v2…`, claims `K001…`, issues `I001…`,
  memory cards `M001…`, questions `Q001…`, directives `D001…`,
  decisions `DEC001…`, computations `X001…`, and original intake sources
  `S001…`. Post-terminal publication attempts use `P001…`.
- Event sequence numbers are per-project, monotonically increasing
  integers assigned at append time; they are the SSE resume cursor.

## 4. Durable project layout

```text
projects/<slug>/
├── project.json           # identity + config (see §13); settings edits are events too
├── events.jsonl           # append-only operational truth (one JSON event per line)
├── problem.md             # confirmed normalized statement; immutable after confirmation
├── intake/
│   ├── original-objective.md            # current verbatim owner input before confirmation
│   ├── original-background.md           # current verbatim background before confirmation
│   └── sources.json                      # S### catalog, hashes, short descriptions
├── sources/               # owner uploads; retained intake becomes immutable after confirmation
├── digest.md              # Conductor-owned rolling digest (regenerated at each curation)
├── artifacts/
│   ├── attempts/A001.md
│   ├── explorations/E001.md
│   ├── reviews/R001.md
│   ├── candidates/C001.v1.md          # frozen; never rewritten
│   ├── resolutions/W001.md
│   ├── manager-notes/W001.md            # recurrent mathematical view
│   └── final.md
├── memory/
│   ├── cards/M001.md                  # frontmatter + body (see §9.4)
│   └── capsules/solver.md|explorer.md|reviewer.md
├── tasks/T001/
│   ├── packet/                        # the jail (composed by Conductor, §7)
│   ├── codex-events.jsonl             # full archived worker stream
│   ├── output.json                    # validated structured return
│   └── meta.json                      # threadId, usage, timestamps, exit info
├── publications/P001/
│   ├── manuscript.tex                 # accepted Research Manager TeX in fixed preamble
│   ├── compile.log                    # bounded local compiler output
│   └── manuscript.pdf                 # present only after a successful compile
└── computations/X001/                 # code + inputs + outputs + hashes (§10)
```

`events.jsonl` is the operational truth; Markdown artifacts are the
mathematical evidence. The in-memory snapshot is `reduce(events)`; boot
replays the log (a `snapshot.json` cache is a later optimization, not v1).
Writes are append + fsync; a torn final line is tolerated and dropped on
replay. All artifact writes happen via temp-file + atomic rename, and the
event referencing an artifact is appended only after the rename succeeds.

## 5. Event model

Every state change is one typed event:
`{ seq, ts, type, ...payload }`. The taxonomy (zod-discriminated union in
`@inventio/schema`):

Lifecycle & phases
- `project.created { title, statement, config }`
- `project.paused { by }` / `project.resumed { by }`
- `project.settingsChanged { settings, by }` (one atomic effective value for
  token/round ceilings, autonomy, Web-search permission, and the five
  user-selectable model roles)
- `autonomy.changed`, `models.changed`, and `webSearch.changed` remain in the
  schema only so older project logs replay; new updates use the unified event
- `phase.changed { from, to, reason }`
- `terminal.reached { result: "PROVED"|"DISPROVED"|"UNCERTAIN", finalPath }`
- `project.continued { previousResult, previousFinalPath, note, addTokens,
  addWaves, by }` (the note is retained verbatim for the entire resumed period)
- `publication.requested { publicationId, decisionId, terminalResult,
  terminalFinalPath, terminalReachedAtSeq, by }`
- `publication.drafted { publicationId, kind, result, title, assessment,
  texPath, logPath }`
- `publication.compilationRequested { publicationId, by }`
- `publication.completed { publicationId, pdfPath, compiler }`
- `publication.failed { publicationId, stage, error }`

Intake & human channel
- `intake.rawUpdated { statement, contextMarkdown, by }` (explicit owner
  revision before W000 is accepted; earlier values remain in the event log)
- `intake.sourcesUpdated { sources: IntakeSource[] }` (verbatim path, size,
  SHA-256, short abstract, and conclusion-oriented excerpt)
- `intake.completed { problemMarkdown, ...legacyCompatibilityFields }`
- `manager.noteRecorded { waveId, abstract, markdown, source }` (`W000` is the
  intake view; `W020.2`, `.3`, … are post-report revisions at the W020
  checkpoint)
- `problem.confirmed { problemMarkdown }` (human accepts the directly edited
  W000 and begins research)
- `directive.submitted { id, text, urgent }` / `directive.consumed { id, decisionId }`
- `question.raised { id, text, blocking, context, raisedBy }`
- `question.answered { id, answer }` / `question.dismissed { id }`
- `human.intervention { kind, target, note }`  (ledger interventions carry their own events below with `by:"human"`)

Decisions (Research Manager; legacy event/field names remain compatible)
- `decision.requested { decisionId, kind, packet: { digestRef, docketRef, budgets } }`
- `decision.proposed { decisionId, action }`   (raw validated-or-not proposal)
- `decision.rejected { decisionId, violations }`  (bounce; at most one)
- `decision.accepted { decisionId, action }`
- `gate.opened { decisionId }` / `gate.resolved { decisionId, resolution, editedAction? }`  (gated mode)

Waves & tasks
- `wave.planned { waveId, title, roster: RosterEntry[], reserveTokens, rationale }`
- `wave.softInterrupted { waveId, by }` / `wave.closed { waveId, docket }`
- `task.dispatched { taskId, waveId, role, direction, packetManifest, budget }`
- `task.session { taskId, threadId }`
- `task.progress { taskId, usage }`            (throttled ≥ 2 s apart)
- `task.completed { taskId, usage }`
- `task.outputInvalid { taskId, errors }`      (then one repair resume)
- `task.interrupted { taskId, reason, usage }` / `task.failed { taskId, error }`
- `crossexam.sent { taskId, decisionId, refIds }` / `crossexam.answered { taskId, outputRef }`

Evidence
- `artifact.recorded { artifactId, kind, taskId, path, conclusion? }`
- `lineage.created { lineageId, title }` / `lineage.abandoned { lineageId, reason }`
- `candidate.frozen { candidateId, lineageId, version, fromArtifact, obligations }`
- `review.recorded { reviewId, candidateId, verdict, issueIds, taskId }`
- `claim.added { claimId, statement, status, provenance }`
- `claim.status { claimId, from, to, justification, by }`
- `issue.raised { issueId, candidateId, severity, location, summary, by }`
- `issue.resolved { issueId, disposition, reason, by }`
- `computation.recorded { compId, taskId, entry, inputsHash, outputHash }`
- `computation.reproduced { compId, match, outputHash }`
- `acceptance.evaluated { candidateId, passed, failing: string[] }`

Memory
- `memory.cardProposed { cardId, by, card }`
- `memory.cardAdmitted { cardId, status, reason }` / `memory.cardStatus { cardId, from, to, reason, by }`
- `memory.recall { taskId, op: "search"|"expand", args, returnedIds }`
- `capsule.updated { role, waveId }`
- `manager.noteRecorded { waveId, path, markdown, source }`
- `resolution.recorded { waveId, path }`
- `digest.updated { }`

The reducer in `schema` folds these into `ProjectState`:
`{ config, phase, problem, waves, tasks, artifacts, lineages, candidates,
claims, issues, cards, questions, directives, decisions, researchManagerNotes,
computations, publications, budget, autonomy, terminal }` — plain serializable data. The frontend runs
the identical reducer, so backend and UI can never disagree about state.

`deriveGraph(state, view)` (also in `schema`) projects state into typed
nodes/edges for the two graph views (§11.4). Graph identity is stable:
node id = domain id; the layout never depends on arrival order.

## 6. The Conductor

`ProjectEngine` is a per-project async state machine. Its single mutation
path is `apply(event)`: append to `events.jsonl`, fold into the snapshot,
broadcast on SSE. All logic below is expressed as: observe state →
possibly consult the Research Manager → validate → `apply` events → start processes.

### 6.1 Phase machine

```text
CREATED → INTAKE → AWAITING_CONFIRMATION → DISCOVERY ⇄ SYNTHESIS → REVIEW → REPAIR
                                              └──────────→ TERMINAL ←──────┘
```

plus orthogonal flags: `paused`, `blocked` (a blocking Question is open),
`gated` (a decision awaits human resolution). The engine's main loop:

1. If paused / blocked / gated / terminal → idle (event-driven wake).
2. If the owner has just continued from a stopping report → prepare the
   numbered revised mathematical view before any new research decision.
3. If a wave is open → supervise tasks (dispatch queued tasks as pool
   slots free, meter budgets, collect outputs). When all tasks are
   terminal → build a factual round summary → ask the Research Manager to
   assess the round and rewrite its current note → close wave.
4. If no wave is open → decision point: build decision packet → call
   Research Manager → validate → execute accepted action.
5. After every `review.recorded` or `issue.resolved` or `claim.status` →
   evaluate the acceptance predicate on the reviewed candidate; on pass →
   Final composition → `terminal.reached`.

#### Continuing from a stopping report

Continue Research does not dispatch work directly. The saved report remains
immutable, resource extensions are applied, and the Research Manager receives
the preceding recurrent view, the full report, and the owner's verbatim
direction in one bounded revision call. The result is recorded at the last
completed round's checkpoint: for example, W020 is followed by W020.2; another
continuation without a new round becomes W020.3. This is a revised mathematical
view, not a research round and not an executable plan.

By default the configured Research Manager writes the revision. The owner may
instead supply the complete revised view directly, in which case it is recorded
as `human_edited` without a model call. Only after the revision exists may the
ordinary next-move call choose W021. The owner's original direction is also
supplied verbatim as `continuation-direction.md` to every next-move,
completed-round assessment, and final-composition call until the next stopping
report. Thus new mathematics can change the Manager's judgment, but a
multi-part continuation request cannot disappear after one decision.

### 6.2 Decision points and validation

The decision input (assembled fresh each call, bounded size) contains the
confirmed problem, the Research Manager's current note, short active-library
abstracts, the latest round's findings and assessment, claim and candidate
status, resource accounting, owner guidance, the full active continuation
direction when present, and the legal action description.
The Manager may search and expand older library notes through read-only tools
when the short active surface is insufficient.

The Research Manager returns one action (flat envelope, §6.3). The Conductor
validates mechanically, e.g.: every task budget ≥ `MIN_TASK_TOKENS`;
remaining budget still above the protocol reserve floor
(`totalTokens × reserveFraction`) or no new wave may be planned;
at most eight solver/explorer/reviewer assignments, with synthesis counted
separately; roster within pool and budget bounds;
distinct directions for parallel solvers (string-distinct briefs and
declared method tags); reviewers only against a frozen version; no grant
of any sealed current-wave material; repair waves must reference open
issue IDs; `terminate` only with result UNCERTAIN; freeze only from an
existing artifact with conclusion PROVED/DISPROVED/UNCERTAIN recorded;
25% reserve honored. Violations → `decision.rejected` + one bounce with
the violation list appended; a second failure → blocking Question.

In gated mode, an accepted action opens a gate instead of executing; the
human approves, edits (edited action is re-validated), or rejects (which
re-runs the decision with the rejection note as a directive).

### 6.3 Research Manager action envelope

`--output-schema` demands a fixed shape, so actions use a flat envelope —
`action` enum plus one optional field per variant (zod refines exactness):

```ts
{ action: "plan_wave",        plan_wave: { title, rationale, reserveTokens,
    tasks: [{ role: "solver"|"explorer"|"reviewer"|"synthesizer",
              methodTag, direction, briefMarkdown, tokenBudget,
              grants: { artifactIds: string[], cardIds: string[],
                        sourceMounts: string[] },
              computation: boolean }] } }
{ action: "cross_examine",    cross_examine: { items: [{ taskId, refIds, questionMarkdown }], rationale } }
{ action: "freeze_candidate", freeze_candidate: { lineageId?, newLineageTitle?,
                                                 fromArtifactId, obligations: string[], rationale } }
{ action: "record_dispositions", record_dispositions: { items: [{ issueId,
                                 disposition: "accepted"|"rejected", reason }] } }
{ action: "abandon_lineage",  abandon_lineage: { lineageId, reason } }
{ action: "raise_question",   raise_question: { text, blocking, context } }
{ action: "terminate",        terminate: { rationale } }   // result is always UNCERTAIN
```

The initial reading, completed-round assessment, and final composition use
their own schemas. W000 is written by the same Research Manager that later
chooses the work; the call is isolated from later research because none exists
yet:

```ts
// intake
{ managerAbstract, managerNoteMarkdown,
  sourceSummaries: [{ sourceId, abstract, excerptMarkdown }],
  problemMarkdown, contextDigestMarkdown: "", rawMemories: [],
  ambiguities: [], clarifications: [], notes: "" }
// completed-round assessment
{ managerNoteMarkdown, resolutionMarkdown, digestMarkdown,
  taskDispositions: [{ taskId, disposition, reason, unblock }],
  cardDecisions: [{ cardId, admit, status, reason }],
  libraryAdditions: [{ type, title, abstract, conclusionsMarkdown, tags,
                       sourceCardIds, sourceArtifactIds,
                       supersedesCardIds, promising }],
  libraryRetirements: [{ cardId, reason }],
  claimExtractions: [{ statement, provenance, fromTaskId }],
  claimUpdates: [{ claimId, status, reason, evidenceTaskIds }],
  capsules: { solver, explorer, reviewer } }
// final
{ finalMarkdown }   // RESULT: line is stamped by the Conductor, never by the model
// owner-requested post-terminal publication
{ kind: "preprint", result: "PROVED"|"DISPROVED",
  title, abstractTex, bodyTex, assessment }
// or
{ kind: "research_report", result: "UNCERTAIN",
  title, abstractTex, bodyTex, assessment }
```

Assessment outputs pass the same deterministic filters (library rules §9.4,
role-note size caps enforced by truncation-with-warning, project-summary size
cap). `managerNoteMarkdown` is persisted as
`artifacts/manager-notes/W###.md` and emitted in
`manager.noteRecorded`. A failed assessment records an explicit fallback
note without inventing mathematical judgment.

### 6.4 Wave lifecycle and scheduler

`wave.planned` freezes the roster. The scheduler dispatches tasks up to
`maxConcurrentWorkers` (global pool across projects, default 3), FIFO
within a wave. Each task: compose packet (§7) → spawn `codex exec`
(§8.2) → stream/meter → collect → validate → materialize. A wave closes
when every roster task is `completed`, `interrupted`, or `failed`.

Soft interrupt (`wave.softInterrupted`): stop dispatching queued tasks,
let running tasks finish, reconvene with whatever exists. Hard interrupt
is per-task: SIGINT, 10 s grace, SIGKILL. The archived stream's last agent
message, if any, is written to `tasks/T###/salvage.md` and its head is
carried into the docket's task-outcome line, explicitly labeled unvalidated
partial work to be treated as an untrusted lead — never as a memo, since it
never passed the output schema. A task with nothing salvageable contributes
only its interruption line.

### 6.5 Budget metering

Unit: tokens, from `turn.completed.usage`. Tracked raw per task
(`input`, `cached_input`, `output`, `reasoning_output`); the spend metric
is `input − cached_input + output` (cached shown separately in UI).
Exact usage arrives only at `turn.completed` (verified live), so mid-task
enforcement uses a streamed estimator. The estimate is seeded with
`CODEX_TURN_BASE_TOKENS` (16,000 — the measured fixed cost of one `codex
exec` turn before the model emits anything) plus packet size / 4, then grows
by ≈ chars/4 over emitted items. Seeding matters: the streamed items reflect
only *output*, so an estimator built from them alone under-counts by roughly
a whole turn's context and caps never fire on short tasks (observed in the
first real run: a task ran 33k real tokens against a 4k budget untouched).
A task whose *estimated* spend exceeds its budget by >10% gets a hard
interrupt with reason `budget`; exact accounting is reconciled from `usage`
at turn end (cumulative across resumes).

Task budgets carry a floor, `MIN_TASK_TOKENS` = 60,000, enforced as a
`plan_wave` validation rule (§6.2): below it a task is killed before it can
think, so the plan is rejected rather than started. The Research Manager
contract and the ledger both state realistic ranges (150k–600k bounded,
up to 1.5M open-ended) and the project's recommended per-task default.

A wall-clock cap per task (default 30 min) is enforced the same way.
Project ceiling: once remaining budget falls below the protocol reserve
floor, `plan_wave` becomes an illegal action and the ledger says so
explicitly, forcing the Research Manager toward focused follow-up, a candidate
decision, referee responses, a concrete question, or an honest stopping
report. Research Manager, intake, assessment, and final calls are metered in
the legacy internal field `plannerSpentTokens`;
cross-examination is metered as worker spend on the task's account (it
resumes a worker session), via `usage` on `crossexam.answered`.

### 6.6 Docket builder

Pure function over the wave's validated memos + task outcomes:
deduplicated new claims (verbatim statements, author-neutralized as
"a solver in W004"), obstructions, dead ends, cross-references to
existing claim/issue IDs (string-matched by the IDs workers were shown),
questions proposed, budget report, and per-task one-line outcomes.
Rendered to Markdown (stored inside `wave.closed`) and included in the
next decision packet. No model call involved.

### 6.7 Acceptance predicate

Implemented exactly as `PROTOCOL.md §2`, evaluated automatically; emits
`acceptance.evaluated` with the list of failing conditions (empty =
accepted). On acceptance: Final composition call → Conductor stamps
`RESULT:` from the predicate → writes `artifacts/final.md` →
`terminal.reached`. `final.md` also gets written on UNCERTAIN
termination, same flow, stamped UNCERTAIN.

### 6.8 Recovery

Boot: replay `events.jsonl`. For tasks that were `dispatched`/running at
crash time: if `meta.json` has a `threadId`, attempt one
`codex exec resume <threadId>` continuation asking the worker to finish
and return the structured output; otherwise mark `task.interrupted
{ reason: "conductor-restart" }`. The wave then proceeds normally. All
engine steps are idempotent against the log (e.g. a decision with a
`decision.requested` but no terminal decision event is re-run under the
same `decisionId`).

### 6.9 Post-terminal TeX publication

`requestPublication()` is an owner-triggered operation available only while a
stopping report is current. It does not reopen the research loop and it does
not rewrite the historical `terminal.result`. A new publication record is tied
to the exact stopping event sequence and report path, so continuing research
and stopping again creates a new checkpoint rather than silently replacing an
older paper.

The Research Manager receives the confirmed problem, stopping report, current
mathematical view, short library and claim surfaces, original intake context,
and an index of copied full write-ups, referee reports, assignment returns,
library notes, and reproducible-computation records. It reads those full files
on demand and performs the final mathematical judgment itself; no workers are
spawned. The configured Research Manager model and project Web-search
permission apply, and usage is charged to Research Manager spend.

The response is the binary schema in §6.3. Before acceptance, deterministic
validation rejects product references, private research IDs, document
boundaries, package imports, file input/output, external images, and shell-like
TeX commands. The runtime escapes the plain-text title, places the accepted
abstract and body fragments inside a fixed article preamble, writes
`publications/P###/manuscript.tex`, and invokes
`tectonic -X compile --untrusted`. It checks the output header before recording
the PDF as ready. Compilation failures retain both TeX and a bounded log; a
retry runs only the compiler. Drafting or validation failures instead start a
new publication reading. On restart, an interrupted drafting or compilation
stage becomes an explicit retryable failure rather than remaining permanently
busy.

## 7. Task packets — the jail

The packet directory is the worker's entire observable world:

```text
tasks/T007/packet/
├── AGENTS.md          # role contract (from PROTOCOL.md §3.x) + packet manifest + memo/output spec
├── problem.md         # exact confirmed statement (always)
├── research-question.md       # direction, brief, budget, stopping condition
├── research-notes.md          # short role note when relevant
├── research-library-index.md  # role-filtered short memory catalog when relevant
├── references/
│   ├── write-ups/A003.md …          # explicitly granted full artifacts (copies)
│   ├── library-notes/M012.md …      # explicitly granted memory cards
│   ├── relevant-claims.md           # reviewer/dependency extract when relevant
│   └── sources/<mount>/ …           # read-only copies of declared source collections
└── scratch/           # writable iff computation: true (workspace-write); else absent
```

Rules enforced by the composer:

- Copies, not symlinks — nothing in the packet references outside it.
- Sealing: no artifact from the current wave may be granted (validated at
  decision time and again at composition; violation aborts dispatch).
- Reviewer packets: problem + frozen candidate + claims ledger extract +
  cited sources only. Never another review, never attempt history.
- Synthesizer packets: the selected artifacts with their open issues and
  provenance; no capsule, no browsing surface.
- Source mounts: `project.json` declares
  `sourceMounts: [{ name, path, note }]` (for example, a local collection of
  papers or computation notebooks). A grant copies the mount (or declared subpaths) into
  `grants/sources/<name>/`. Mount content is owner-trusted input; the
  grant itself is recorded in `task.dispatched.packetManifest`.
- `AGENTS.md` is generated: role contract verbatim, then the manifest
  (exact list of granted files), the memory-tool note, the memo schema,
  and the structured-output instruction. Codex auto-discovers it at cwd.

## 8. Codex execution

### 8.1 Verified `codex exec --json` dialect (codex-cli 0.149.0)

```jsonl
{"type":"thread.started","thread_id":"01a03057-…"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"…"}}
{"type":"turn.completed","usage":{"input_tokens":15548,"cached_input_tokens":11008,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}
```

Also expected (handled generically, archived verbatim): `item.started` /
`item.updated`, item types `reasoning`, `command_execution`,
`mcp_tool_call`, `error`, and `turn.failed`. The parser must tolerate
unknown event and item types by archiving and ignoring them.
`thread_id` is the resume handle (`codex exec resume <id>`).

### 8.2 Worker invocation

```bash
INVENTIO_TASK_TOKEN=<token> codex exec --json \
  --ignore-user-config --skip-git-repo-check \
  -C <abs packet dir> \
  -s read-only                    # workspace-write iff computation: true
  -m <model>                      # from role config; omit to use account default
  -c model_reasoning_effort='"high"' \
  -c 'mcp_servers.memory={url="http://127.0.0.1:4701/mcp",bearer_token_env_var="INVENTIO_TASK_TOKEN"}' \
  --output-schema <role-output.schema.json> \
  --output-last-message tasks/T007/last-message.json \
  -
```

- Hermetic: `--ignore-user-config` (auth still honored), no inherited MCP
  servers or user instructions; the packet's `AGENTS.md` is the only
  ambient instruction source.
- The stdin prompt is short: "Work on the question in research-question.md,
  following AGENTS.md." It is generated by
  `src/prompts/operational.ts`; there is no separate `prompt.md` file.
- Network: unavailable inside the sandbox (both modes); sources arrive
  only as grants.
- stdout → parsed + archived to `codex-events.jsonl`; stderr → archived.
- Structured output: `last-message.json` validated by zod. On failure:
  one `codex exec resume <threadId>` with the validation errors and a
  restatement of the schema; second failure → `task.failed`.

Worker output schema (per role, shared core):

```ts
{ conclusion: "PROVED"|"DISPROVED"|"UNCERTAIN" | "PASS"|"FAIL",   // reviewer uses verdicts
  artifactMarkdown: string,          // the attempt/exploration/review/candidate body
  memo: {
    summary: string,
    newClaims: [{ statement, evidence: "proved-in-artifact"|"computation"|"cited"|"unverified", where }],
    issues?:  [{ severity: "CRITICAL"|"MAJOR"|"MINOR", location, summary, repairHint }],  // reviewer
    obligations: string[],
    deadEnds: string[],
    proposedCards: [{ type, title, content, abstract, tags, provenance }],
    computations: [{ entry, inputs, outputsDescription }],
    budgetReport: string },
  recallLog: [{ op, args, why }] }
```

### 8.3 Research Manager invocation

Each ordinary decision call uses a per-decision read-only directory containing the current
mathematical view, short active-library surface, latest findings, current
record, and an `AGENTS.md` describing the Manager's responsibility and legal
actions. The process is fresh, but the explicit current note makes its
intellectual state recurrent and replayable. A project-scoped bearer token
also grants `memory_search` and `memory_expand`; the Manager can inspect a
few full older notes on demand without placing the entire archive in every
prompt. The initial W000 call, and any owner-requested regeneration before
confirmation, instead receives the complete current owner submission:
verbatim objective and background, every project-local upload, a hash-bearing
source index, and read-only `source_list` / `source_open` tools for bounded
expansion of long text and PDFs. The submission is held fixed for the duration
of each call. It is told only to understand the material as
a mathematician preparing to manage the research, preserve the exact meaning
of named methods, and write its present view—not to solve, plan a round,
manufacture a taxonomy, or question the owner. The default Manager model is
`gpt-5.6-sol` at `max` effort, and that same project setting governs W000.
An owner-supplied tone contrast softly establishes a preference for substantive
mathematical engagement over administrative distance from the submission. It
is an example of taste, not a template or required sequence. W000 remains an
editable mathematical view rather than a report of the reading process.

The Manager receives a separate voice-example file. Four owner-written
examples are canonical; inferred examples are visibly marked
`DRAFT EXAMPLE — OWNER REVIEW` until the owner approves or replaces them.
All deliberate model-facing wording and a call-site/lifecycle map live under
`packages/conductor/src/prompts/`; see its `README.md` before revising prompts.

### 8.4 Cross-examination

`codex exec resume <threadId>` in the task's original packet dir with the
question file appended to the packet; answer validated against a small
`{ answerMarkdown }` schema and merged into the docket addendum.

## 9. Memory service

### 9.1 Transport

MCP streamable-HTTP server on `127.0.0.1:4701/mcp`, hosted by the
conductor process. Auth: `Authorization: Bearer <task token>`; tokens are
random 128-bit, minted per task at dispatch, mapped to
`{ slug, taskId, role, waveId }`, revoked when the task ends.

### 9.2 Tools

- `memory_search({ query, types?, statuses?, tags?, limit=5 })` →
  rows `{ id, type, status, abstract, provenance, tags }`. Substring +
  tag matching over the card index (no embeddings in v1). With no explicit
  status filter it searches the active working library plus quarantined
  warnings; `REFUTED`/`SUPERSEDED` records require an explicit archive search.
  Cards tagged `promising` rank first but gain no epistemic authority.
- `memory_expand({ cardIds, reason })` → full cards + the linked artifact
  section each card cites, if the role may see it.
- `source_list({ query? })` → the compact S### catalog of the owner's original
  materials. `source_open({ sourceId, start?, maxCharacters? })` → one bounded
  text chunk plus continuation metadata. These two tools are available only to
  the Research Manager; workers receive sources selected explicitly in their
  assignment.

### 9.3 Visibility enforcement

Sealed current-wave material is structurally absent (cards are only ever
admitted at curation, after the wave closes). `QUARANTINED` cards appear
in search flagged, and expansion is refused for workers. Reviewers can
expand only `VERIFIED` cards. Every call emits `memory.recall` and lands
in the task's recall log; refusals are logged too.

### 9.4 Card store and admission

One Markdown file per card with frontmatter
(`id, type, status, tags, provenance, sourceArtifact, dependsOn`).
Admission (at curation, enforced in code): proposer may not be the
verifier of their own new claim; `VERIFIED` requires an independent
check event, a `computation.reproduced { match: true }`, or a precise
source recorded by a reviewer; everything else enters `PROPOSED`.
The curator may write at most a few organizational `PROPOSED` cards that
condense existing card/artifact sources. Each has a one-to-four-sentence
abstract and a conclusion-only body; older redundant `PROPOSED` cards move to
`SUPERSEDED`. Rejected and superseded cards are still written to disk and kept
in the event log, so compression is reversible. `VERIFIED` and `QUARANTINED`
cards cannot be retired for tidiness. Contradictions link both cards and both
remain in the archive until an adjudicating event.

## 10. Computation runner

When a computation-enabled task records work in `scratch/`, the memo's
`computations[]` names entry commands and inputs. On collection the
Conductor copies `scratch/` into `computations/X###/`, records input
and output hashes (`computation.recorded`). Reproduction — required by
the acceptance predicate for conclusion-relevant computations — reruns
the entry command in a fresh sandbox (`codex sandbox`-equivalent:
plain child process with cwd = a temp copy, no network, rlimits) and
compares output hashes (`computation.reproduced`). Mismatch or crash
fails the predicate and surfaces as a red badge on the linked claim.
v1 supports `python3` and shell entries; environment is recorded
(`python3 --version`, package list if a venv is present).

## 11. Frontend

### 11.1 Information architecture and routes

- `/` — L0: project cards (phase, wave count, budget bar, open
  questions, terminal badge) + New Problem dialog + runtime status strip
  (codex account, pool occupancy).
- `/p/:slug` — L1 Ops view: the wave graph, top strip, steering dock,
  and the L2 inspector as a right-side panel.
- `/p/:slug/manager` — current Research Manager view and collapsed history.
- `/p/:slug/evidence` — Evidence view: claim/issue DAG of the active
  candidate version.
- `/p/:slug/library/:section?/:id?` — Library.
- `/p/:slug/settings` — per-project model and reasoning-effort settings.
- `/p/:slug/node/:nodeId` — deep link; resolves to the right view with
  the inspector open. All inspector states are URL-addressable.

### 11.2 Data flow

Cold load: `GET /api/projects/:slug` → full `ProjectState` snapshot +
`seq`. Then `GET /api/projects/:slug/events?since=seq` (SSE) feeds the
shared reducer from `@inventio/schema` in a zustand store. Reconnect
resumes from the last applied seq — no refetch. Task live tails
(`…/tasks/:id/stream`) are separate SSE subscriptions opened only while
that inspector tab is visible; they first replay the archived
`codex-events.jsonl` tail (last 200 events), then stream.

### 11.3 Ops view

Composition (left→right = time):

- **Wave columns.** Each wave is a column group node. Collapsed: a chip
  with title, roster summary (role glyphs), status ring, token spend.
  Expanded (default for the newest two waves): its task nodes stacked,
  the wave's resolution node at the bottom, cross-exam edges looping
  back into task nodes.
- **Task node.** Role glyph + method tag, status ring
  (queued/running/validating/done/interrupted/failed), live token gauge
  (arc), seal badge, conclusion chip once done. Click = inspector;
  double-click = center & zoom.
- **Lineage lane** (below the columns): candidate version nodes
  `C001.v1 → v2 → …` with per-version issue burn-down chips
  (`2C 5M → 0C 1M`), review nodes attached with PASS/FAIL coloring.
  Abandoned lineages fade but remain.
- **Memory hub** (bottom lane): card-count chip per status; expands to a
  card strip; cards deep-link to Library.
- **Question/gate nodes** float pinned to the right edge, pulsing when
  blocking.

Layout: deterministic and hand-rolled — waves have fixed column slots by
index, tasks stacked by roster order, lanes fixed rows. React Flow
provides pan/zoom/selection only. Expanding/collapsing animates via CSS
transitions on computed positions; positions are pure functions of state
+ collapse-set, so the mental map is stable across reloads and live
updates by construction.

Top strip: phase tracker (INTAKE → … → TERMINAL with the current one
lit), budget bar (spent/reserve/remaining with per-wave ticks), active
workers, open obligations count, issue burn-down sparkline of the active
lineage, pause/autonomy indicators.

### 11.4 Evidence view

Nodes: active candidate version (root), its claims (from obligations +
ledger links), their dependency claims, open issues pinned to the claims
or proof-steps they attack. Color by status (VERIFIED green / UNVERIFIED
amber / REFUTED red / issue severity). Edges: `depends-on`, `attacks`,
`resolved-by`. Same inspector on click. Layered DAG layout (topological
ranks, barycenter ordering — small graphs, hand-rolled is fine). A
version selector replays earlier frozen versions of the lineage.

### 11.5 Inspector (L2)

Tabs, lazily loaded:
- **Artifact** — rendered Markdown with KaTeX ($…$ and $$…$$ via
  remark-math/rehype-katex), version header, conclusion banner. The display
  compatibility layer repairs only structurally invalid scalable delimiters
  that cross an alignment row or cell; the stored mathematical source remains
  unchanged.
- **Packet** — the exact composed packet: manifest tree + file viewer
  (what did this worker actually see?).
- **Memo** — structured memo rendered as definition lists; proposed
  cards with their admission outcomes.
- **Recall** — the task's recall log with refusals highlighted.
- **Events** — this node's event timeline (filtered from the log).
- **Stream** — live/archived codex item feed (agent messages, commands,
  tool calls), auto-following while running.

Plus contextual actions per node type (§11.7).

### 11.6 Library

Left tree: Problem · Original materials · Candidate (active version, front and center) ·
Attempts · Explorations · Reviews · Claims · Memory · Resolutions ·
Computations · Final. Claims is a filterable table (status, wave,
provenance; human-intervention rows badged). Memory is a card grid with
status filters and search (same index the MCP tool uses). It opens on the
working library (`PROPOSED` + `VERIFIED`), with promising cards first; the
entire archive is one explicit filter away. Attempts/explorations whose source
task was set aside are likewise folded behind an archive toggle. Every item has
"show in graph" (deep link) and permalink. All of it live-updates from
the same store — no separate fetch cycle; bodies are lazy-fetched and
cached by artifact id + seq.

### 11.7 Steering surfaces

- **Directive dock** (always visible in project views): composer with
  Normal / Urgent toggle. Normal → next decision packet. Urgent → also
  soft-interrupts the open wave. Sent directives listed with their
  consumption status ("seen by DEC014").
- **Autonomy toggle**: full-auto ⇄ gated. Gated surfaces each accepted
  action as an approve/edit/reject card (the edit form is schema-driven
  from the action envelope).
- **Pause/Resume**, project-level.
- **Project settings**: one saved form reads the effective event-sourced value
  and edits the token ceiling, maximum research rounds, autonomy, Web-search
  permission, model ID, and reasoning effort for Research Manager, Solver,
  Explorer, Reviewer, and Synthesizer. W000 uses the Research Manager choice. A blank model
  uses the Codex CLI account default. Changes apply to processes launched after
  the settings event, including queued assignments that have not started;
  already-running processes retain their launch configuration.
- **Per-task**: hard interrupt, extend budget (+N tokens), both in the
  inspector.
- **Ledger interventions**: on claim rows — mark VERIFIED/REFUTED with a
  required note; on candidate — raise issue (severity/location/text); on
  cards — quarantine with note. All recorded as `by:"human"` events.
- **Questions inbox**: blocking questions modal-pinned; non-blocking
  listed in the dock; answer/defer/dismiss.
- **Intake gate**: creation first stores the raw objective, background, and
  uploads without launching a model. Next, the Research Manager drafts
  `W000 · Current mathematical view`. `AWAITING_CONFIRMATION` shows its
  one-or-two-sentence abstract and full Markdown in direct editors beside a
  rendered preview. The S### catalog remains expandable below. The owner may
  reopen the raw objective, background, and file list, revise them, and ask the
  Manager to regenerate W000; a raw revision makes the earlier W000 visibly
  stale and unconfirmable until regeneration succeeds. While that reading is
  active, its shared decision state keeps every client locked even after tab
  changes or reloads. A server restart closes an interrupted reading and
  preserves the preceding W000 for another attempt. Accepting the edit starts
  discovery and locks the retained intake; there is no questionnaire or intake
  chat.

### 11.8 Visual language

Dark-first, light supported (CSS custom properties, `prefers-color-scheme`
+ manual toggle). Role glyphs: Solver ◆, Explorer ✦, Reviewer ▣,
Synthesizer ⬢, Research Manager ●. Status colors are the only saturated colors;
everything else is neutral. Wave columns get faint alternating
backgrounds. Typography: a humanist sans for UI, serif for rendered
mathematics (KaTeX default), monospace for streams. Node text stays
legible at all zoom levels ≥ 0.5; below that, chips collapse to glyph +
ring (semantic, not geometric, degradation).

## 12. HTTP API

Same-origin, loopback-bound. JSON bodies ≤ 1 MB. Slugs and IDs
validated; artifact reads path-confined to the project directory.

| Method | Route | Purpose |
|---|---|---|
| GET  | `/api/health` | version, paths, codex binary status |
| GET  | `/api/runtime` | Codex and local TeX compiler status, pool occupancy, model defaults |
| GET/POST | `/api/projects` | list / create `{ title, slug?, statement, contextMarkdown?, config?, start? }`; `start:false` permits uploads before W000 |
| GET  | `/api/projects/:slug` | full `ProjectState` snapshot + `seq` |
| GET  | `/api/projects/:slug/events?since=` | SSE event stream (resumable) |
| POST | `/api/projects/:slug/publication` | start the current stopping report's final TeX reading, or retry its accepted TeX compilation |
| GET  | `/api/projects/:slug/publications/:id/pdf` | download a ready standalone PDF |
| GET  | `/api/projects/:slug/artifacts/:id` | artifact body + metadata |
| GET  | `/api/projects/:slug/tasks/:id` | task detail (packet manifest, memo, meta) |
| GET  | `/api/projects/:slug/tasks/:id/packet/*` | packet file viewer |
| GET  | `/api/projects/:slug/tasks/:id/stream` | SSE codex item tail (archive replay + live) |
| GET/POST | `/api/projects/:slug/sources[/:name]` | list/open or upload owner intake files |
| DELETE | `/api/projects/:slug/sources/:name` | remove an upload; retained intake files are replaceable/removable only before confirmation |
| POST | `/api/projects/:slug/raw-intake` | save a pre-confirmation `{ statement, contextMarkdown }` revision and refresh its source index |
| POST | `/api/projects/:slug/regenerate-intake` | regenerate W000 from the current raw submission |
| POST | `/api/projects/:slug/confirm-problem` | `{ problemMarkdown, managerAbstract, managerNoteMarkdown }` — save edited W000 and begin research |
| POST | `/api/projects/:slug/start` \| `pause` \| `resume` | lifecycle |
| POST | `/api/projects/:slug/autonomy` | `{ mode: "auto"\|"gated" }` |
| POST | `/api/projects/:slug/web-search` | `{ enabled }`; permit or deny Web search for future worker launches |
| POST | `/api/projects/:slug/models` | complete active-role model map; affects future process launches |
| GET/POST | `/api/projects/:slug/settings` | retrieve or atomically replace effective resource ceilings, autonomy, Web-search, and active-role model settings |
| POST | `/api/projects/:slug/directives` | `{ text, urgent }` |
| POST | `/api/projects/:slug/questions/:id/answer` \| `dismiss` | `{ answer? }` |
| POST | `/api/projects/:slug/gates/:decisionId` | `{ resolution: "approve"\|"edit"\|"reject", action?, note? }` |
| POST | `/api/projects/:slug/waves/:id/interrupt` | soft interrupt |
| POST | `/api/projects/:slug/tasks/:id/interrupt` | hard interrupt |
| POST | `/api/projects/:slug/tasks/:id/extend` | `{ addTokens }` |
| POST | `/api/projects/:slug/claims/:id/status` | `{ to, note }` (human) |
| POST | `/api/projects/:slug/issues` | `{ candidateId, severity, location, text }` |
| POST | `/api/projects/:slug/memory/:id/quarantine` | `{ note }` |

Errors: RFC-7807-ish `{ error, detail }` with 4xx/5xx. No auth in v1
(loopback only); adding a bearer token is a config flag away if the port
is ever forwarded.

## 13. Configuration

`project.json`:

```jsonc
{
  "slug": "…", "title": "…", "createdAt": "…",
  "budget": { "totalTokens": 40000000, "defaultTaskTokens": 1500000,
              "taskWallClockMinutes": 30, "reserveFraction": 0.25 },
  "models": {  // per role: model (null = account default) + reasoning effort
    "intake":          { "model": "gpt-5.6-sol", "effort": "max" }, // legacy only
    "researchManager": { "model": "gpt-5.6-sol", "effort": "max" },
    "planner":         { "model": null, "effort": "high" }, // legacy compatibility
    "solver":      { "model": null, "effort": "high" },
    "explorer":    { "model": null, "effort": "medium" },
    "reviewer":    { "model": null, "effort": "high" },
    "synthesizer": { "model": "gpt-5.6-terra", "effort": "high" } },
  "autonomy": "auto",
  "allowWebSearch": false,
  "limits": { "maxWaves": 20, "maxRepairRounds": 2, "maxConcurrentWorkers": 3 },
  "sourceMounts": [ { "name": "local-library", "path": "/path/to/local/library", "note": "owner-supplied research material" } ]
}
```

`project.json` supplies the creation-time configuration. The effective mutable
projection is then owned by the event log: all new resource-ceiling, autonomy,
model, and Web-search changes are written together as
`project.settingsChanged`. The older
specialized events remain replay-only compatibility. The snapshot, Settings
view, worker launcher, Research Manager context, and fresh-start clone all read
this same reduced configuration. Turning
Web search off also removes it from planned assignments that have not launched;
an already-running worker keeps its launch configuration. W000 remains an
offline reading of owner-supplied materials. The old `planner` and `intake` fields remain
solely for logs and projects created before the Research Manager/W000 changes
and are not user-editable. Every
completed task's `meta.json` records the model and effort actually used at
launch.

Server env: `INVENTIO_ROOT` (default `./projects`), `PORT` (4700),
`MEMORY_PORT` (4701), `HOST` (127.0.0.1), `INVENTIO_CODEX_BIN`
(default `codex`; the sim binary for tests), `INVENTIO_TEX_BIN` (default
`tectonic`), `INVENTIO_POOL` (3).

## 14. Failure modes

| Failure | Handling |
|---|---|
| codex process crash / nonzero exit | retry once fresh if no `thread.started`; else `resume` once; else `task.failed` |
| malformed structured output | one `resume` with zod errors; then `task.failed` |
| Research Manager repeatedly proposes an invalid action | automatic retries, then one-click operational recovery with the unchanged record |
| budget cap hit | hard interrupt, salvage last message, reason `budget` |
| wall-clock cap hit | same, reason `timeout` |
| conductor crash | replay log; resume or mark in-flight tasks interrupted (§6.8) |
| quota/auth failure from codex | project auto-paused + blocking Question with stderr excerpt |
| memory service error | worker proceeds without recall; warning event |
| publication drafting/validation failure | durable failed publication; owner may request a fresh final reading |
| TeX compiler missing or failing | fail before model spend when missing; otherwise retain accepted TeX and log for compiler-only retry |
| conductor stops during publication | replay converts the in-flight stage to an explicit drafting or compilation failure |
| torn tail line in events.jsonl | dropped on replay (write-ahead of artifacts prevents dangling refs) |
| SSE client lag/disconnect | resumable via `since`; server keeps no per-client state |

## 15. Testing strategy

1. **codex-sim**: a Node executable honoring the §8 contract — same
   flags, JSONL dialect, `--output-schema`-conformant final message,
   `resume` support, controllable via a scenario file
   (`INVENTIO_SIM_SCENARIO`) with per-call scripts: delays, token
   usage, outputs, malformed-output and crash injections.
2. **Unit** (vitest): reducer determinism and totality over the event
   union; action validation table; docket builder; acceptance predicate
   truth table; packet composer sealing (property: no path outside
   packet, no current-wave artifact ever granted); memory visibility
   matrix; budget arithmetic.
3. **Engine-level**: full project driven end-to-end on codex-sim through
   happy path, repair loop, budget exhaustion, crash-mid-wave restart
   (kill/relaunch engine, assert resume), gated mode.
4. **UI**: reducer shared, so UI tests focus on graph projection
   snapshots and route/deep-link resolution; fixture = a recorded
   sim-run event log replayed in dev mode (`ui` has a "replay fixture"
   dev entry that needs no backend).
5. **Real smoke** (`npm run smoke`, uses owner quota deliberately): one
   tiny problem (e.g. an elementary inequality) with
   `totalTokens ≈ 300k`, 1-solver + 1-reviewer waves, asserting a
   terminal state and well-formed artifacts.

## 16. Security posture

Loopback-only by default; the API is a control surface, treat port
forwarding as privileged. Workers: hermetic config, OS sandbox
(read-only or workspace-write on the packet), no network, no approvals
anywhere — escalation is impossible rather than deniable. Memory service
authenticates every call with a per-task bearer token and enforces role
visibility server-side. Mounted sources are owner-trusted by definition;
worker-produced text is data everywhere in the pipeline (the docket
builder never executes or interprets it; the UI renders Markdown with
raw HTML disabled). Post-terminal manuscripts pass an additional TeX boundary:
only abstract/body fragments are accepted, private IDs and file-I/O commands
are rejected, and a fixed preamble is compiled locally with Tectonic's
`--untrusted` mode. A PDF is served only after path confinement and a `%PDF-`
header check.

## 17. Future extensions (explicitly out of v1)

Concurrent active lineages with budget arbitration; embedding-based
memory search; a Lean-formalization worker role and proof-artifact
checker; gated web-research role with citation capture; multi-machine
worker pools; snapshot.json boot cache; cost accounting in currency.
