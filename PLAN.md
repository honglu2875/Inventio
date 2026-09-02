# Inventio implementation plan — resumable tracker

Rules for whoever (human or agent) picks this up:

- `TRAJECTORY-DESIGN.md` is the default-workflow spec. `DESIGN.md` and
  `PROTOCOL.md` define the replay-compatible `council-v1` workflow and shared
  infrastructure. Read the documents relevant to the code being changed.
- Work milestone by milestone. Update the **Status** line and check boxes
  as you go — this file is the recovery point after any interruption.
- Every milestone ends green: `npm test` passes at the repo root and the
  listed verification commands succeed before moving on.
- Keep `codex-sim` the default for all development and tests
  (`INVENTIO_CODEX_BIN`); real quota is only for M10.
- Record every deliberate divergence from DESIGN.md in the deviation log
  at the bottom, with a reason.

**Status: M0–M26 preserve the released `council-v1` implementation. M27 implements the default `trajectories-v2` workflow, M28 makes claim checking and round summaries stable, M29 hardens live-run integrity, M30 gives every mathematical author one rigorous ASD-STE100 English contract, M31 exposes the per-trajectory token limit as a durable project setting, and M32 adds a self-contained read-only HTML project export. Existing projects and event logs remain replay-compatible. The complete suite passes: 370 tests (schema 47, conductor 186, UI 116, codex-sim 21), all TypeScript packages typecheck, and the production UI builds.**
Last updated: 2026-09-02 by Codex.

Quota note: work has been interrupted twice by Opus subagent quota limits. The
tracker is the recovery point — check the milestone boxes, then
`npx vitest run --root packages/conductor` and `--root packages/ui` to confirm
where things stand before writing code.

---

## M32 — Self-contained HTML project export ✅

- [x] Add an **Export HTML** action to every live project without changing
      project state or pausing ongoing research.
- [x] Generate one offline HTML document with the production application,
      styles, dynamic chunks, and KaTeX fonts inlined.
- [x] Embed a consistent read-only project snapshot and reuse the ordinary
      tabs, graph, library, Markdown/TeX rendering, and inspector components.
- [x] Replace live routing and data access with hash routing and the embedded
      record. Remove Settings, project switching, live animation, and every
      mutating control.
- [x] Include the event history, mathematical artifacts, notes, supported text
      sources and briefs, and the last 200 transcript records for each task.
      Explain omitted binary or oversized files in the document.
- [x] Redact runtime thread handles and local source-mount paths, safely embed
      untrusted mathematical text, and cover the renderer and HTTP boundary
      with regressions.

Verify: `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`.

---

## M31 — Per-project trajectory token limit ✅

- [x] Expose the existing `budget.defaultTaskTokens` value as one project
      setting instead of creating a second execution limit.
- [x] Apply the saved value to future Solver and Explorer trajectories. Keep
      the budget recorded on already-running trajectories unchanged.
- [x] Validate the setting in the shared schema, HTTP boundary, engine, and UI.
      Keep older settings events valid when the field is absent.
- [x] Show the effective limit in Settings and explain that the remaining
      project allowance can reduce an individual trajectory's allocation.
- [x] Verify durable event replay and the effective scheduler configuration.

Verify: `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`.

---

## M30 — ASD-STE100 mathematical English ✅

- [x] Make the full ASD-STE100 Simplified Technical English, Issue 9, standard
      govern model-authored research prose. Permit established mathematical
      nouns and verbs as technical terms.
- [x] Give short direct sentences, stable terminology, clear referents, simple
      verb forms, gradual exposition, American English spelling, and one topic
      per paragraph as useful examples. State that these examples do not
      replace or limit the full standard.
- [x] Make mathematical rigor and self-containedness the explicit priority.
      The language rules cannot change hypotheses, quantifiers, dependencies,
      logical scope, formulas, citations, proper names, code, or schema keys.
- [x] Append the contract to every generated project `AGENTS.md`: v2 intake,
      Solver, Explorer, Verifier, comparison, summary, and final calls; every
      legacy Manager and worker call; and post-terminal publication drafting.
- [x] Let a v2 summary reader make one meaning-preserving style correction to
      a view that predates the shared contract. Prevent repeated style churn.
- [x] Mark Research Manager examples as judgment examples rather than syntax
      templates. Document the standard, its mathematical adaptation, and the
      complete call coverage in the central prompt guide.
- [x] Add a source-level regression that fails if a future generated
      `AGENTS.md` bypasses the shared writing wrapper.

Verify: `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`.

## M29 — Live-run integrity and recovery ✅

- [x] Parse model JSON without allowing legal JSON escapes such as `\f` and
      `\t` to silently consume the leading slash of TeX commands. Repair known
      historical control-character damage on read and reject unexplained
      controls instead of persisting them. Preserve a structural JSON newline
      before ordinary `e` or `u` anywhere in model text, while retaining a
      properly escaped `\ne` or `\nu` command byte-for-byte.
- [x] Validate TeX delimiters by backslash parity, so an aligned-row break such
      as `\\(k,p,q)` is not mistaken for a mathematical `\(` opener. Recover
      older full trajectory returns rejected solely by that validator defect,
      then materialize their write-ups and claims exactly once.
- [x] Account every Solver and Explorer call, including timeouts, budget stops,
      retries without a usage report, and recovered historical tasks. Keep the
      charge cumulative and idempotent across replay and resumed calls.
- [x] Treat an application stop or hot reload as an operational pause rather
      than a failed research trajectory. Preserve partial work and spend, leave
      the task running, and resume the same Codex thread after restart.
- [x] Fence every project event log to one live Inventio process, detect an
      outside writer before appending, reclaim crashed-process locks, and
      release all acquired locks when server startup fails. Recover the one
      observed agreeing-terminal fork into a contiguous log while retaining
      the original conflicted bytes; never guess between divergent results.
- [x] Carry partial work into round summaries and the task inspector with an
      explicit unchecked warning. Extract readable mathematical prose from a
      partial structured draft instead of displaying raw JSON.
- [x] Normalize model-authored multiline `$$` blocks before Markdown parsing,
      including attached closing markers in stopping reports, without changing
      compact displays, code, or unmatched input. Exercise the real
      ReactMarkdown/KaTeX rendering path in regression tests.
- [x] Reconcile live project evidence after repair: interrupted calls retain
      nonzero charges, stale round summaries are refreshed, and recovered claims
      proceed through ordinary independent checks rather than special trust.

Verify: `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`.

## M28 — Claim preparation and stable round summaries ✅

- [x] Check every trajectory claim for transport damage, malformed math
      delimiters, internal project references, and references to omitted work
      before persistence. Reuse the existing single structured-output repair
      turn in the originating trajectory; do not introduce a mathematical
      editor or a direction-setting prompt.
- [x] Compare current statements against the existing claim record before
      proof checking. The narrow comparison call may record exact mathematical
      identity only; runtime validation rejects unknown IDs, incompatible
      claim kinds, or different claimed relations to the original problem.
- [x] Check one proof in an identical-statement group at a time. A failed proof
      leaves later distinct proofs available, while a successful proof records
      one fact and retains the others as inspectable duplicates.
- [x] Add verifier finding categories and the `NEEDS_REVISION` claim state.
      Missing dependencies and damaged or undefined notation no longer appear
      as mathematical failures; incorrect steps and substantive proof gaps
      still do. Existing uncategorized FAIL events retain their earlier meaning.
- [x] Finish the round's checks before writing its mathematical view, so saved
      summaries never race a verification result. Checks still run concurrently
      with one another through the shared process pool.
- [x] Expose claims needing revision and verifier findings in the library,
      inspector, graph, compact worker library, and correction warnings.
- [x] Make live UI event reduction recover from server/browser version skew by
      replacing stale client state with a fresh snapshot.
- [x] Add focused regressions for one-turn claim repair, review categories,
      pre-review equivalence, single-proof scheduling, stable summary order,
      and client snapshot recovery.

