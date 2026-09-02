# Inventio prompt architecture

This directory is the review boundary for deliberate model-facing
instructions in Inventio. If wording is intended to guide an initial reader,
research trajectory, Verifier, summary reader, legacy Research Manager, or
other model call, it belongs here even when it is used only for recovery or a
developer diagnostic.

The effective prompt is not one string. Inventio gives Codex a short message on
standard input, a deliberately composed working directory, a JSON output
schema, and—when authorized—MCP tool descriptions:

```text
Codex CLI's own system/tool context
  + short stdin prompt
  + generated AGENTS.md
  + generated mathematical question and bounded project context
  + --output-schema JSON Schema
  + descriptions of attached MCP tools
```

The Conductor never supplies its own system-role message. `codex/runner.ts`
starts `codex exec`, passes the short prompt on stdin, and asks Codex to use the
composed directory as its working directory. Repository- or user-level Codex
instructions are disabled or ignored; the generated directory is the intended
instruction boundary.

## Files in this directory

| File | What may be revised there | Direct consumers |
|---|---|---|
| `trajectories.ts` | All `trajectories-v2` contracts and composed context: initial W000 reading, long Solver/Explorer sessions, independent claim checks, small end-of-round view edits, and the stopping report | `engine/engine.ts` |
| `researchManager.ts` | Legacy W000, post-report W###.n revision, next-move, completed-round assessment, legacy statement-revision, stopping-report composition, and post-terminal TeX-publication contracts; all council-v1 Research Manager context-file composition | `engine/engine.ts` |
| `workers.ts` | Solver, Explorer, Reviewer, and Synthesizer contracts; generated worker `AGENTS.md`; generated `research-question.md` | `engine/packets.ts` |
| `shared.ts` | The ASD-STE100 mathematical-English contract and TeX-layout rules appended to every generated project `AGENTS.md` | `trajectories.ts`, `researchManager.ts`, `workers.ts` |
| `managerExamples.ts` | Owner-written and owner-review Research Manager judgment examples, including the W000 contrast; the shared English contract controls their output style | `researchManager.ts` |
| `operational.ts` | Short launch, resume, focused-follow-up, unusable-work, replacement-worker, structured-output repair, and automatic retry messages | `engine/engine.ts`, `codex/structured.ts` |
| `tools.ts` | Model-visible names, descriptions, and argument descriptions for the memory and original-source MCP tools | `memory/service.ts` |
| `diagnostics.ts` | Prompts used only by manual Codex diagnostic scripts, never by a research project | `scripts/probe-mcp-approval.ts` |

`researchManager.ts` also renders state-dependent context such as
`current-record.md` and `working-library.md`. Those renderers live beside the
contracts because their labels and warnings materially guide the Research
Manager. Pure evidence builders such as the deterministic round summary remain
under `engine/`: their output is project data, not a behavioral prompt.

## Shared mathematical English contract

Every project model call receives the same final section in its generated
`AGENTS.md`. `shared.ts` defines this section and appends it through
`withMathematicalWritingGuidance()`. It applies to W000, long trajectories,
claim comparison, independent checks, round summaries, legacy controller and
worker calls, stopping reports, and publication manuscripts. Recovery and
schema-repair turns reuse the same directory, so the contract remains active.

The contract explicitly tells each model to follow the full ASD-STE100
Simplified Technical English, Issue 9, standard for all model-authored English
prose. It assumes that the model knows the standard. Its local details are
examples that emphasize useful rules for mathematical writing. These examples
include short sentences, one main point per sentence, clear referents,
consistent terms, active voice when possible, simple verb forms, and gradual
presentation. Other examples concern semicolons, ambiguous “-ing” clauses,
idioms, unnecessary jargon, and unexplained abbreviations. The examples do not
replace or limit ASD-STE100. The official standard is available at
<https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf>.

Mathematical terms are permitted technical nouns and verbs. The contract does
not alter formulas, code, JSON keys, citations, proper names, or literal source
text. Mathematical rigor and self-containedness have priority over sentence
length. A model must preserve hypotheses, quantifiers, dependencies, and
logical distinctions. It must split or restructure difficult prose rather
than simplify the mathematics. The Research Manager examples supply judgment
and voice only. Their older sentence structure is not a style template.

## Long-trajectory calls (`trajectories-v2`)

New projects follow this path. `ProjectEngine.trajectoryLoop()` schedules the
work deterministically; there is no model next-move call and no model that
briefs the trajectories.

### W000 initial reading

- **When:** at first start, and whenever the owner explicitly regenerates W000
  after revising the raw objective, background, or uploaded files.
