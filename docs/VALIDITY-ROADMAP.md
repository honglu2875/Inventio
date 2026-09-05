# Validity at a controlled cost

The subsequent architectural redesign is specified in
[SESSION-DESIGN.md](../SESSION-DESIGN.md). It retains the validity safeguards
while retaining recurrence, limiting each round to one Solver and Explorer,
adding author-session repairs and a strong memory auditor, and using smaller
models for routine checks and editorial work. The owner has removed backward
compatibility as a requirement for that replacement; the historical constraints
below describe the work already implemented.

## Objective and boundaries

Reduce false acceptance and make each decisive conclusion traceable to its
mathematical and computational evidence. Keep independent checking, frozen
W-of-V policies, project confinement, and historical replay. Do not substitute
vote counts, successful code execution, or longer reports for correctness.

The audit in PROMPT-AUDIT.md supplies the motivating cases. A failure of a
submitted proof, including a missing dependency, does not refute its statement.
The owner identifies the D calculation in virasoro-quartic-5 as wrong, which
supports labelling that submitted proof invalid. The exact corrected derivation
is needed before labelling an alternative proof valid or diagnosing the TRR error.
No live trials are authorized by this roadmap.

## Implementation sequence

### 1. Preserve conflicting evidence before accepting a decisive conclusion

Extend the existing round statement-comparison pass to report explicit pairs
of incompatible statements and a mathematical reason. Give it complete
statements on demand; abbreviated index entries cannot establish identity or
incompatibility. It cannot select a true statement or change a proof. Persist
conflict observations and explicit owner resolutions as new events. Keep the
original statements and all verifier verdicts.

A fact implicated in an unresolved conflict remains in the record but cannot
supply a settled premise or a decisive stopping result. FAILED and
NEEDS_REVISION on the other proof do not resolve a conflict. Unrelated
conflicts do not invalidate an independent proof. Show the reason in the
library, source tools, summary and final reading, and publication packet.
Owner resolution needs a mathematical reason and changes the warning, not a
saved verifier vote or prior terminal report.

Validation: a synthetic analogue of the D case (one accepted claim, an
opposing incomplete proof), incompatible accepted claims, unrelated conflicts,
identical statements, invalid IDs, explicit resolution, and replay. Preserve
one comparison pass per round; no extra referee or reconciliation model.

### 2. Record dependencies and propagate uncertainty

Let a submitted claim name the existing project facts it uses. Store those
references in the existing durable claim dependency field after checking the
IDs. The proof must still state and justify its dependencies within the
isolated verifier packet. A dependency link grants no additional filesystem or
memory access.

Use one shared, cycle-safe eligibility calculation in the runtime and reading
projections. A suspicious, disputed, or retracted premise prevents dependent
facts from being used as settled results. Equivalent replacement facts may
supply the same premise. Missing links in historical claims mean unknown
provenance; do not invent dependency edges from prose during replay.

Validation: transitive dependencies, a retracted premise, equivalent
replacement, missing IDs, cycles, and proof independence. No additional model
calls. Explicit source-theorem/formula snapshots are a later extension, after
these project-fact semantics are stable.

### 3. Record execution evidence without trusting self-report

Extract command outcomes from the verifier's archived CLI event stream. Keep
stable archive references, exact shell commands, exit status, output hashes, and bounded diagnostic text;
record absence or incomplete capture explicitly. Preserve both successful and
failed commands. Expose the record beside the verifier report and in exports.
Do not rerun worker-authored commands in the conductor's unrestricted process.

A structured verifier declaration of computational support must identify its
successful command evidence by the commands supplied to the shell tool; CLI-generated item IDs are not assumed visible to the model. A hand derivation is an equally valid basis and
must be shown in the report. A failed or missing execution cannot certify a
computation, while a successful command establishes execution only. Preserve
original model returns when runtime evidence checks reject their claimed
support. Recovery must validate the same saved evidence without spending a
second verification call.

Validation: failed command followed by PASS, explicit hand derivation after a
failure, success with zero output, unfinished commands, reused item IDs across
turns, missing/truncated archives, and crash recovery. New execution records
must be append-only and must not reinterpret old completed verifications.

