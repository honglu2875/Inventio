# Inventio prompt architecture

This directory is the review boundary for deliberate model-facing
instructions in the Conductor. If wording is intended to guide a Research
Manager or worker, it belongs here even when the instruction is only used for
an error recovery turn or a developer diagnostic.

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
| `researchManager.ts` | W000, next-move, completed-round assessment, legacy statement-revision, and final-report contracts; all Research Manager context-file composition | `engine/engine.ts` |
| `workers.ts` | Solver, Explorer, Reviewer, and Synthesizer contracts; generated worker `AGENTS.md`; generated `research-question.md` | `engine/packets.ts` |
| `shared.ts` | Mathematical-writing rules inserted into both Research Manager and worker contracts | `researchManager.ts`, `workers.ts` |
| `managerExamples.ts` | Owner-written and owner-review Research Manager voice examples | `researchManager.ts` |
| `operational.ts` | Short launch, resume, focused-follow-up, unusable-work, replacement-worker, structured-output repair, and automatic retry messages | `engine/engine.ts`, `codex/structured.ts` |
| `tools.ts` | Model-visible names, descriptions, and argument descriptions for the memory and original-source MCP tools | `memory/service.ts` |
| `diagnostics.ts` | Prompts used only by manual Codex diagnostic scripts, never by a research project | `scripts/probe-mcp-approval.ts` |

`researchManager.ts` also renders state-dependent context such as
`current-record.md` and `working-library.md`. Those renderers live beside the
contracts because their labels and warnings materially guide the Research
Manager. Pure evidence builders such as the deterministic round summary remain
under `engine/`: their output is project data, not a behavioral prompt.

## Research Manager calls

All calls below are launched by `ProjectEngine.runResearchManagerCall()` in
`engine/engine.ts`. That method writes the listed files under
`projects/<slug>/decisions/<DEC###>/packet/`, selects the configured Research
Manager model unless noted otherwise, attaches read-only memory tools when
allowed, writes `output-schema.json`, and invokes `codex/structured.ts`.

### W000 initial reading

- **When:** a new project starts, or the owner explicitly regenerates W000
  before confirming the problem.
- **Short prompt:** `intakePrompt(false)` in `researchManager.ts`. W000 is
  intentionally offline; the boolean helper records the policy explicitly even
  though the production caller currently always passes `false`.
- **Long contract:** `INTAKE_CONTRACT`, written as packet `AGENTS.md` by
  `intakePacketFiles()`.
- **Context:** verbatim `statement.md`, optional `context.md`,
  `raw-materials/index.md`, and copies/extractions of every indexed intake
  source.
- **Output:** `IntakeOutput` from `@inventio/schema`, principally the editable
  W000 abstract/current view and one short description per original source.
- **Isolation:** `isolatedTask: true`; no workers exist and delegation is
  disabled. Source tools may open bounded ranges of the immutable submission.

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

### Choosing the next mathematical step

- **When:** the project is active, not paused/blocked/gated/terminal, no round
  is open, and no completed round still needs assessment.
- **Short prompt:** `DECISION_PROMPT`.
- **Long contract:** `NEXT_MOVE_CONTRACT`, written by
  `decisionPacketFiles()` as `AGENTS.md`.
- **Context:** confirmed problem, current Research Manager view, current
  mathematical record, working library, voice examples, newest round/report
  material, owner guidance, and the active candidate when one exists.
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
  Research Manager view, voice examples, and the previous project summary.
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
  verified partial-results section, and accepted candidate when applicable.
- **Output:** `FinalOutput.finalMarkdown`. The Conductor—not the model—prepends
  the authoritative `RESULT:` line. If composition cannot run, deterministic
  fallback prose is used.

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

`MODEL_TOOL_DEFINITIONS` is returned by `memory/service.ts` on every MCP
`tools/list` request. The descriptions tell models how to search/expand the
research library and how to list/open original intake sources. They describe
access but do not enforce it: bearer scope, reviewer restrictions,
quarantine, and Research-Manager-only source access remain deterministic code
in `memory/service.ts`.

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
4. Remember that prompt strings are sent through JSON-bearing output. Examples
   of TeX commands must show doubled backslashes where the model is being told
   how to encode JSON, so `\\frac` never becomes a form-feed escape.
5. Do not imply that prompt wording enforces a security, budget, visibility,
   or acceptance rule; those rules must remain code.
6. Update this map when adding a new model call or prompt export.
7. Run `npm test`, `npm run typecheck`, `npm run build`, and
   `git diff --check`. Tests use `packages/codex-sim`; do not run the live
   smoke test merely to review prompt prose.