- **Short prompt:** `TRAJECTORY_INTAKE_PROMPT` in `trajectories.ts`.
- **Long contract:** the deliberately small `AGENTS.md` produced by
  `trajectoryIntakeFiles()`. This is separate from the legacy intake contract,
  so controller language and its voice examples cannot leak into v2.
- **Context:** `statement.md`, optional `context.md`, `raw-materials/index.md`,
  and fixed copies of every indexed original source.
- **Output:** the compatible `IntakeOutput` schema. Its W000 abstract and
  Markdown are substantive; legacy taxonomy/question fields stay empty.
- **Execution:** the configured summary-reader model, isolated from repository
  instructions. Web search follows the project setting; retained sources are
  also available through the project-scoped source tools.

### Solver and Explorer trajectories

- **When:** `planTrajectoryWave()` starts exactly the configured `N` Solvers
  and `M` Explorers for each research round.
- **Short prompt:** `TRAJECTORY_WORKER_PROMPT`, or
  `TRAJECTORY_RESTART_PROMPT` when continuing a durable Codex thread after a
  process restart.
- **Long contract/context:** `trajectoryWorkerFiles()` writes a role-specific
  `AGENTS.md`, the exact problem, current mathematical view, compact active
  facts and claims, original-source catalog, and any human direction belonging
  to that round. Earlier full write-ups, proofs, and original sources remain
  expandable through scoped MCP tools rather than being copied wholesale.
- **Output:** `TrajectoryOutput`: a readable write-up, short mathematical
  summary, conclusion about the original problem, and at most eight valuable
  self-contained statements with complete alleged proofs. An empty claim list
  is valid. Objective integrity checks reject damaged TeX, unmatched math
  delimiters, internal project IDs, and references to omitted surrounding
  work. `runStructured()` gives the same trajectory one repair turn; these
  checks make no judgment about mathematical direction or proof strategy.
- **Execution:** one isolated, workspace-write Codex process with `scratch/`, a
  two-hour default wall-clock allowance, configured model/effort, optional Web
  search, and project tools. The per-task token number is a planning target;
  exact usage arrives only when a turn ends, with a calibrated live estimate
  serving as an emergency ceiling. Sparse `mark_milestone` calls feed the
  graph; `flag_fact` may be used once only for a concrete contradiction.

### Statement comparison

- **When:** once after a completed round has new statements worth comparing
  and before their proofs are independently checked.
- **Short prompt:** `CLAIM_COMPARISON_PROMPT`.
- **Long contract/context:** `claimComparisonFiles()` supplies the exact
  problem, the current round's K IDs, and the all-status statement index. It
  explicitly forbids planning, proof assessment, editing, implication-based
  grouping, and thematic grouping.
- **Output:** `ClaimComparisonOutput`, containing only groups with identical
  hypotheses, scope, and conclusion. Runtime validation requires known K IDs,
  at least one current-round claim, and matching claim kind/relation metadata.
  Failure is a recoverable optimization loss and never blocks research.

### Independent claim checks

- **When:** after the round's statement comparison. At most one proof for an
  identical-statement group is active at a time; a failed proof allows the next
  distinct proof to be checked.
- **Short prompt:** `VERIFICATION_PROMPT`.
- **Long contract/context:** `verificationFiles()` supplies exactly the
  original problem and one self-contained claim/proof. Other project attempts
  are absent. A custom Codex filesystem profile permits reads and calculations
  only inside this check's packet; repository, project, and peer-check paths
  are not readable.
- **Output:** `VerificationOutput` with `PASS` or `FAIL`, a short reason, a
  complete report, and one finding category. At least the claim's frozen `W`
  passes among at most `V` checks are needed for fact promotion; settings
  changes never rewrite an existing claim's standard.
- **Recovery:** queued and running checks are durable. A server restart reruns
  an incomplete check, and invariant repair finishes any interrupted
  claim-to-fact transition without duplicating facts. A process-level verifier
  error is replaced by a fresh check and never counts as mathematical failure.
  A proof that cannot reach the pass threshold becomes `FAILED` for an
  incorrect step or substantive proof gap. A missing dependency or damaged
  presentation becomes `NEEDS_REVISION`; this does not claim that its statement
  is false (`REFUTED` is reserved for a disproof).

### End-of-round view revision

- **When:** once after all Solver/Explorer trajectories, statement comparison,
  and independent checks belonging to a round have settled.
