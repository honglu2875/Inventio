# Long-trajectory research workflow

The proposed replacement is [SESSION-DESIGN.md](SESSION-DESIGN.md): one persistent
Solver and one persistent Explorer, without rounds or a backward-compatibility
requirement. This document continues to describe the current implementation.

This document specifies the second-generation Inventio workflow. It is kept
separate from the legacy council protocol so projects created by earlier
versions can still be replayed without reinterpretation.

## Compatibility boundary

- Every project records a workflow version. Missing workflow metadata means
  the legacy `council-v1` workflow.
- New projects use `trajectories-v2`. Legacy projects are view-only archives: no
  startup recovery writes, task resumption, settings changes, or new publication
  calls. Their original intake may be copied into a separate new project.
- Existing event types and reducer meanings remain append-only. The new
  workflow adds events and optional fields; it does not rewrite old logs.
- The deterministic conductor owns scheduling, persistence, budgets, retries,
  and state transitions. It does not make mathematical choices.

## Research loop

1. Intake preserves the raw materials and produces an editable initial
   mathematical view (`W000`).
2. Each research round starts `N` independent Solvers and `M` independent
   Explorers from that common view, the current facts and claims, and any
   user guidance. Defaults are `N=2`, `M=2`, for at most five rounds. Every
   trajectory has a distinct stable task ID before any process starts.
3. A Solver works directly on the stated problem. An Explorer develops useful
   nearby mathematics, examples, special cases, obstructions, or methods.
   Both receive long wall-clock budgets, web access when the project permits
   it, a writable computation directory, and tools for inspecting the record.
   Project tools use a short-lived task token and a fixed allow-list; they are
   approved noninteractively because the server itself enforces project, role,
   status, and write limits.
4. During a trajectory a worker may record a small number of mathematical
   milestones. At the end it returns a write-up and a short, parseable list of
   genuinely useful claims. Every claim must contain a self-contained statement
   and a complete alleged proof. Assumptions, vague ideas, and repetitive
   instance-by-instance observations are not claims. Before persistence, the
   structured return is checked for damaged TeX, unmatched mathematical
   delimiters, internal project references, and references to omitted
   surrounding work. An invalid return receives one repair turn in the same
   trajectory; these checks do not judge its mathematical method or conclusion.
5. Once a round's claims are present, one narrow comparison identifies
   statements with the same hypotheses, scope, and conclusion. It cannot edit
   claims, assess proofs, or choose research directions. Equivalent claims are
   linked transitively while their distinct proofs remain inspectable. Only one
   proof in an equivalence class is checked at a time; if it fails, the next
   proof may be checked, and if one succeeds the remaining versions point to
   the resulting fact. The same pass reads complete statements on demand and
   records explicit incompatible pairs with reasons. It does not determine
   which is true. An unavailable comparison stops the run UNCERTAIN; an owner
   continuation retries it once. Older saved rounds have no inferred conflict
   coverage.
6. Each selected claim is checked independently by up to `V` Verifiers. It
   becomes a fact after at least `W` passes (`1 <= W <= V`). Checks run
   concurrently with one another. A claim that can no longer reach `W` passes
   is `FAILED` when a mathematical error or proof gap was found. Missing
   dependencies or damaged/undefined presentation instead produce
   `NEEDS_REVISION`, which is retained as an unresolved write-up rather than a
   mathematical refutation. `REFUTED` remains reserved for a concrete disproof
   of the statement.
7. After the round's checks have reached durable outcomes, a strong summary
   reader may make a small revision to
   `W000` only when the new work materially changes the mathematical picture.
   This is editorial maintenance, not a planning or management layer.
8. The next round starts after its research trajectories, statement comparison,
   checks, and summary review finish. Thus every saved round view describes a
   fixed review state. After the final round, the project result is written from
   the same settled record.

## Mathematical English

Every generated project `AGENTS.md` includes short guidance for clear academic
prose: stable terminology, precise hypotheses and quantifiers, defined
notation, and complete derivations. Mathematical completeness takes priority
over brevity. There is no obligation to follow a full controlled-language
standard from memory or satisfy sentence-length quotas.

Verifier reports document the decisive mathematical checks. Odd-numbered
verifiers emphasize logical and dependency checks; even-numbered verifiers
independently derive the decisive step. All still receive and assess the full
proof. A failed command is not computational evidence, and executing code
successfully does not establish that it models the intended mathematics.

