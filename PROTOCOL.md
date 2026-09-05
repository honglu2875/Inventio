# Inventio protocol — the constitution

> **Compatibility document.** This protocol governs projects whose saved
> workflow is `council-v1`. New projects use the simpler long-trajectory
> workflow specified in `TRAJECTORY-DESIGN.md`; the shared requirements of
> statement fidelity, honest uncertainty, and independent checking still
> apply there through its own event model.
> Council execution is retired. These historical semantics explain saved runs;
> current support is view-only replay under `packages/conductor/src/legacy/`.
> New execution follows `TRAJECTORY-DESIGN.md`.

This document is the epistemic constitution of Inventio, a system for
attacking difficult mathematics with a council of independent model agents.
It defines what counts as evidence, how roles may interact, and when a result
may be called proved. It deliberately says nothing about processes, ports, or
file formats; the runtime that enforces this constitution is specified in
`DESIGN.md`.

Two kinds of actors implement this protocol:

- **The Conductor** — deterministic runtime code. It owns all shared state,
  composes every agent's inputs, enforces seals, budgets, versioning,
  admission rules, and the acceptance predicate. Rules written as "the
  Conductor MUST" are implemented as code, not as instructions to a model.
- **Model agents** — the Research Manager and the workers (Solver, Explorer, Reviewer,
  Synthesizer). Rules written as role contracts are delivered to each agent
  verbatim inside its task packet. Agents never see this whole document.

Agreement is never a substitute for a proof.

## 1. Core invariants

1. **Statement fidelity.** The exact statement, hypotheses, domain, and
   requested output form live in `problem.md`, confirmed by the human at
   intake and immutable afterwards. The owner's original wording, background,
   and uploaded documents are retained verbatim and remain distinguishable
   from every model interpretation. No agent or process may silently
   strengthen, weaken, or reinterpret them. If a material ambiguity is found
   later, it becomes a Question to the human, not a unilateral choice.
2. **Three labels.** Every result is `PROVED`, `DISPROVED`, or `UNCERTAIN`.
   A familiar-sounding theorem, numerical evidence, or agent consensus is
   not a proof. `UNCERTAIN` is a valid and often correct outcome.
3. **Ledgered dependencies.** Every nontrivial claim used by a candidate
   proof is either proved inside the candidate or entered in the claims
   ledger with precise provenance. Nothing is accepted on the strength of a
   summary.
4. **Independence by construction.** Parallel attempts stay independent
   until they are written. Workers in the same wave cannot see each other's
   work — not because they are told not to look, but because the Conductor
   composes each packet and the sealed material is not in it.
5. **Frozen review targets.** Reviewers audit a complete frozen candidate
   version, never a favorable summary. The author of a candidate is never
   its only reviewer, and reviewers of the same version do not see each
   other's verdicts before submitting their own.
6. **No verdict by vote.** A single valid critical objection blocks
   acceptance regardless of how many PASS verdicts exist. Confidence
   language and agent identity carry no evidentiary weight.
7. **Failure is evidence.** Failed attempts, refuted claims, and
   counterexamples are preserved and remain searchable. They constrain later
   work and prevent repeated mistakes.
8. **Known-status check.** For a statement believed to be an open problem or
   a known theorem, that context is recorded, but submitted mathematics is
   still assessed on its own merits. A claimed breakthrough is never
   presented as established without a fully checkable argument passing the
   acceptance predicate.
9. **Single writer.** Only the Conductor writes shared state: ledgers,
   candidate versions, curated memory, resolutions, phase, and the final
   report. Model agents return content; the Conductor materializes it.
10. **Human primacy.** The human owner can pause, steer, intervene in
    ledgers (with recorded human provenance), answer or dismiss Questions,
    and terminate at any time. Human interventions are events like any
    other: visible, attributed, and permanent.

## 2. Epistemic labels and the acceptance predicate

A candidate version may be **accepted** (yielding `PROVED` or `DISPROVED`)
only when all of the following hold. The Conductor evaluates this predicate
mechanically; no agent can assert it:

- the candidate has an empty obligation list;
- no `CRITICAL` or `MAJOR` issue against this exact version is unresolved;
- every external dependency recorded in the claims ledger and used by the
  candidate is `VERIFIED` with proof or precise provenance;
- two independent reviews of this exact frozen version conclude `PASS`;
- every computation the conclusion depends on has a recorded, re-executed,
  hash-matching reproduction; and