- **Short prompt:** `SUMMARY_REVIEW_PROMPT`.
- **Long contract/context:** `summaryReviewFiles()` supplies the current view,
  concise trajectory returns and the now-stable active library.
- **Output:** `SummaryRevisionOutput`. The reader either returns the view
  unchanged or makes one small mathematical edit. Runtime checks reject
  clipped/outline-like abstracts, and every saved view receives its actual
  W-number heading. The reader cannot choose future work.

### Stopping report

- **When:** a verified fact proves or disproves the original problem, the
  configured round limit is reached, or the remaining allowance cannot support
  another round. Outstanding checks finish first.
- **Short prompt:** `TRAJECTORY_FINAL_PROMPT`.
- **Long contract/context:** `trajectoryFinalFiles()` supplies the exact
  problem, current view, deterministic stopping status, active facts with
  proofs, and separate warnings for facts under unresolved correction.
- **Output:** the compatible `FinalOutput`. The runtime prepends the
  authoritative result and has a deterministic fallback if composition fails.

## Legacy Research Manager calls (`council-v1`)

All calls below are used by replay-compatible `council-v1` projects and are
launched by `ProjectEngine.runResearchManagerCall()` in
`engine/engine.ts`. That method writes the listed files under
`projects/<slug>/decisions/<DEC###>/packet/`, selects the configured Research
Manager model unless noted otherwise, attaches read-only memory tools when
allowed, writes `output-schema.json`, and invokes `codex/structured.ts`.

### Legacy W000 initial reading

- **When:** a new project starts, or the owner revises the raw objective,
  background, or files and explicitly regenerates W000 before confirmation.
- **Short prompt:** `intakePrompt(false)` in `researchManager.ts`. W000 is
  intentionally offline; the boolean helper records the policy explicitly even
  though the production caller currently always passes `false`.
- **Long contract:** `INTAKE_CONTRACT`, written as packet `AGENTS.md` by
  `intakePacketFiles()`.
- **Context:** verbatim `statement.md`, optional `context.md`, the
  owner-supplied `w000-voice-example.md` contrast,
  `raw-materials/index.md`, and copies/extractions of every indexed intake
  source.
- **Output:** `IntakeOutput` from `@inventio/schema`, principally the editable
  W000 abstract/current view and one short description per original source.
- **Isolation:** `isolatedTask: true`; no workers exist and delegation is
  disabled. Source tools may open bounded ranges of the current submission,
  which the Conductor holds fixed for the duration of the call.

### Legacy clarification revision

- **When:** only when an older project still has generated clarification
  questions and the owner answers them. New W000 intake normally uses direct
  editing instead.
- **Short prompt:** `REVISION_PROMPT`.
- **Long contract:** `REVISION_CONTRACT`, written by
  `revisionPacketFiles()` as `AGENTS.md`.
- **Context:** original statement, previous normalized statement, and the
  owner's answers.
- **Output:** `IntakeRevision`.
- **Isolation:** standalone call with memory disabled; it uses the legacy
  intake model setting for replay compatibility.

### Revising the view after a stopping report

- **When:** immediately after the owner chooses Continue Research and before
  any new research round or next-move decision. If the owner supplies the
  complete revised view directly, the call is skipped and that text is
  recorded with `human_edited` authorship.
- **Short prompt:** `CONTINUATION_REVISION_PROMPT`.
- **Long contract:** `CONTINUATION_REVISION_CONTRACT`, written by
  `continuationRevisionPacketFiles()` as `AGENTS.md`.
- **Context:** the previous recurrent view, immutable stopping report, complete
  continuation comment, confirmed problem, current record and working library,
  voice examples, and compact intake context.
- **Output:** `ContinuationRevisionOutput`: the revised mathematical view and
  its one- or two-sentence navigation abstract.
- **Persistence:** the note is numbered from the last completed round, for
  example `W020.2`; repeated continuations without a new round become `.3`,
  `.4`, and so on. The full owner comment remains separately present as
  `continuation-direction.md` in later next-move, assessment, and final calls
  until another stopping report is reached.
- **Recovery:** a stopped process leaves the revision pending for replay. A
  failed completed call records a visibly marked fallback containing the
  owner's direction and preceding view, then continues without asking the
  owner an operational question.

### Choosing the next mathematical step

- **When:** the project is active, not paused/blocked/gated/terminal, no round
  is open, and no completed round still needs assessment.
- **Short prompt:** `DECISION_PROMPT`.
- **Long contract:** `NEXT_MOVE_CONTRACT`, written by
  `decisionPacketFiles()` as `AGENTS.md`.