Verify: `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`.

## M27 — Long independent trajectories ✅

Binding spec: `TRAJECTORY-DESIGN.md`. This is the default workflow for new
projects; the earlier council remains available as `council-v1` for existing
projects and deterministic replay.

- [x] Add an explicit workflow version and preserve legacy event replay, state,
      artifacts, API behavior, and UI interpretation.
- [x] Add project settings N/M/V/W: Solvers and Explorers per round, independent
      checks per claim, and passes required for promotion (`W <= V`). Defaults
      are N=2, M=2, V=2, W=2, five rounds, an eight-process global pool, and Web
      search enabled.
- [x] Replace model-directed round planning in `trajectories-v2` with a small
      deterministic loop that starts the configured long Solver and Explorer
      trajectories. No Research Manager chooses assignments or research
      directions in this workflow.
- [x] Give each trajectory a two-hour default, independent context, broad
      project-scoped read tools, a private calculation directory, optional Web
      search, the current mathematical view, active facts and claims, original
      sources, and verbatim human guidance.
- [x] Require a complete trajectory write-up plus a short parseable collection
      of worthwhile new mathematical statements with self-contained proofs;
      store these as Markdown claims rather than treating assumptions or routine
      examples as results.
- [x] Run independent checks through the shared process pool. Promote a claim
      only after W of V independent PASS results; operational verifier errors
      are replaced and never count as mathematical evidence.
- [x] Record equivalent claims transitively while retaining distinct proofs.
      Once one proof is accepted, remove its equivalents from the active claim
      pool and preserve them as inspectable duplicates.
- [x] Let each trajectory raise at most one concrete challenge to an accepted
      fact. Store the challenge as a correction claim and submit it to the same
      independent verification process before changing the fact.
- [x] Let a strong summary reader make a small end-of-round revision to W000
      only when new claims or facts materially change the mathematical picture;
      it cannot plan, dispatch, or direct the next round.
- [x] Add sparse trajectory milestones and render trajectories, claims, facts,
      checks, equivalences, corrections, and intermediate progress in the
      existing UI without replacing its overall navigation.
- [x] Separate the initial W000 reading from all legacy Research Manager prompt
      material and preserve an editable preview based on the raw objective,
      notes, uploads, and source tools.
- [x] Add crash recovery for finished trajectory and verification outputs so a
      restart records already-durable work without repeating a model call or
      spending its tokens twice.
- [x] Centralize and document every new prompt and tool contract; update the
      repository overview and mark the older protocol documents as compatibility
      references rather than the default research design.
- [x] Verify exact JSON/Markdown preservation (including literal `\\frac`),
      recovery, threshold failure, replay determinism, API behavior, graph
      derivation, UI rendering, and legacy compatibility.
- [x] Live-smoke N=2/M=2: reserve a distinct contiguous task-ID range before
      recording a round and fail fast on any duplicate, so four configured
      trajectories launch as four processes instead of racing over one task.
- [x] Launch the authenticated local MCP server as required with strict Codex
      config, an exact tool allow-list, and documented noninteractive approval.
      Replace the blocking historical diagnostic with the production async
      runner; its real-account marker retrieval passes.

Verify: `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`.

## M0 — Documents ✅

- [x] `PROTOCOL.md` (constitution, retargeted to Conductor+Planner)
- [x] `DESIGN.md` (full system + interface spec)
- [x] `PLAN.md` (this tracker)
- [x] Verified codex-cli 0.149.0 flags and JSONL dialect live (recorded in DESIGN §8.1)

## M1 — Monorepo scaffold + schema package ✅

- [x] Workspace root: `package.json` (workspaces, scripts: `dev`, `build`, `test`, `smoke`), `tsconfig.base.json`, `.gitignore` (`projects/`, `node_modules`, `dist`)
- [x] `packages/schema`: zod models for config, IDs, events (full §5 taxonomy), `ProjectState`, reducer `applyEvent`, `deriveOpsGraph`/`deriveEvidenceGraph`, planner action envelopes, worker output schemas, JSON-Schema export for `--output-schema` files
- [x] Reducer unit tests: totality over event union, determinism, replay = fold (15 tests green; `tsc` clean)
- Verify: `npm test -w @inventio/schema`

## M2 — codex-sim + codex runner ✅

- [x] `packages/codex-sim`: executable honoring DESIGN §8 + its own CONTRACT.md (Opus subagent; 21 tests). Scenario JSON drives behaviors ok/malformed-output/crash-mid-stream/hang/exit-nonzero; state dir logs `calls.log.jsonl` + `consumed.json`
- [x] `packages/conductor/src/codex/runner.ts` + `structured.ts`: spawn, tolerant stream-parse, archive, estimator metering (usage only arrives at turn.completed), SIGINT→grace→SIGKILL, resume (note: `codex exec resume` accepts no `-C`/`-s`; cwd via spawn opts), one repair round-trip on invalid output, crash retry policy per DESIGN §14; `registerKill`/`onThread`/dynamic budget cap hooks for the engine
- [x] Runner tests against sim: 10 tests (happy, budget kill, timeout, SIGKILL escalation, malformed→repair, double-malformed, crash→resume, fresh retry, interrupt salvage)
- Verify: `npx vitest run --root packages/conductor test/runner.test.ts`

## M3 — Conductor core: engine, persistence, packets ✅ (unit level; e2e = M5)

- [x] `src/store/eventLog.ts`: fsync append, torn-tail tolerance, seq-gap/corruption rejection, validate-before-append
- [x] `src/store/projectStore.ts`: layout, atomic writes, project.json, slug listing (+ decisions/ dir)
- [x] `src/engine/engine.ts`: ProjectEngine — sequential protocol loop (intake→confirm→decision→wave→curation→acceptance→final), gates (pause/blocking questions/gated decisions), recovery via replay + stale-task resume
- [x] `src/engine/packets.ts`: jail composer — copies only, symlinks never followed, seal violations throw, mount excludes + size caps; `src/prompts/workers.ts`: role contracts + AGENTS.md/research-question.md generation
- [x] `src/engine/pool.ts` worker pool; soft/hard interrupts; estimator budget + wall-clock enforcement
- [x] `src/engine/docket.ts` mechanical docket with dedup + author-neutral claims (unit tested)
- [x] `src/engine/validate.ts` action validation table; `acceptance.ts` predicate; `computations.ts` record/reproduce
- [x] 11 unit tests green (`test/core.test.ts`); `tsc` clean
- Verify: engine-level sim e2e in M5

## M4 — Memory service ✅

- [x] MCP streamable-HTTP server (low-level SDK Server, stateless per-POST, bearer-token task auth, 401/404/405 paths, socket-tracked stop) — Opus subagent; SDK 1.30 adaptations documented in its report
- [x] `memory_search` / `memory_expand` with visibility matrix (reviewer VERIFIED-only, quarantine refusal+warning rows, path-traversal guard on sourceArtifact); recall recording via callback → `memory.recall` events (engine.recordRecall)
- [x] `CardStore`/`FileMemoryBackend`: hand-rolled frontmatter, atomic writes, ranked substring search; admission rules live in engine curation (self-verification downgrade)
- [x] 19 tests green over real HTTP with the SDK client
- Verify: `npx vitest run test/memory.test.ts` (from packages/conductor)

## M5 — Planner integration + full protocol loop ✅