- a final consistency check finds no mismatch between the candidate's
  statement and `problem.md`.

`DISPROVED` for a conjecture requires a fully verified counterexample held to
the same two-review bar; it never means merely "a proof attempt failed."

If the budget is exhausted, progress repeats, required information is
unavailable, or no candidate meets the bar, the honest terminal result is
`UNCERTAIN` with preserved partial results, decisive gaps, and recommended
next work.

## 3. Roles

### 3.1 Research Manager

The Research Manager is the single intellectual controller of a project. It
decides which mathematical directions matter, which earlier work is worth
using, when an exact follow-up is preferable to another broad attempt, when a
candidate is ready for independent referees, and when a direction should be
left behind. The deterministic Conductor executes and validates these choices;
it is not a second research opinion.

The Manager's process calls are short-lived, but its mathematical context is
recurrent. After every completed round it rewrites a free-form current note in
its own voice: where the problem stands, the genuine gap or opportunity, its
present intuition, and the most worthwhile next direction. The new note
replaces the working view supplied at the next decision, while every earlier
version remains visible in chronological history. It is neither a transcript
nor a fixed checklist. It should compress old rounds, preserve only distinctions
that still matter, and change its mind explicitly when new mathematics warrants
it.

At a decision, the Manager receives the confirmed problem, its current note,
short descriptions of the active research library, the latest findings,
candidate and referee status, resource accounting, and owner guidance. It may
search the research library and expand a few older notes on demand. It then
returns exactly one structured next action. The Conductor checks references,
budgets, independence, and acceptance conditions before execution. Invalid
actions are retried automatically; operational failure is never turned into a
vague mathematical question for the owner.

After a round, the same Manager interprets the reports, rewrites its current
note, records how each attempt should be used, revises the short project
summary, and reorganizes the working library. It also drafts the final report
from checked evidence. Its first act is W000: one minimally instructed reading
of the complete raw submission in ordinary mathematical language. W000 states
the Manager's current understanding and gives each original source a short
catalog description; it does not begin solving, plan assignments, manufacture
an intake taxonomy, or ask a questionnaire. The human edits W000 directly and
accepts it before research begins. The raw submission remains available even
when W000 is later revised.

The Research Manager must rank assignments by consequence, uncertainty,
expected information gain, cost, and genuine methodological novelty. It must
take a reasoned mathematical position rather than merely aggregate reports,
name the uncertainty each assignment is intended to reduce, choose genuinely
different directions for parallel attempts, and avoid spending capacity merely
because budget remains.

### 3.2 Solver

A Solver receives the exact problem, a role capsule, one concrete
directional assignment, optional prior attempts clearly marked untrusted,
and optional granted sources with provenance. It produces one attempt
artifact whose first line after metadata is exactly one of
`CONCLUSION: PROVED`, `CONCLUSION: DISPROVED`, or `CONCLUSION: UNCERTAIN`.

The body must define nonstandard notation, state every imported lemma
precisely, give a dependency-ordered step-by-step argument, check every
hypothesis and edge case, actively search for counterexamples to its own
argument, and end with a self-audit naming the least certain step. A
disproof must verify its counterexample against every hypothesis. An
uncertain attempt ends with concrete remaining obligations, never a bluffed
conclusion. Treat all prior summaries as untrusted leads. Never fill a gap
with plausibility.

### 3.3 Explorer

An Explorer receives the exact problem and a capsule listing directions
already tried and their one-line outcomes. It investigates the mathematical
neighborhood rather than forcing a proof: small and extremal cases, relaxed
hypotheses, candidate counterexamples, equivalent formulations, invariants,
reproducible computations, and obstructions. Every entry in its artifact
carries (1) a precise statement, (2) a proof, derivation, computation, or an
explicit `UNVERIFIED` label, (3) relevance to the main problem, and (4) a
reproducibility note for any computation. Experimental evidence is never
promoted to a universal theorem.

### 3.4 Reviewer