- **Context:** confirmed problem, current Research Manager view, current
  mathematical record, working library, voice examples, newest round/report
  material, pending owner guidance, the full active continuation direction,
  and the active candidate when one exists.
- **Output:** `ActionEnvelope` from `@inventio/schema`.
- **Validation/retry:** `engine/validate.ts` checks the proposed action. A
  failed process gets `nextMoveCallRetryNote()`; an illegal action gets
  `rejectedNextMoveNote()`. At most three attempts are made before an
  operational retry question is shown to the owner. The mathematical record is
  unchanged across these retries.

### Assessing a completed round

- **When:** every assignment in a research round has completed, failed, or
  stopped, including recovery of a closed round whose assessment was
  interrupted.
- **Short prompt:** `CURATION_PROMPT`.
- **Long contract:** `CURATION_CONTRACT`, written by
  `curationPacketFiles()` as `AGENTS.md`.
- **Context:** deterministic round findings, complete structured reports,
  previous short role notes, current mathematical record and library, previous
  Research Manager view, voice examples, the previous project summary, and the
  full active continuation direction when the run resumed from a report.
- **Output:** `CurationOutput`: a rewritten current view, mathematical account
  of the round, a decision for every assignment, bounded claim/library edits,
  short role notes, and a compact project summary.
- **Validation/retry:** deterministic assessment/library/claim checks run in
  `engine.ts` and `engine/validate.ts`. One incomplete result receives
  `curationRetryNote()`; a second failure records a neutral fallback and never
  asks the owner for mathematical input.

### Final report

- **When:** the deterministic acceptance predicate succeeds, or the Research
  Manager chooses an honest `UNCERTAIN` termination, while enough budget
  remains for composition.
- **Short prompt:** `FINAL_PROMPT`.
- **Long contract:** `FINAL_CONTRACT`, written by `finalPacketFiles()` as
  `AGENTS.md`.
- **Context:** confirmed problem, current record and view, project summary,
  verified partial-results section, active continuation direction, and accepted
  candidate when applicable.
- **Output:** `FinalOutput.finalMarkdown`. The Conductor—not the model—prepends
  the authoritative `RESULT:` line. If composition cannot run, deterministic
  fallback prose is used.

### Standalone TeX publication

- **When:** only after a project has reached a stopping report and the owner
  explicitly chooses Prepare paper. It is not part of automatic termination.
- **Short prompt:** `PUBLICATION_PROMPT`.
- **Long contract:** `PUBLICATION_CONTRACT`, written by
  `publicationPacketFiles()` as `AGENTS.md`.
- **Context:** the exact problem and stopping report, current Manager view,
  current record and library, compact project summary, every full mathematical
  write-up copied under `research-record/`, computation status, and the
  original intake sources. The Manager may open these files on demand and may
  use Web search only when the project's saved setting permits it.
- **Output:** `PublicationOutput`, a binary choice. A `preprint` must carry
  a definite PROVED or DISPROVED result; a `research_report` must carry
  UNCERTAIN. The Manager may change the earlier stopping assessment after its
  final mathematical reading.
- **Persistence and compilation:** the Conductor rejects file-I/O TeX,
  surviving internal labels, and references to Inventio; supplies a fixed
  article preamble; and writes `publications/P###/manuscript.tex`. This ends the
  model-backed drafting stage. Only the owner's separate **Generate PDF**
  action invokes local Tectonic in untrusted mode. It records the compiler log
  and publishes the PDF only after checking the PDF header; a retry always
  reuses the saved TeX and spends no further Manager tokens.
- **Isolation:** no workers or delegation. This is the Research Manager's own
  final deduction and drafting pass.

## Worker calls

`engine/packets.ts` calls the two renderers in `workers.ts` once for every
queued assignment that actually dispatches:

- `renderAgentsMd()` writes `tasks/<T###>/packet/AGENTS.md`. It combines the
  selected `ROLE_CONTRACTS` entry with independence, source, memory, Web-search,
  computation, mathematical-writing, and structured-return rules.
- `renderResearchQuestionMd()` writes
  `tasks/<T###>/packet/research-question.md`. It contains the Research
  Manager's exact `briefMarkdown`, approach, direction, budget, stopping
  condition, and reviewer-specific candidate scope/questions.
- `engine/packets.ts` adds only the granted context: `problem.md`, optional
  intake context and role notes, selected write-ups/library notes/source
  collections, relevant claims, and `scratch/` for computation assignments.
- `engine/engine.ts` then sends `workerLaunchPrompt()` through stdin. On crash
  recovery it uses `workerRestartPrompt()` instead.