### 4. Establish an offline evaluation and cost baseline

Provide a deterministic evaluator for explicitly selected, saved verification
results and expert labels. Report false acceptance and false rejection
separately, abstentions/errors, failure findings, evidence-check failures, and
uncached-input-plus-output usage. Do not treat an unlabelled competing claim
as correct. Keep private cases outside tracked fixtures; commit only synthetic
examples. The evaluator does not launch models or mutate projects.

Use this to prepare paired prompt experiments with model, proof version,
tools, W-of-V policy and total allowance held constant. Test evidence wording,
complementary emphases, and shorter writing instructions separately. Accept a
change on held-out false-acceptance/cost results, not apparent confidence.
Live trials require a separate explicit request and expert-labelled cases.

## Later experiments, contingent on evidence

1. **Avoid duplicated incomplete-proof checks.** Experiment with one initial
   dependency/presentation check and a focused revision before spending the
   remaining checks. Do not discard dissent for decisive or disputed claims.
   Preserve the frozen acceptance threshold and total budget; measure saved
   tokens alongside false rejection and latency before enabling by default.
2. **Source and formula provenance.** Snapshot the exact theorem statement,
   edition/page/equation, conventions and applied hypotheses. Supply only the
   authorized dependencies to isolated checks, with content hashes and a
   project-scoped cache. Retrieval is evidence access, not theorem acceptance.
3. **Reproducible calculation certificates.** Execute an immutable script and
   inputs in a tested restricted calculation environment, record environment
   and output hashes, and rerun there. Compare independent mathematical
   derivations as well: repeated execution of the same wrong script is not
   independent confirmation. Do not reuse the retired host-shell reproducer
   for untrusted scripts.
4. **Targeted conflict resolution.** Once conflict precision is measured,
   evaluate a bounded independent check of the first differing equation.
   Charge it to an existing verification allowance, retain both arguments,
   and leave the conclusion uncertain when the conflict remains unresolved.

## Handoff criteria

Each implementation stage needs schema/reducer coverage for new durable
behavior, appropriate HTTP/UI and export projections, adversarial simulator
regressions, and prompt lifecycle documentation. Run npm test, npm run
typecheck, npm run build, and git diff --check before publishing changes.
Record actual completion and remaining limits below; simulator correctness
is not evidence of improved mathematical accuracy.

## Progress

- Archive separation and first prompt revision: pushed as c9bb777.
- Stages 1–4: implemented. All 335 simulator/schema/UI tests, typechecking,
  build, and whitespace checks pass. The UI build retains its existing large
  bundle warning.
- Deterministic text deduplication now preserves letter case; mathematical
  symbols such as A and a are not interchangeable.
- Comparison coverage: an unavailable new comparison stops UNCERTAIN; it is
  retried once on explicit continuation. Historical comparison coverage stays
  unknown rather than being inferred from earlier identity-only calls.
- A comparison that simultaneously declares statements identical and
  incompatible is rejected, including transitive identity chains. A failed
  correction proof leaves its target suspicious until the correction statement
  is refuted. Independent derivations must account for surviving and omitted
  recursion terms before cancellation.
- Cost: no extra verifier slots or automatic reconciliation model. The existing
  comparison may now run for opposing goal relations that were previously
  skipped. Evidence text can change actual usage; no savings or mathematical
  accuracy improvement is claimed without a controlled trial.
- Baseline: the four selected saved checks V283/V284/V301/V302 in
  virasoro-quartic-5 were scored read-only using a manifest in /tmp. Both
  owner-labelled invalid-proof checks were accepted; the two competing checks
  remain unlabelled. They used 1,311,713 uncached-input-plus-output tokens in
  total, with no historical structured execution audits. This is a selected
  failure case, not an estimate of the harness's general false-acceptance rate.
- Scope limits: dependencies are explicit project-fact links; no automatic
  theorem/source cache or statement-to-code correctness checker was added.
  The evaluator scores individual checks, not whole research trajectories.
- Live evaluation and subsequent experiments: not run.