A Reviewer receives only the exact problem, one frozen candidate version,
the claim ledger, and cited sources needed to check it — never another
review, council sentiment, author identity, or unrelated attempts. It
attempts to falsify the candidate: every implication, quantifier, sign,
boundary case, equality case, hidden regularity or finiteness assumption,
imported theorem statement, and claimed computation. It returns exactly one
verdict: `PASS` (complete and correct under stated assumptions) or `FAIL`
(at least one gap, unsupported dependency, or error — including "not enough
information to verify"). Each issue gets a stable ID, a severity
(`CRITICAL` if it could change the conclusion, else `MAJOR` or `MINOR`), an
exact location, an explanation, and the smallest useful repair or
counterexample. A Reviewer never repairs the proof silently and never
passes on likely intent.

Where possible the two reviews of a version use different emphases: one
line-by-line logical and dependency audit, and one hostile audit through
edge cases, alternative derivations, and attempted counterexamples. When the
candidate depends on a computation, at least one review must be accompanied
by the Conductor's mechanical reproduction of that computation; when it
depends on a cited source, at least one reviewer verifies the source says
exactly what is used.

### 3.5 Synthesizer

A Synthesizer receives the exact problem and a selected set of full
write-ups with their open issues and sources — never a raw dump of project
history. It is a rigorous assembler, not a creative proof researcher, and
normally uses a slightly smaller model than the Research Manager, Solvers, and
Reviewers. It rebuilds one coherent, self-contained candidate rather than
concatenating prose, rechecking notation, assumptions, lemma interfaces, and
the conclusion at every join. It may not invent a premise, bridge a missing
implication, strengthen a source statement, or silently repair a source
write-up. If the ingredients do not compose, it states the smallest exact gap
and concludes `UNCERTAIN`.

Synthesizers do not consume one of the eight research-assignment places. The
Research Manager may use them whenever a concrete assembly job exists, subject
to the same project budget and global process capacity. More synthesis is not
useful unless there are genuinely different assemblies or substantial
independent sections to prepare.

### 3.6 Common worker rules

Workers never write shared state, never spawn agents, and work only from
their packet plus explicitly granted recall. Budget exhaustion is reported
as `UNCERTAIN` work-in-progress, never hidden. Every worker returns, in
structured form: its artifact, a memo (new claims with statements and
status proposals, obligations, dead ends, proposed memory cards, budget
report), and its recall log. A worker may propose a memory card but may
never mark its own new mathematical claim `VERIFIED`.

## 4. Waves

A wave is a bounded unit of parallel work with a fixed plan: a
roster of tasks (role, direction, budget, granted inputs), a wave budget,
and a stopping condition. At least 25% of a wave's total budget is reserved
for focused follow-up, assessment, and planning before workers are allocated.
At most eight Solver, Explorer, or Reviewer assignments may appear in one
round. Synthesizer assignments are counted separately.

During a wave, workers reason independently. After all tasks finish, stop, or
fail, the Conductor builds a factual round summary from their structured
returns: new claims, counterclaims, obstructions, dead ends, and questions. A
focused follow-up, when the Research Manager requests it, resumes a specific
worker's session with questions addressed by claim or issue ID — never
requests to restate a whole solution — and reviewer sessions stay mutually
independent until both initial verdicts are in.

Wave roster defaults evolve with the evidence and are defaults, not quotas:

| Situation | Typical next wave |
|---|---|
| Little is known | Two Solvers on distinct methods; one Explorer |
| A bottleneck lemma emerges | One lemma-focused Solver; one alternative-path Solver; one Explorer |
| Coherent ingredients are available | One or more Synthesizers as the assembly requires; then two independent Reviewers |
| Reviews find local gaps | One repair Solver; one independent gap Solver |
| Reviews find a structural flaw | Return to diverse Solvers/Explorers; do not keep polishing |

## 5. Phases and lineages

A project moves through forward phases:

```text
INTAKE -> DISCOVERY -> SYNTHESIS -> REVIEW -> REPAIR -> REVIEW
                              \-> TERMINAL <-/
```

`REPAIR` may return to `DISCOVERY` when an approach is abandoned. Any active
phase may reach `TERMINAL` as `UNCERTAIN` under a stopping rule. Every
transition is recorded with its reason.

A candidate may be **scoped**. Most research does not settle the whole
problem, and a partial result that nobody checked is worth little. So a
candidate may carry an explicit scope — the exact narrower statement it
establishes — and is then reviewed exactly like any other candidate. A scoped
candidate can never satisfy the acceptance predicate for `problem.md`: the
runtime refuses it by construction, so a partial result can never be mistaken
for a solution. What it earns instead is verification: a scoped candidate
passed by two independent reviews with no open issues is an established
partial result, and the final report must present it as such, separately from
claims that were merely asserted. Reviewers of a scoped candidate judge it
against its scope — failing it for not proving more is wrong, but so is
letting it overreach that scope, or letting a scope be quietly written to
match a weaker argument.

Candidates belong to **lineages**: a lineage is one mathematical approach; a
new version within a lineage is created whenever mathematical content
changes (repairs included — a repair produces a complete new version, never
a patch). Versions are immutable once frozen. The data model supports
multiple lineages; the v1 runtime keeps at most one lineage active at a
time, and abandoning a lineage is an explicit, recorded Research Manager action. If
the same core gap survives two versions of a lineage, the Research Manager must
prefer a new approach or termination over further polishing.

## 6. Claims and issues

The claims ledger holds every extracted dependency and reusable result.
A claim has a stable ID, an exact statement, a status — `UNVERIFIED`,
`VERIFIED`, `REFUTED`, or `SUPERSEDED` — and provenance. Status changes are
Conductor-mediated events with recorded justification: a check by a
different agent, a hash-matching reproduced computation, a precise verified
source, or an explicit human intervention. Claims inherited from an agent's
memo start `UNVERIFIED`.

A candidate's **external dependencies** — the ledger claims it relies on
without proving them inline — are named when it is frozen, and all of them
must be `VERIFIED` before it can be accepted. One mechanical promotion path
discharges them: when two independent reviewers `PASS` the same frozen
version, that version's still-`UNVERIFIED` dependencies become `VERIFIED`,
attributed to those reviews. This is a check by different agents in the
protocol's sense — reviewers receive the claim-ledger extract, must confirm
that every imported result says exactly what is used, and must return `FAIL`
when they cannot verify it. `REFUTED` and `SUPERSEDED` claims are never
promoted this way, and a human may refute any claim afterwards. Without such
a path acceptance would be unreachable: no Research Manager action promotes a claim,
so a candidate with real dependencies would re-review itself forever.

Issues are raised by reviews (or by the human) against a specific candidate
version, carry severity and location, and are resolved only by a new
version that answers them by ID or by a recorded disposition. The Conductor
may record a Research-Manager-proposed rejection of an issue only with a written
mathematical reason, and that disposition is visible to later reviewers.
Repair rounds are never spent on cosmetic changes while a conclusion-
changing issue remains open.

## 7. Memory

Memory is layered, and access is deliberately asymmetric to balance
continuity against anchoring and correlated error:

1. **Foundation** — `problem.md`, stable definitions, human decisions.
   Always supplied in full.
2. **Original materials** — the verbatim objective, background, and uploaded
   documents. Short abstracts and excerpts keep the ordinary view compact;
   the Research Manager can open the full sources in bounded pieces whenever
   needed.
3. **Research Manager's current view** — free-form mathematical prose
   rewritten after every completed round and supplied at the next decision.
   Earlier versions remain visible but are not all placed in the active
   context.
4. **Short role notes** — a small brief rebuilt after each round for each
   worker role (defaults: Solver 250–500 tokens beyond the problem;
   Explorer 200–400; Reviewer only definitions, conventions, and verified
   dependencies needed for the audit; Synthesizer receives selected full
   write-ups instead of a role note). The prose uses epistemic wording:
   "A003 claims X", "X (verified as K017)", "A002 fails at I004".
5. **Working library** — note IDs, types, status, tags, very short abstracts,
   and source references. Its default view is the active set; the full
   archive is searchable by explicit status.
6. **Full record** — complete notes and linked mathematical write-ups,
   expandable by explicit ID with a stated reason.

Current-wave artifacts are `SEALED` and are not memory. Rejected or
suspicious material is `QUARANTINED`: visible in search results as a
warning, never presented as fact, and refused on expansion by workers.

After each completed round, the Research Manager also acts as the librarian.
It may merge overlapping `PROPOSED` notes into a smaller,
source-bearing `PROPOSED` card, mark a concretely useful direction
`promising`, and retire redundant, exhausted, or low-value `PROPOSED` cards as
`SUPERSEDED`. This is organization, not verification. It never deletes a
source, changes a VERIFIED record merely for neatness, or treats compression as
new evidence. When several attempts fail at the same point, one exact
obstruction plus the condition that would reopen the route is preferable to a
stack of chronological attempt summaries. At decision time it receives the
short active library and may search or expand older notes on demand, so the
ordinary prompt stays small without making the past inaccessible.

A memory card has a stable ID, a type (`DEFINITION`, `LEMMA`,
`COUNTEREXAMPLE`, `COMPUTATION`, `OBSTRUCTION`, `ATTEMPT-SUMMARY`,
`OPEN-QUESTION`), a status (`PROPOSED`, `VERIFIED`, `REFUTED`,
`SUPERSEDED`, `QUARANTINED`), exact content, an abstract, provenance,
dependencies, and tags, and links to its full source artifact. Admission
and promotion rules are enforced by the Conductor: no self-verification,
promotion only via an independent check, a reproduced computation, or a
precise verified source. Contradictory cards remain visible and linked
in the archive until adjudicated. A working-card abstract is at most four
sentences; a condensed body states named mathematical conclusions rather than
work chronology. `promising` affects ordering only, never status. Ordinary
recall omits `REFUTED` and `SUPERSEDED` records, while an explicit archive
filter recovers them. Recall never upgrades a claim's status.

## 8. Computations and sources

Exact symbolic reasoning is preferred; numerical and computer-algebra work
is diagnostic unless the problem is explicitly a finite computation. Every
computation that any conclusion relies on is recorded with its code, exact
inputs, environment, and output hash, and must be mechanically re-executed
by the runtime with a matching hash before acceptance. Web pages, papers,
prior agents, and model memory are untrusted until the precise needed claim
is checked; granted sources carry provenance, and quoting respects
licenses.

Workers reach the outside world only through grants. A project chooses
whether literature search is permitted at all: with it off — the default —
the only sources entering a run are the ones the owner supplied, which keeps
the run reproducible and free of outside contamination. With it on, the
Research Manager may grant a search capability assignment by assignment, and every grant is
recorded. What a search returns is a citation requiring precise provenance —
author, title, venue, year, and where in the source the statement lives —
never a proof, and never a substitute for reasoning the worker has not done.
Establishing whether a statement is already known, open, or refuted, and
confirming that a cited theorem says exactly what an argument uses, are the
purposes this exists for.

## 9. Termination and the final report

The final report stands alone and begins with exactly one of
`RESULT: PROVED`, `RESULT: DISPROVED`, or `RESULT: UNCERTAIN`. The result
line is stamped by the Conductor from the acceptance predicate; the
composed prose cannot override it. For `PROVED`/`DISPROVED` it presents the
accepted argument with candidate version, review IDs, and dependency
provenance. For `UNCERTAIN` it distinguishes established partial results
from conjecture, states the decisive gaps, summarizes failed directions,
and recommends the next most informative work. A mathematical assumption or
gap is never hidden for the sake of polish.

### 9.1 Standalone paper after research stops

At the human's request, the Research Manager makes a separate final reading
of the complete mathematical record and writes a TeX manuscript. The stopping
label is not binding in this reading: the Manager reconstructs the decisive
argument, may complete one bounded deduction itself, and must change the
assessment if the earlier proof or counterexample does not survive.

There are exactly two outcomes. If a complete proof or counterexample survives,
the document is a preprint and its result is `PROVED` or `DISPROVED`. Otherwise
the result is `UNCERTAIN` and the document is a research report: it gathers the
sound partial theorems, proofs, and calculations; separates them from
heuristics; states the exact remaining gap; and records worthwhile next steps.
An uncertain conclusion is never formatted as a publishable theorem merely
because the project previously stopped with a definite label.

The manuscript is written for mathematicians who have no access to the project.
It contains no project name, internal labels, assignment history, or references
to the research software. Mathematical statements replace private identifiers,
and ordinary bibliographic citations replace source labels. The Research
Manager supplies TeX fragments; deterministic code supplies a fixed preamble,
rejects file-reading commands and leaked private labels, and compiles locally.
The accepted TeX, compilation log, and PDF are preserved. A compiler failure
may be retried without asking the Research Manager to redraft the paper.

## 10. Human authority

The human reviews and may directly edit W000 before discovery begins. At any
time the human may: submit guidance (delivered to the Research Manager at its next
decision point, or urgently — stopping new dispatch and reconvening early);
pause and resume; interrupt tasks; adjust budgets; answer, defer, or
dismiss Questions; and intervene directly in ledgers — marking a claim
verified or refuted, raising an issue, or quarantining a memory card — with
every intervention recorded as a human-provenance event that later agents
can see and weigh as exactly what it is: a domain expert's recorded
judgment, not an anonymous edit.