Worker role selection and special visibility conditions:

| Role | Contract | Important packet condition |
|---|---|---|
| Solver | `ROLE_CONTRACTS.solver` | One bounded proof/counterexample direction; selected earlier work remains an untrusted lead |
| Explorer | `ROLE_CONTRACTS.explorer` | Neighborhood, examples, equivalent forms, computations, and obstructions rather than forced proof |
| Reviewer | `ROLE_CONTRACTS.reviewer` | Exactly one frozen candidate plus relevant verified dependencies/sources; no peer review or unrelated attempt history |
| Synthesizer | `ROLE_CONTRACTS.synthesizer` | Selected complete ingredients for rigorous assembly; it may not invent a missing bridge |

After a schema-valid but non-mathematical refusal/placeholder,
`unusableWorkCorrectionPrompt()` gives the same thread one short correction.
If it still fails, `freshWorkerReplacementPrompt()` starts an independent
thread in the same directory. Neither path changes the assignment or asks the
owner to intervene.

`focusedFollowUpPrompt()` is different: it is used only when the Research
Manager explicitly chooses `cross_examine` for a completed task. It resumes
that worker's original thread and requests one bounded answer in the
`CrossExamAnswer` schema.

## Shared structured-output recovery

`codex/structured.ts` wraps every Research Manager and worker call:

- `PROCESS_FAILURE_RESUME_PROMPT` is used once when a process fails after a
  thread ID exists;
- `structuredOutputRepairPrompt(errors)` is used once when the final message
  is not JSON or fails its Zod schema.

If no thread was created, the original call is retried fresh. Budget, timeout,
or explicit kill interruptions are never prompt-repaired; they return partial
status for deterministic handling.

## MCP tool descriptions

`MODEL_TOOL_DEFINITIONS` is returned by `memory/service.ts` on MCP
`tools/list` requests. Legacy projects receive their card/source tools. A
`trajectories-v2` Solver or Explorer additionally receives tools to search/open
active claims and facts, search/open earlier write-ups, record a milestone, and
raise one concrete fact correction. It may list/open original intake sources
as well. Tool descriptions guide use but do not grant authority: bearer scope,
role checks, project workflow, active status, one-correction limits, and file
confinement are enforced in `memory/service.ts` and `engine.ts`.

`codex/runner.ts` supplies this local authenticated server through strict
generated configuration. It marks the server required, passes the exact
`MODEL_TOOL_NAMES` allow-list, and uses Codex's
`default_tools_approval_mode="approve"` so noninteractive research sessions can
actually call the tools without a human prompt. This approval does not widen
authority: the short-lived bearer token and the checks above still decide what
each call may read or change. `scripts/probe-mcp-approval.ts` exercises this
exact production path against a live local server.

## Model-visible contracts outside this directory

Two categories intentionally remain elsewhere:

1. **Output schemas** live in `packages/schema/src/actions.ts`,
   `worker-output.ts`, and related schema files because they are shared
   cross-boundary types. `codex/structured.ts` converts them to JSON Schema and
   passes them through `--output-schema`. Field descriptions in those schemas
   are therefore model-visible; changing them is a schema/API change, not just
   prompt prose.
2. **Project evidence and owner text**—problem statements, write-ups, source
   documents, state-derived records, and deterministic round findings—remain
   with their data builders. They are inputs to a prompt, but they are not
   reusable behavioral instructions.

The Codex CLI's own system prompt and tool policy are external to Inventio and
cannot be revised here.

## Safe revision checklist

When changing a prompt:

1. Identify every lifecycle call above that receives the edited export.
2. Preserve statement fidelity, worker independence, frozen-review scope,
   claim-status distinctions, and the deterministic acceptance boundary from
   `PROTOCOL.md`.
3. Keep mathematical prose academic. Internal JSON field names belong only in
   explicitly marked response-format sections.
   All model-authored English must retain the shared ASD-STE100 contract.
   Do not duplicate or weaken that contract in an individual role prompt.
4. Remember that prompt strings are sent through JSON-bearing output. Examples
   of TeX commands must show doubled backslashes where the model is being told
   how to encode JSON, so `\\frac` never becomes a form-feed escape.
5. Do not imply that prompt wording enforces a security, budget, visibility,
   or acceptance rule; those rules must remain code.
6. Update this map when adding a new model call or prompt export.
7. Run `npm test`, `npm run typecheck`, `npm run build`, and
   `git diff --check`. Tests use `packages/codex-sim`; do not run the live
   smoke test merely to review prompt prose.