- [x] Decision packet assembly (§6.2); decision-point calls with the action envelope schema (§6.3); mechanical validation table; bounce + blocking-question on second failure
- [x] Intake mode + confirmation gate; Curation mode (resolution, card admission, capsules + digest with caps); Final mode with mechanical RESULT stamping
- [x] Freeze/versioning, lineage handling, review routing, issue ledger, repair loop, dispositions
- [x] Acceptance predicate (§6.7); computation runner + reproduction (§10)
- [x] 16 e2e sim scenarios (Opus subagent): happy→PROVED, repair loop→v2, terminate→UNCERTAIN (with RESULT stamping over a deceptive planner line), planner bounce, double-illegal→blocking question, budget-killed task still closes the wave, gated approve + reject, graceful-stop reload, true kill -9 resume (§6.8 path), dispositions→acceptance, budget ceiling, abandon lineage, cross-exam, malformed output repair
- [x] Two engine bugs found and fixed by the test agent: directives were marked consumed before the decision packet was composed (so the "pending directives" section was always empty — a human directive was recorded as seen by a decision that never saw it); `record_dispositions` evaluated acceptance but never finalized (a candidate cleared by a disposition would loop instead of terminating)
- Verify: `npx vitest run --root packages/conductor` → 73 tests green (5 files), `tsc` clean

### M5 follow-up fixes applied by chief designer (2026-08-23)

- `crossexam.answered` now carries `usage`; the reducer meters it as worker spend (cross-exam tokens were previously invisible to every budget counter)
- Planner/intake/curation/final and cross-exam calls register kill handles, so `engine.stop()` can no longer block for up to the 20-minute planner wall clock
- Interrupted tasks' salvaged partial work now reaches the docket, labeled as an unvalidated untrusted lead (§6.4 promised this; it was dead-ended in `salvage.md`)
- Protocol reserve floor enforced (§6.5): `plan_wave` is rejected once remaining budget drops below `totalTokens × reserveFraction`, and the planner's ledger carries an explicit warning line so it steers toward cross-exam/freeze/terminate
- Digest cap enforced at curation (capsules already were)

## M6 — HTTP API + SSE ✅

- [x] Fastify server (Opus subagent): all DESIGN §12 routes; zod validation; 1MB body cap; path confinement proven against raw-socket and percent-encoded traversal; SSE `/events?since=` + Last-Event-ID with 15s heartbeat; per-task `/stream` (last-200 replay + 500ms tail); hand-rolled static UI serving with SPA fallback; `forceCloseConnections` so SSE never pins shutdown
- [x] `src/server/manager.ts` EngineManager (create/openAll/list/shutdown, slugify, config merge, typed ManagerError); `src/main.ts` boot with env per §13, memory-service wiring, graceful SIGINT/SIGTERM
- [x] 17 tests green; `tsc` clean; verified live: boot → walkthrough script (health/create/snapshot/directive/SSE frames) → SIGINT → reload with `openAll()`
- Verify: `packages/conductor/scripts/api-walkthrough.sh` against `npm run dev`
- Follow-ups owned by chief designer: give engine errors a `code` field (HTTP mapping is message-coupled); register kill handles for planner calls so `engine.stop()` cannot block on an in-flight planner call (apply after M5 agent releases engine.ts)

## M7 — UI shell, library, inspector ✅

Binding spec: `packages/ui/UI-SPEC.md` (authored by the chief designer; the
executor built to print). Layout engines were authored + tested separately.

- [x] Vite + React 18 scaffold, zustand store fed by the shared reducer inside one immer `produce` per rAF batch, snapshot + SSE resume dropping replay overlap; routes per §11.1; dark/light tokens
- [x] L0 project cards + New Problem dialog + intake confirmation screen
- [x] Library: tree with counts, claims table with filters + human interventions, memory grid, computations table, markdown + KaTeX (raw HTML off), permalinks
- [x] Inspector: all six tabs (Artifact, Packet, Memo, Recall, Events, Stream) with per-tab lazy mount and an EventSource opened only while Stream is visible
- [x] Fixture-replay dev mode (`?fixture=happy`, generated from the schema package's canonical event sequence — no backend needed)
- Verify: `npx tsc -p packages/ui` clean; 43 tests green; `npm run build -w @inventio/ui` succeeds

## M8 — Graph views ✅

- [x] Deterministic layout engines as pure functions (`src/lib/layout.ts`, `src/lib/evidenceLayout.ts`) — column slots by wave index, fixed lanes, collapse-set; **10 layout tests** including position-stability under wave append and collapse isolation
- [x] Ops view: wave group nodes (collapsed chip ↔ expanded children), task nodes with status ring + token gauge, lineage lane with burn-down chips, memory hub, question rail, top strip
- [x] Evidence view: dependency-ranked claim/issue DAG with issues floating above their targets, version selector, abandoned-lineage picker
- [x] Deep links `/p/:slug/node/:id` resolving into the owning view
- Verify: layout tests + selection-resolver tests green; React Flow used for pan/zoom/selection only

## M9 — Steering ✅

- [x] Directive dock (normal/urgent + consumption status), autonomy toggle, gate cards with schema-driven edit form validated client-side by `validateActionEnvelope`, pause/resume
- [x] Per-task interrupt/extend; wave soft-interrupt
- [x] Ledger interventions (claim status, raise issue, quarantine card) with human-provenance events
- [x] Questions inbox (blocking modal + dock list)
- [x] No optimistic UI anywhere: every action POSTs and waits for the event stream
- Verify: engine-side steering paths covered by the sim e2e suite; UI side needs the live-backend pass in M11

## M10 — Real-quota smoke ✅ (one clean end-to-end pass)

`packages/conductor/scripts/smoke.ts` — drives the whole protocol against the
real `codex` CLI and asserts from the outside: terminal reached, `final.md`
stamped with a RESULT line agreeing with `terminal.result`, every recorded
artifact present on disk, the event log replaying to exactly the engine's
final state, at least one task completed, and (when accepted) two genuine
PASS reviews behind the acceptance.

**Run 3 (final code): PASSED — RESULT: PROVED.** 475s, 249,666 tokens
(workers 99,178 / planner 150,488), 2 waves, 5 tasks completed, 7 claims,
4 memory cards. Roster chosen by the Planner unaided: two solvers on distinct
methods plus an explorer, then a synthesis-free freeze and two sealed
reviewers with different audit emphases — the PROTOCOL §4 defaults, unprompted.

Verified along the way, on real packets: a wave-1 solver's packet contained
only the problem, its assignment and its role contract — its concurrent
peer's attempt was absent, not merely forbidden; each reviewer got the frozen
candidate plus the ledger extract and neither got the other's verdict or the
author's identity.

- [x] Real-quota smoke passing end to end
- [x] Real-JSONL deltas vs sim: none needed — the tolerant parser handled every
      real event; `thread.started` / `item.*` / `turn.completed` matched
      DESIGN §8.1 exactly. Two *behavioral* gaps were found instead (budget
      realism and the acceptance deadlock) — see the deviation log.
- [ ] Re-run once more to confirm stability (the "twice consecutively"
      criterion) — deferred to save operator quota; runs 1 and 2 were
      deliberately killed mid-flight after they surfaced the two bugs, so
      only one run has completed on the final code.

## M10 — original checklist

- [ ] `npm run smoke`: tiny problem, ~300k token ceiling, 1-solver/1-reviewer waves, real `codex`; asserts terminal state + well-formed artifacts + reproducible event replay
- [ ] Record observed real-JSONL deltas vs sim; fix parser/sim as needed
- Verify: smoke passes twice consecutively

## Findings from the first real research run (Hodge conjecture, 2026-08-24)

Problem: "Prove the Hodge conjecture for smooth complete intersections in
complex projective space" — open in general, with a trap (every non-middle
degree and every odd dimension collapses by Lefschetz, so a sloppy agent can
over-extend a real theorem into a Millennium Prize claim).

**Outcome: TERMINAL UNCERTAIN**, 5 waves, 16 tasks, all completed, ~1.95M
tokens of a 12M budget, ~90 minutes. The system did **not** bluff. `final.md`
correctly reduces to `n=2m≥4, p=m` primitive middle classes, settles quartic
fourfolds via uniruledness, identifies smooth sextic fourfolds as the true
frontier, and states plainly of the strongest proposals: *"These claims were
not accepted as a proof."* The mathematics is credible throughout.