## Process recovery

- Exactly one Inventio process may own a project's event log. A per-project
  process lease prevents a hot-reload predecessor and its replacement from
  assigning the same sequence numbers. Every append also checks that no
  outside writer changed the file. Locks left by a crashed PID are reclaimed;
  a failed server startup closes all leases it already acquired.
- The historical agreeing-terminal fork that exposed this requirement is
  recoverable: startup selects the replacement process's contiguous tail only
  when both branches report the same result and report path, and retains the
  original bytes beside the repaired log. Any divergent or non-terminal fork
  remains a loud error rather than a guessed merge.
- Stopping or reloading the Inventio server is not a research outcome. An
  active Solver or Explorer remains `running`, its latest partial draft and
  cumulative spend are saved, and the next process resumes the same Codex
  thread. A deliberate task interrupt, wall-clock timeout, or token ceiling is
  still recorded as an interrupted trajectory.
- If the process dies between writing task metadata and appending its
  accounting event, startup repairs the cumulative charge before resuming. If
  a valid structured return reached disk before its completion event, startup
  accepts that return instead of repeating the research.
- Partial structured drafts remain explicitly unchecked. Round summaries and
  the task inspector show their mathematical prose, rather than raw JSON, but
  never turn them into claims or facts.

## Facts and corrections

Claims and facts are plain Markdown files and remain retrievable through tools.
A worker that finds a concrete contradiction or disproof may flag one fact once
with a short mathematical reason. The flag creates a new correction claim and
uses the same independent verification process. A passing correction retracts
the fact. Failure of a correction's proof does not refute its statement and
keeps the warning visible. Only explicit refutation of all outstanding
corrections clears that warning. Earlier suspicion-cleared events retain
their original meaning when replayed.

New claims may record dependsOnFactIds as provenance; those IDs are validated
and persisted in the claim's existing dependsOn field. The isolated proof
must still supply its own mathematical dependencies. A shared eligibility
calculation follows fact dependencies and equivalent replacements, checks the
source proof's current status, and propagates unresolved conflicts, suspicion,
retraction, missing premises and cycles. An affected active fact is displayed
as UNSETTLED without rewriting its saved acceptance status. It cannot supply
a settled premise or decisive stopping result. Unknown historical dependencies
are never inferred during replay.

Conflicts are append-only claim.conflictRecorded and claim.conflictResolved
events. An explicit owner resolution requires a mathematical reason. A
refuted claim or retracted fact can resolve its associated conflict, but an
incomplete or failed proof cannot. Independent, unaffected proofs remain
usable. Saved stopping reports are historical records, not rewritten verdicts.

## Computational support

New verification requests freeze an evidence requirement. Verifiers declare
a hand derivation, a computation, or both and name their supporting shell
commands. The conductor checks those declarations against the parent-owned
CLI archive, after it finishes writing. Bounded execution records preserve
command outcomes, output hashes and excerpts; they do not rerun untrusted
code. Computational support requires a complete capture and successful
matching executions. An unsupported PASS becomes FAIL/MISSING_DEPENDENCY,
while the original model output remains on disk and its declared verdict is
retained in verification.evidenceRecorded. A hand derivation may survive a
failed exploratory command. Successful execution does not certify the
mathematics implemented by the code.

Recovery uses the saved output and authentic execution record under the same
frozen requirement. Old completed verifications are not re-audited or changed;
missing historical evidence remains unknown. Evidence summaries and manifests
are available through HTTP, the verification view, HTML export and publication
packets. Export and HTTP reading check manifest hashes.

## Roles

- **Solver:** sustained, self-directed work on the exact problem.
- **Explorer:** sustained, self-directed work on relevant surrounding
  mathematics or illuminating special cases.
- **Verifier:** independent check of one self-contained statement and proof.
- **Summary reader:** one small end-of-round edit of the initial mathematical
  view, or no edit.
- **Conductor:** deterministic execution and storage only.

There is no Research Manager, candidate hierarchy, synthesis gate, or review
council in `trajectories-v2`.

## Presentation

The existing project, graph, work, and library views remain. For a v2 project:

- the project graph shows rounds, long trajectories, and their milestones;
- the library is organized as Facts, Active claims (including claims needing a
  revised write-up), Failed claims, Write-ups, and Verifications;
- the Summary view shows the current `W000` and its short revision history;
- legacy manager, candidate, and council terminology is not shown.