### F1 — Memory recall was completely dead (FIXED)

Every `memory_search` from every worker failed with `MCP tool call requires
approval, but approval policy is never`. 57 curated cards, none ever readable.
The original diagnostic later proved invalid: it tried the obsolete
`approval_mode` key and used `spawnSync` while hosting the MCP server in the
same Node process, which froze the server during its own handshake.

The legacy fallback remains useful: its catalog travels **inside the packet** as `research-library-index.md`,
role-filtered by the Conductor (reviewers see only VERIFIED; quarantined rows
render as explicit warnings; PENDING current-wave cards never appear), exactly
the file-based protocol PROTOCOL §7 specifies. The direct tool path is now also
fixed: generated Codex configuration is strict, the authenticated server is
required, its tools are allow-listed, and `default_tools_approval_mode` is
`approve`. The asynchronous real-account probe reaches the server and expands
its marker card without a human prompt.

### F2 — The adversarial layer never engaged (FIXED — scoped candidates)

**0 candidates frozen, 0 reviews, across 16 tasks and 74 claims.** Because the
full statement was out of reach, the Planner never froze anything — so the
partial results that *were* established (all non-middle degrees, all odd
dimensions, quartic fourfolds) reached `final.md` as unreviewed worker claims.
The entire verification apparatus — the reason this system exists — sat idle
on a run that produced real mathematics.

Fix (implemented): a candidate may carry a **scope** — the exact narrower
statement it establishes.
- `freeze_candidate.scopeMarkdown` (null = the whole problem), carried on
  `candidate.frozen` (`.default(null)`, so old logs replay) into
  `CandidateState.scope`.
- The acceptance predicate refuses a scoped candidate by construction, so a
  partial result can never be mistaken for a solution.
- Reviewers of a scoped candidate are told the scope in `research-question.md` and
  instructed to judge against it: failing it for not proving more is wrong,
  and so is letting it overreach or letting the scope be written to match a
  weaker argument (a CRITICAL issue either way).
- The Research Manager contract now pushes for this ("the usual case in research… do
  not wait for the whole problem to fall") and `terminate` asks explicitly
  whether anything provable is being left unreviewed.
- `current-record.md` marks a scoped candidate with 2 PASS and no open issues as a
  VERIFIED PARTIAL RESULT; the final packet carries a "Verified partial
  results" section, and the final contract demands three visibly distinct
  tiers: verified-by-review, asserted-but-unreviewed, and conjecture.
- PROTOCOL §5 documents it. Regression test 16.

### F3 — No literature access for "status audit" tasks (FIXED)

The Planner repeatedly commissioned explorers named
`open-status-and-counterexample-audit`, `authoritative-status-triangulation`,
`primary-source-audit` — but workers are hermetic with no network and were
granted no sources, so all of it ran on model memory alone. PROTOCOL §1.8 asks
for a status check "when reliable sources are available" and the harness makes
none available.

Fix: Codex has a **native `web_search` tool** (`-c tools.web_search=true`),
verified live — it returned "Steven Zucker proved the Hodge conjecture for
cubic fourfolds in 1977" with a numdam.org citation, and it works inside the
read-only sandbox because it is a model-side tool, not a shell command, so
the packet seal is unaffected. Note this is the answer to "should memory be a
tool too?": no. For the catalog, files beat tools (deterministic, no
round-trip, cannot be denied); for literature, the native tool is right.

Wired as a **grant, not a default**, at the owner's request — contaminating a
run with internet material must be a deliberate choice:
- `ProjectConfig.allowWebSearch` (defaults **false**, `.default()`-ed so old
  projects load) gates the whole project;
- `PlannedTask.webSearch` / `RosterEntry.webSearch` grants it per task;
- the validator rejects any grant when the project has it off, with a message
  telling the Planner to use the owner's supplied sources instead;
- `current-record.md` states availability so the Research Manager never proposes an illegal
  grant blindly;
- the worker contract says a search result is a citation needing precise
  provenance, never a proof, and never a substitute for its own reasoning;
- PROTOCOL §8 rewritten accordingly.

Backward compatibility verified by replaying both existing projects
(537 and 101 events) against the new schema.

Remaining: a checkbox in the New Problem dialog's advanced section (the API
already accepts it through the config merge) — see M11.

### F4 — Voice held up better on real mathematics (evidence for M12.1)

Wave titles on this run read like a seminar ("Reduce the assertion to its
primitive middle-cohomology core and test whether that core is presently
provable") versus the toy run's compliance-department register ("Sealed
independent verification of C001.v1"). The corporate voice is worst when the
mathematics is thin. Minor cosmetic bug: the Planner began prefixing wave
titles with the wave id ("W003 — …"), duplicating what the UI already shows.

### F7 — Intake clarification flow (superseded by M17)

This was an intermediate design. The owner subsequently chose a smaller flow:
retain all raw materials, let the Research Manager write W000 once, and edit
W000 directly. No questionnaire or intake chat is part of the current UI.

Backend implemented:
- `IntakeOutput.clarifications: [{ id, question, kind: "choice"|"text",
  options, why, suggested }]` — the intake contract was rewritten to ask only
  what a competent colleague would genuinely have to stop and ask, with
  concrete options and the reading it would take by default; an empty list is
  explicitly the right answer for a clear statement (this is also M12.2).
- Events `intake.answered { answers }` and `intake.revised { problemMarkdown,
  notes }`; state carries `problem.clarifications`, `problem.answers`,
  `problem.revised`.
- `engine.answerClarifications(answers)` records the answers and runs a
  revision planner call (`REVISION_CONTRACT`) that rewrites the statement to
  incorporate them, taking its suggested reading for anything unanswered and
  saying so. Failure is non-fatal — the owner can still edit by hand.

The old event and schema fields remain replay-only compatibility. The proposed
clarification route and stepper were intentionally not built.

### F8 — TeX rendering compatibility (owner reports; DONE)

Models emit `\\( … \\)` / `\\[ … \\]`, which `remark-math` does not recognize —
so intake Preview showed raw LaTeX. Two-sided fix: every prompt surface
(worker output requirements, planner next-move/intake/revision/final
contracts) now demands `$ … $` and `$$ … $$` and forbids the paren form;
the UI normalizes both forms before parsing and provides a render-math toggle
for node labels, cards, and claim tables.
The renderer also repairs the provably invalid model pattern in which
`\left` and `\right` cross an `aligned` row or cell boundary, while leaving
valid delimiters around a nested multiline environment unchanged. All model
contracts now explain the corresponding fixed-size-delimiter rule.

### F5 — Intake ceremony confirmed unnecessary (evidence for M12.2)

Intake produced an excellent normalization (correct quantification, both
Hodge-class and cycle-class formulations, rational-vs-integral distinction
flagged) and four ambiguities — but its own text already said "the natural
reading is universal". The model knew the answer; the taxonomy asked the human
to rubber-stamp it.

### F6 — Owner UX request: drag files in at intake (DONE; completed in M17)

The New Problem dialog and CREATED intake screen accept files. Project creation
is deferred until staged uploads are durable, then W000 receives the exact
files. The S### manifest preserves hashes and short descriptions; retained
uploads cannot be silently replaced or deleted. The existing size, path, and
symlink protections remain in force.

## M12 — Voice, intake simplification, worker robustness (owner direction, 2026-08-24)

Owner's direction, recorded verbatim in substance for the final tuning pass.
This is a *separate phase from M11*: it is about how the system reads and
behaves, not whether it works. Do it once the infrastructure is settled, with
real problems in front of you — not before.

### 12.1 Make the research record sound like mathematics, not a project team

The process should model **human discovery**. Codex's default register is
engineer/corporate and it does not read like mathematical discourse. Evidence
from the first real runs: wave titles like *"Sealed independent verification of
C001.v1"*, method tags like `formal-algebra-equality-audit-v2`, memo prose
about "budget utilization" and "deliverables". A mathematician would say
"check the equality case" and "second look at the same proof".

- Draw a firm boundary around the change. The UI, event log, schemas, and code
  may keep concise operational names and neutral statuses such as TERMINAL,
  VERIFIED, UNVERIFIED, PROPOSED, REFUTED, PASS, FAIL, MAJOR, and MINOR. Do not
  perform a risky storage migration merely to rename an internal field.
- Rewrite everything the research models read, and everything they are asked
  to write, in the language of papers, seminar notes, and referee reports.
  Prefer attempt, approach, lemma, source, gap, obstruction, example,
  calculation, proof, and "what would break this argument".
- Keep unavoidable JSON keys such as `lineageId`, `taskDispositions`,
  `provenance`, and `recallLog` in a short output-format appendix. Do not let
  those implementation names organize or color the mathematical instructions.
- Remove the following vocabulary from the generated mathematical experience
  unless it is itself the object of discussion: packet, provenance, conductor,
  lineage, ledger, disposition, digest, sealed, docket, recall, curation,
  capsule, unblock, gate, directive, reconciliation, admission, promotion,
  quarantine, triage, debt, backlog, queue, freeze, mechanical, audit,
  certificate, manifest, dispatch, salvage, telemetry, and lifecycle.
- Ask for write-ups that read like notes to a colleague. Their mathematical
  body should not mention agents, task IDs, rounds, token use, orchestration,
  output schemas, or internal filenames. Motivation, exact statements,
  arguments, examples, failed ideas, and the least certain step belong there.
- Give model-visible copies of supporting files academic names such as
  `current-record.md`, `project-summary.md`, `research-notes.md`, and
  `references/`. Durable storage paths and UI labels remain unchanged.

### 12.2 Radically simplify intake

Current intake (normalize → ambiguity classification → material/non-material
cards → diff-style confirmation screen) is more ceremony than the job needs.
The final design is smaller still: store the exact objective, long notes, and
documents first; let the Research Manager read them with ordinary specialist
understanding and write W000; then let the human edit W000 directly and start.

- No generated ambiguity taxonomy, questions, raw-memory extraction, or chat.
- One short abstract and one free-form editable mathematical view, with the
  untouched originals expandable below it.
- Keep the gate itself (the worst failure is faithfully solving the wrong
  problem) — simplify everything around it.

### 12.3 Workers are dispensable; the process must not stall

Observed tendency: subagents complain, ask for permission, or get stuck
instead of working. The orchestrator must be able to unblock or cut them off,
and the run must stay automatable end to end.

- Add a **derailment check** on returned work: output that is a complaint, a
  request for permission, a restatement of the assignment, or an empty
  artifact is not a result. Detect it (cheap heuristics first: no
  `CONCLUSION:` line, artifact under N chars, refusal/permission phrasing).
- Policy on derailment: at most one short unblocking nudge ("you have
  everything you need in this directory; proceed"), then kill and re-dispatch
  the assignment to a **fresh** worker. Never let one stuck worker hold a wave.
- Never block the run on a worker's question — a worker question is a memo
  note, not a gate. Only the Planner may raise a human-blocking question.
- Consider a wave-level watchdog: if a wave produces no usable artifact at
  all, the Planner is told that plainly in the docket rather than being handed
  an empty wave and left to guess.

Implementation checkpoint:

- [x] 12.1 model-facing instructions, copied working files, round summaries,
      and fallback reports use academic language throughout. Internal schemas,
      statuses, durable paths, and UI wording remain stable; exact JSON keys
      appear only in compact output-format sections.
- [x] 12.2 intake is now W000: the strong Research Manager reads the retained
      raw submission with minimal bias, writes a short abstract and free-form
      current mathematical view, and the human edits it directly. Legacy
      digest/memory/question fields are empty compatibility fields only.
- [x] 12.3 curator/planner failures retry automatically and every completed
      attempt receives a durable carry/follow-up/set-aside disposition. A
      set-aside route retires its unverified leads. Schema-valid but unusable
      returned work is detected conservatively; it gets one same-thread nudge,
      then a fresh sealed session, with all attempts metered. A failed
      replacement closes as a failed task rather than holding the round.
      Next-step instructions and schema descriptions now distinguish full
      write-ups (A/E/R/C), research-library notes (M), and claim labels (K);
      validation explains a namespace mistake using the correct source, and a
      third automatic correction turn prevents a newly exposed reference typo
      from becoming a human-blocking question.
- [x] Intake-only retry creates a separately named project from the original
      objective, background, project-local uploads, W000, source descriptions,
      and research settings. It starts at W000 review without a model call and
      imports no later rounds, tasks, claims, library entries, artifacts,
      computations, event history, or external mounts; the original project
      remains untouched.

## M13 — Selective rebase, integrity, and research-debt closure (2026-08-24)

This milestone integrates the useful behavioral experiments into Inventio's
runtime and interface without importing obsolete implementations wholesale.

- [x] Model-JSON transport protects TeX commands before `JSON.parse`; the exact
      reported `\frac` formula and every legal JSON control-prefix family are
      regression-tested. New unexplained C0/C1 controls are rejected before
      persistence. The UI repairs known legacy forms and renders any unknown
      byte visibly instead of leaking an invisible character.
- [x] KaTeX compatibility repairs cross-row/cross-cell `\left`–`\right` pairs
      inside alignment environments to fixed-size delimiters at display time;
      the exact reported tagged genus-two correlator is regression-tested.
- [x] Computation baselines reproduce the packet-relative `scratch/` layout,
      run baseline and rerun from separate pristine copies, and retain exit
      status/stderr. A one-time exact-pattern migration preserves each broken
      baseline under `legacy-broken-baseline/` before replacing it.
- [x] The acceptance predicate scopes computation obligations to the source
      candidate rather than poisoning every candidate with an unrelated failed
      experiment.
- [x] Curation extracts at most eight load-bearing claims, skips exact
      duplicates, records a durable disposition for every attempt, and can
      close claims only with independent conclusive evidence from the current
      sealed round.
- [x] Legacy/fallback claim-producing tasks must be assessed before new broad
      work or termination. Setting an attempt aside automatically changes its
      remaining UNVERIFIED leads to SUPERSEDED; independently verified claims
      are preserved. The UI separates untriaged, focused-follow-up, carried,
      and background leads instead of presenting one alarming raw count.
- [x] Returned-work integrity catches placeholders, missing/contradictory
      conclusion lines, and permission/access refusals with no mathematical
      content. One short automatic unblock is followed by a fresh worker; no
      worker complaint becomes a human-blocking question.
- [x] Carried PROVED/DISPROVED attempts create enforceable review debt. The
      chair must freeze a precise (possibly scoped) candidate or set it aside;
      two clean independent reviews establish a scoped partial durably and
      release the active lineage without claiming the whole problem.
- [x] Terminal reports are immutable checkpoints. “Continue research” adds
      explicit resources and retained owner direction and writes later reports
      to unique paths rather than overwriting history.
- [x] UI fixes: inspector opening no longer continually recenters the graph;
      event-card contents stay contained; exact blocking questions live in a
      persistent nonmodal strip; long intake memories are editable.
- [x] Custom port and tailnet-only binding are documented; Vite's proxy target
      is configurable through `INVENTIO_API_TARGET`.
- [x] Full verification: 238 tests, package typechecks, production UI build,
      and a read-only live-data audit. On isolated temporary copies, all 32
      computation records present in the active run at the final snapshot
      migrated to exact green reruns with zero exit codes.
- [x] Real milestone: on a clean continuation copy of the complete-intersection
      run, independently review and establish the rational Hodge conjecture for
      every smooth quartic fourfold as a scoped result. Two sealed reviewers
      returned PASS with no issues; K013–K016 became VERIFIED, 66 unsupported
      legacy leads became SUPERSEDED, four background leads remained
      UNVERIFIED, and all five migrated computations reproduced exactly. The
      full complete-intersection problem correctly remained open. The runtime
      project remains private and is not part of this source repository.
- [x] Move the application into its standalone Inventio repository after owner
      review of the research behavior and interface.

## M14 — A small, curated working library (2026-08-24)

The event log and artifacts remain the lossless research archive; ordinary
recall and the Library UI now present a deliberately smaller working surface.
This is curation inside the existing round reconciliation, not a new agent role
or a second orchestration loop.

- [x] The curator can create at most four source-bearing condensations and
      retire redundant, low-value, or exhausted PROPOSED cards. Superseded
      records are never deleted, and VERIFIED/QUARANTINED records cannot be
      removed merely to make the catalog neat.
- [x] Condensed abstracts are mechanically limited to one–four sentences and
      480 characters. Their bodies must be organized as named mathematical
      conclusions (definition/theorem/proposition/lemma/example/computation/
      obstruction/question/heuristic/remark), without attempt chronology or
      process narration.
- [x] A `promising` marker is an ordinary searchable tag, assigned only when a
      record has concrete leverage on a live bottleneck. It raises recall and
      UI ordering but never changes epistemic status; every librarian synthesis
      enters PROPOSED.
- [x] Planner packets, packet memory indexes, MCP recall, and the Library view
      default to the active working set. Explicit status filters recover the
      full archive, including rejected proposals persisted as SUPERSEDED.
      Set-aside attempts/explorations and retired claims are hidden by default
      in the UI but remain one click away.
- [x] When several routes share one failure, the chair is told to condense the
      common obstruction and choose a cheap discriminating example,
      calculation, or genuinely different representation before another long
      near-duplicate attempt.
- [x] Clean-room comparison with
      [Rethlas](https://github.com/frenzymath/Rethlas): retained only high-level
      lessons about adaptive choice, failure synthesis, and proof-repair
      feedback. No code, prompts, schemas, or terminology were copied. We
      deliberately did not adopt append-everything recall or whole-theorem-only
      stopping; both conflict with the curated working set and independently
      reviewed scoped partial results.
- [x] Regression coverage includes the four-sentence/conclusion-only retry,
      reversible two-card condensation, promising-first ranking, and explicit
      archive search. Full verification: 243 tests, package typechecks, and
      production UI build.

## M15 — Single-controller Research Manager (2026-08-25)

The deterministic Conductor remains the runtime and safety boundary, but there
is only one intellectual controller. The Research Manager owns direction,
assessment, library organization, candidate choice, referee interpretation,
follow-up, and stopping.

- [x] Rename the model-facing Planner to **Research Manager** while retaining
      the old event actors and `plannerSpentTokens` field for replay
      compatibility.
- [x] Give the Manager an explicit recurrent current note. Every completed
      round writes `artifacts/manager-notes/W###.md`, emits
      `manager.noteRecorded`, and replaces the note supplied at the next
      decision. Earlier snapshots remain in state and on disk. Failed
      assessment records a clearly labeled fallback rather than inventing a
      mathematical opinion.
- [x] Make the strong Manager model explicit
      (`gpt-5.6-sol`, `max` by default) and give Manager decisions,
      assessments, and final composition project-scoped read-only
      `memory_search` / `memory_expand` access. W000 uses this same Manager and
      model choice, with the raw-source tools but no later project memory.
- [x] Count at most eight Solver, Explorer, or Reviewer assignments in a
      research round. Synthesizers are separate from those eight and remain
      bounded by token budget and global process concurrency.
- [x] Demote synthesis to `gpt-5.6-terra` by default, including legacy
      projects whose synthesis model was null, and strengthen its contract:
      assemble established ingredients rigorously; never invent a premise or
      bridge a gap.
- [x] Supply a prose-and-judgment example file to every Manager decision and
      completed-round assessment. Preserve four owner examples as canonical;
      mark all four inferred examples `DRAFT EXAMPLE — OWNER REVIEW`.
- [x] Add a dedicated **Manager** UI tab. The newest mathematical view is open;
      earlier views are collapsed and newest-first; fallback notes are visibly
      distinguished.
- [x] Add reducer recovery, prompt-recurrence, synthesis-capacity, fallback,
      file-persistence, and example-marking tests.
- [x] Full verification: 261 tests (schema 23, conductor 128, UI 89,
      codex-sim 21), all package typechecks, production UI build, diff
      whitespace check, and mathematical-text control-character scan.
- [ ] Owner review: approve, edit, or replace the four marked draft examples
      (conflicting findings; failed referee report; synthesis timing; honest
      stopping).

## M16 — Per-project model settings (2026-08-25)

- [x] Add a dedicated **Settings** tab for Research Manager, Solver, Explorer,
      Reviewer, and Synthesizer, with an editable model ID and the
      available reasoning-effort values. Known models are suggestions, not a
      closed list; blank means the Codex CLI account default. Compatibility of
      a particular model/effort pair is checked by Codex when it launches.
      W000 uses the Research Manager choice; the old `intake` setting is hidden
      replay compatibility.
- [x] Persist changes as `models.changed` events, preserve the hidden legacy
      `planner` key, and replay the effective configuration after restart.
- [x] Apply settings at process-launch time. Waiting assignments receive the
      new choice; already-running processes are unchanged. Record the actual
      worker model and effort in `tasks/T###/meta.json`.
- [x] Validate the complete active-role map at the HTTP boundary, make
      identical saves no-ops, and cover reducer, API/reload, UI normalization,
      and real simulated worker-launch behavior.
- [x] Full repository verification: 267 tests (schema 24, conductor 130,
      UI 92, codex-sim 21), all package typechecks, production UI build,
      diff whitespace check, and source control-character scan.

## M17 — Verbatim intake and editable W000 (2026-08-25)

- [x] Make project creation two-stage for the UI: persist the objective and
      background, upload every staged file, and only then launch a model. A
      failed upload leaves a recoverable CREATED draft instead of giving the
      Research Manager an incomplete submission.
- [x] Materialize the verbatim objective/background under `intake/`, retain
      project-local uploads under `sources/`, and maintain an S### catalog with
      size, SHA-256, short abstract, and conclusion-oriented excerpt. Once a
      source has entered W000 it cannot be silently overwritten or deleted.
- [x] Replace normalization, generated raw memories, and clarification UI with
      one minimally biased Research Manager reading. It writes
      `W000 · Current mathematical view` plus its short navigation abstract
      and source descriptions; compatibility output fields are explicitly
      empty.
- [x] Show W000 as a direct Markdown editor beside its rendered preview. Keep
      the original source catalog expandable beneath it; accepting W000 saves
      human edits and begins research. No intake chat was built.
- [x] Add Research-Manager-only `source_list` and bounded `source_open` tools;
      copy the raw bytes into the isolated W000 decision directory as a robust
      fallback. Long text and PDFs can be opened in chunks without placing the
      whole archive in ordinary recurrent context.
- [x] Fresh start copies raw objective/background, project-local documents,
      their short descriptions, W000, and research settings, but no later
      research or external filesystem mounts.
- [x] Put supplementary files in the main New Problem form and make W000 use
      the ordinary Research Manager model setting. Hide the obsolete separate
      Intake model setting while retaining its stored key for replay.
- [x] Full verification: 270 tests (schema 24, conductor 133, UI 92,
      codex-sim 21), all package typechecks, production UI build, diff
      whitespace check, and source control-character scan.

## M18 — Intake-summary discipline and project Web search (2026-08-25)

- [x] Make generated W000 abstracts one or two complete plain-text sentences:
      target at most 220 characters, hard limit 320, no headings, outlines, or
      line breaks. Source-catalog abstracts use one complete sentence under the
      same ceiling; qualifications and details belong in the excerpt or W000.
- [x] Enforce the hard limit in the model schema, confirmation API, and editable
      preview. Older overlong W000 text remains visible and editable, but must
      be shortened before research begins; regeneration uses the corrected
      prompt and schema rather than clipping prose mid-sentence.
- [x] Add a durable per-project Web search permission to Settings. The Research
      Manager grants search assignment by assignment; disabling the project
      permission strips it from work waiting to launch, without altering a
      worker already running. W000 remains offline to avoid sending raw owner
      submissions to search.
- [x] Persist the permission as `webSearch.changed`, expose the HTTP endpoint,
      and cover event replay, API validation/reload, allowed versus offline
      workers, and revocation at a gated launch.
- [x] Full repository verification: 275 tests (schema 26, conductor 136,
      UI 92, codex-sim 21), all package typechecks, production UI build, diff
      whitespace check, and source control-character scan.

## M19 — Central prompt architecture (2026-08-25)

- [x] Put all deliberate runtime model instructions under
      `packages/conductor/src/prompts/`: Research Manager contracts and
      context composition, worker roles and assignment composition, shared
      mathematical-writing guidance, voice examples, operational recovery
      turns, model-visible MCP tool descriptions, and manual diagnostic
      prompts.
- [x] Add a maintainer guide that maps every prompt layer to its direct code
      consumer, exact lifecycle condition, generated packet files, output
      schema, retry path, and deterministic enforcement boundary.
- [x] Keep shared Zod output schemas with `packages/schema` and project evidence
      with its deterministic builders; document why these are inputs to the
      effective prompt without being reusable behavioral prompt prose.
- [x] Add a regression test that detects production prompt literals outside
      the central directory and requires every prompt module to appear in the
      maintainer guide.
- [x] Full repository verification: 281 tests (schema 26, conductor 139,
      UI 95, codex-sim 21), all package typechecks, and production UI build.

## M20 — Revisable raw intake before research (2026-08-25)

- [x] Let the owner return from W000 to editable objective and background
      fields plus the supplementary-file list, then save and regenerate W000
      from the revised submission.
- [x] Record text revisions as `intake.rawUpdated` events and re-index file
      changes immediately. Changed bytes keep their conceptual S### reference
      while stale abstracts and excerpts are cleared before regeneration.
- [x] Mark W000 stale whenever the raw material changes after it was written;
      prevent confirmation until a later successful W000 call. A failed call
      preserves both the revised raw submission and the earlier W000 for retry.
- [x] Permit explicit replacement or removal of retained files only before
      confirmation, forbid source mutation during a W000 read, and restore the
      immutable retained-intake boundary when research begins.
- [x] Full repository verification: 285 tests (schema 27, conductor 140,
      UI 97, codex-sim 21), all package typechecks, and production UI build.

## M21 — Unified effective project settings (2026-08-26)

- [x] Make the reduced project configuration the single effective source for
      resource ceilings, autonomy, Web-search permission, and active-role
      model choices; retain the old top-level autonomy field and specialized
      setting events only for replay compatibility.
- [x] Add one atomic `project.settingsChanged` event and one GET/POST project
      settings endpoint. Keep the older autonomy, Web-search, and model routes
      as compatibility adapters that write through the unified engine method.
- [x] Make Settings initialize only from the loaded project snapshot and edit
      the token ceiling, maximum rounds, autonomy, Web search, and all five
      model roles in one form. New-project defaults now come from the shared
      schema rather than duplicated browser constants.
- [x] Reject token ceilings below recorded spend, round ceilings below rounds
      already used, and reductions of either ceiling during an open round.
      Preserve continuation extensions and fresh-start settings through replay.
- [x] Full repository verification: 287 tests (schema 27, conductor 141,
      UI 98, codex-sim 21), all package typechecks, and production UI build.

## M22 — Numbered continuation views (2026-08-26)

- [x] Replace the one-decision continuation directive with a durable revision
      of the Research Manager's recurrent mathematical view before any new
      round is planned. Number it at the preceding checkpoint (`W020.2`, then
      `.3` when continuing again without a new round).
- [x] Give the revision call the preceding view, immutable stopping report,
      complete owner comment, current record/library, and voice examples. Its
      output is mathematical reflection only; task selection remains the next
      ordinary Research Manager decision.
- [x] Preserve the owner's full continuation direction in every later
      next-move, completed-round assessment, and final-composition context until
      the next stopping report. Explicitly prevent prior categorical language
      from silently overriding requested orthogonal directions.
- [x] Let the owner declare that the continuation text is already the complete
      revised view. Record it directly as `human_edited` and skip the revision
      model call; otherwise use the configured Research Manager.
- [x] Show the pending numbered revision in ManagerView and explain in the
      Continue Research dialog that no new research round is selected first.
      Preserve replay compatibility by not inserting a retroactive revision
      when an older project already planned post-continuation work.
- [x] Full repository verification: 290 tests (schema 29, conductor 142,
      UI 98, codex-sim 21), all package typechecks, and production UI build.

## M23 — W000 regeneration-state recovery (2026-08-26)

- [x] Derive an active W000 reading from the shared decision history so the
      intake page remains locked after tab changes, reloads, or access from a
      second browser instead of relying only on one component's loading flag.
- [x] Keep the editable W000 visible with a clear progress notice while the
      Research Manager is rereading the original materials. Prevent raw-source
      changes, duplicate regenerations, and confirmation until that reading
      has finished.
- [x] On server restart, close an intake request that was interrupted before a
      response and preserve the preceding W000 for another regeneration. Do
      not turn this operational interruption into a question for the owner.
- [x] Full repository verification: 293 tests (schema 30, conductor 143,
      UI 99, codex-sim 21), all package typechecks, production UI build, and
      diff whitespace check.

## M24 — Mathematical W000 voice (2026-08-26)

- [x] Add the owner's W000-only avoid/prefer contrast for uncertain literature
      claims. Keep it separate from the later-round voice examples so its
      genus-specific subject matter does not become a template for the whole
      research process.
- [x] Use the contrast as a soft cue for mathematical voice and taste, not a
      procedure or list of required moves. Keep the surrounding guidance at a
      high level and leave relevance, uncertainty, and emphasis to the
      Manager's mathematical judgment.
- [x] Treat W000 as an editable mathematical interpretation rather than an
      evidentiary record of the reading process, while retaining clear labels
      for genuinely unverified claims.
- [x] Full repository verification: 294 tests (schema 30, conductor 144,
      UI 99, codex-sim 21), all package typechecks, production UI build, and
      diff whitespace check.

## M25 — Explicit Web-search settings state (2026-08-26)

- [x] Replace the ambiguous dynamic checkbox with two mutually exclusive
      `Allowed` / `Not allowed` choices. The radio matching the effective saved
      Boolean is visibly selected, so a stored `false` no longer looks like an
      unloaded control.
- [x] Keep the existing event-sourced project configuration as the sole value;
      this change does not silently alter any project's network permission or
      change the default for future projects.
- [x] Add saved-true and saved-false rendering regressions. Full repository
      verification passes: 296 tests (schema 30, conductor 144, UI 101,
      codex-sim 21), all package typechecks, production UI build, and diff
      whitespace check.

## M26 — Standalone TeX publication after a stopping report (2026-08-26)

- [x] Add an owner-triggered, post-terminal Research Manager reading tied to
      the exact stopping checkpoint. Keep the earlier terminal result immutable
      while allowing this final mathematical reading to uphold or change it.
- [x] Enforce the binary document decision in the structured schema: a
      `PROVED`/`DISPROVED` result is a preprint; an `UNCERTAIN` result is a
      research report with sound proofs, calculations, gaps, and next steps.
- [x] Give the Research Manager an indexed, on-demand copy of the complete
      mathematical record and original context. Draft title, abstract, and
      body as TeX fragments without delegating the final judgment.
- [x] Reject leaked project labels, product references, document boundaries,
      and file-I/O TeX. Supply a fixed article preamble and compile locally
      with Tectonic in explicit untrusted mode; preserve source and logs.
- [x] Make drafting, validation, compilation, failure, retry, and ready states
      event-sourced and restart-safe. A compilation-only retry reuses accepted
      TeX and spends no new model call.
- [x] Add the terminal Prepare paper control, persistent cross-tab status,
      prominent changed-result warning, retry controls, and confined PDF
      download endpoint.
- [x] Full repository verification: 308 tests (schema 32, conductor 151,
      UI 104, codex-sim 21), all package typechecks, production UI build, and
      diff whitespace check.

## M11 — Polish and hardening

- [ ] Empty/error states, toasts, loading skeletons throughout UI
- [x] Task Notes reads the nested structured memo, validates transport data,
      and tolerates the older whole-output API shape without crashing the
      inspector.
- [ ] Node-count stress fixture (20 waves) — layout + SSE perf budget
- [x] `README.md` quickstart, env vars, custom ports, and Tailscale binding
- [ ] README screenshots
- [ ] Optional: snapshot.json boot cache
- [x] Owner-requested standalone TeX/PDF publication (implemented as the M26
      final mathematical reading, not a mechanical export of `final.md`)

---

## Deviation log

(record deliberate divergences from DESIGN.md here, with date and reason)

- 2026-08-23 M1: event taxonomy extended beyond DESIGN §5 listing: `task.extended` and `autonomy.changed` (implied by the §12 API), `decision.proposed` carries planner `usage`, `claim.added` carries `dependsOn`, `candidate.frozen` carries `usedClaimIds` (needed by the evidence graph). Also `issue.resolved.disposition` ∈ repaired|rejected|stale.
- 2026-08-23 M1: schema exports TS source directly (no build step); consumers use vitest/tsx/Vite which all handle TS. `deriveGraph(state, view)` split into `deriveOpsGraph`/`deriveEvidenceGraph`.
- 2026-08-23 M2: mid-task budget enforcement uses a chars/4 estimator over streamed items (verified live: exact usage only arrives at `turn.completed`); DESIGN §6.5 amended accordingly. `codex exec resume` accepts no `-C`/`-s` (verified via --help), so resume runs set cwd via spawn opts and inherit the session sandbox.
- 2026-08-23 M5 (post-review): `crossexam.answered` gained a nullable `usage` field — a schema change, made deliberately, because cross-examination tokens were being spent and metered nowhere. The reducer folds it into worker spend so the budget bar tells the truth.
- 2026-08-24 M10 (found by the second real-quota run — a PROTOCOL-level gap, fixed): acceptance was **unreachable** for any candidate declaring an external dependency. Claims enter the ledger UNVERIFIED, the acceptance predicate requires every used claim VERIFIED, and **no Planner action promotes a claim** — so the run froze C001.v1, got two PASS reviews, failed acceptance on `K001 is UNVERIFIED`, froze C001.v2, got two more PASS reviews, and would have looped to budget exhaustion reporting UNCERTAIN for a correct proof. Fix: two independent PASS verdicts on a frozen version now promote that version's still-UNVERIFIED dependencies to VERIFIED, attributed to those reviews (PROTOCOL §6 "a check recorded by a different agent" — reviewers get the ledger extract and must FAIL when they cannot verify an import). REFUTED/SUPERSEDED claims are never resurrected. Documented in PROTOCOL §6; regression tests 15 and 15b. Separately, the planner contract now defines `usedClaimIds` as *external dependencies only* — the run had listed the candidate's own inline-proved theorem, which is what surfaced the gap.
- 2026-08-24 M10 (found by the first real-quota run, both fixed): (a) the Planner allocated **4,000 tokens** per task — less than a quarter of what one `codex exec` turn costs before the model reasons at all. Added `MIN_TASK_TOKENS = 60_000` as a validator rule, the realistic ranges and the per-project recommended default to the planner contract, and the recommended figure to `ledger.md`. (b) The mid-flight estimator counted only streamed OUTPUT, so a task with a 4,000-token budget ran to completion on 33,000 real input tokens — budget enforcement was far weaker than DESIGN §6.5 claimed. The estimate is now seeded with `CODEX_TURN_BASE_TOKENS` (16,000, measured) plus the packet size, so caps actually fire. Test 6 updated: it now uses the smallest *legal* budget and a genuinely runaway worker.
- 2026-08-24 M10: smoke asserts event-log replay equals the engine's final state, every recorded artifact exists on disk, and (when accepted) the candidate really carries two PASS reviews — the acceptance predicate is checked from the outside, not trusted.
- 2026-08-23 M3/M5: v1 simplifications inside the engine, all flagged in code: resolutions are recorded via `resolution.recorded` only (no `artifact.recorded` row); curation originally could not inject new cards (superseded by the narrow M14 librarian exception below); VERIFIED card admission is mechanically allowed only for COMPUTATION cards backed by a reproduced computation, everything else is downgraded to PROPOSED (human can upgrade); computation record/reproduce runs synchronously at task collection (blocks the loop ≤ ~2 min worst case); rejected cards get `memory.cardAdmitted{status:"SUPERSEDED"}`; task budget extension affects the live estimator cap via a dynamic read.
- 2026-08-24 M14: curation may create a small number of organizational,
  source-bearing cards solely to merge or sharpen existing research memory.
  These cards are always PROPOSED and cannot manufacture verification. Card
  retirement means a reversible SUPERSEDED status plus an archived file/event,
  never deletion. This narrowly replaces the earlier “worker proposals only”
  simplification because a librarian cannot merge records without writing the
  merged index entry.
- 2026-08-24 M13: computation snapshots now recreate the packet-relative
  `inputs/scratch/` shape and use separate pristine baseline/rerun copies. The
  prior flat `inputs/` layout made every `python3 scratch/...` command fail with
  exit 2 and empty stdout, so its universal “mismatch” signal was operationally
  false. Startup migration is intentionally narrow and preserves the broken
  baseline for audit.
- 2026-08-24 M13: claim status is no longer treated as a passive append-only
  catalog. Task source is explicit (legacy logs infer it from provenance),
  task dispositions are durable/revisable until set aside, and setting a route
  aside retires only its still-UNVERIFIED leads. This extends the original
  event model to make research debt finite without promoting claims by model
  opinion.
- 2026-08-24 M13: model-authored JSON is parsed through a TeX-aware integrity
  boundary before schema validation. This deliberately changes the old
  assumption that any syntactically legal JSON string is safe: legal escapes
  such as `\f` can silently alter mathematical content.
- 2026-08-25 M20: raw intake is no longer immutable immediately after the
  first W000 reading. Before confirmation, explicit owner revisions are
  event-sourced and require a fresh W000; confirmation remains the hard
  immutability boundary for retained source material.
- 2026-08-26 M26: standalone PDF generation is deliberately not a rendering of
  `final.md`. The Research Manager makes a fresh mathematical judgment and
  writes TeX; deterministic code validates and compiles it. This permits an
  earlier definite stopping assessment to become an honest research report
  without rewriting the historical terminal event.
- 2026-08-24 M13 (found by the real milestone run): adversarial questions for a
  referee are now stored as `reviewQuestions`, separate from admitted
  `obligations`. Obligations continue to block acceptance mechanically, while
  questions tell reviewers what to try to break. A PROVED/DISPROVED source may
  not be frozen with an admitted gap. This prevents a sound candidate from
  failing merely because its chair supplied a serious review brief.
- 2026-08-24 M13 (found by the first milestone attempt): current-round PASS/FAIL
  reviews may support claim updates when the reviewed candidate actually
  contains or depends on the claim. PASS can support VERIFIED and FAIL can
  support REFUTED; mismatched verdicts and unrelated reviewer evidence are
  rejected. This closes the claim ledger after real review instead of leaving
  reviewed claims permanently UNVERIFIED.
