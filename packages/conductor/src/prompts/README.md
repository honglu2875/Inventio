# Inventio prompt architecture

This directory contains all deliberate model-facing instructions. A call
combines the CLI's own tool context, a short stdin message, a composed working
directory with AGENTS.md, an output schema, and authorized project tools.
Repository and user instructions are excluded from worker packets.

Only trajectories-v2 executes. Council projects are view-only archives;
their original prompts remain in their private saved packets. The old
controller, curation, synthesis, and council worker prompt modules are removed.

| Module | Responsibility |
| --- | --- |
| `trajectories.ts` | Initial reading, Solver/Explorer sessions, statement comparison, independent verification, summary revision, stopping report |
| `publication.ts` | Owner-requested standalone manuscript from the trajectory evidence and current mathematical view |
| `shared.ts` | Short academic English guidance and TeX layout rules appended to every generated AGENTS.md |
| `operational.ts` | Process-failure resume and structured-output repair messages |
| `tools.ts` | Authorized memory and original-source tool descriptions |
| `diagnostics.ts` | Manual diagnostic prompts, never automatic research calls |

## Lifecycle and context

- **Intake:** `generateIntake()` uses `trajectoryIntakeFiles()` and
  `TRAJECTORY_INTAKE_PROMPT` through `runReaderCall()`. It preserves the raw
  submission and supplies indexed source copies. Owner-requested regeneration
  uses the same contract. The compatible IntakeOutput fields for council
  taxonomy remain empty. An intake clone copies the original materials and
  W000 into a new trajectory project without a model call.
- **Research:** `executeTrajectoryTask()` uses `trajectoryWorkerFiles()` and
  `TRAJECTORY_WORKER_PROMPT`. Every trajectory receives the exact problem,
  current view, compact library, source catalog, and applicable owner
  guidance. It chooses its own mathematical strategy. Sparse milestones and
  a concrete correction flag use scoped tools. Research-thread recovery uses
  `TRAJECTORY_RESTART_PROMPT` and preserves the existing packet. Claims require
  exact supported scope, complete decisive calculations, and precise imported
  results. Invalid structured output gets one same-thread repair.
- **Statement comparison:** `compareTrajectoryClaims()` uses
  `claimComparisonFiles()` and `CLAIM_COMPARISON_PROMPT`. It links identical
  statements, never implications or thematic similarity. Failure is an
  optimization loss. It does not currently detect contradictions.
- **Verification:** `executeVerification()` uses `verificationFiles()` and
  `VERIFICATION_PROMPT`. The packet contains only the exact problem and one
  complete submitted claim/proof. Filesystem confinement prevents access to
  other project attempts or peer checks. Odd ordinals emphasize a logical and
  dependency audit; even ordinals emphasize independent derivation of the
  decisive step. This is complementary emphasis, not proof blinding: both
  receive the same claim and must review the complete proof. The report must
  show the decisive expression or implication, applicable hypotheses, and
  source equation rather than merely endorse correctness. Failed execution
  cannot be reported as computational confirmation. PASS/finding semantics,
  frozen W-of-V policy, concurrency, recovery, and budgets are unchanged.
- **Summary:** `reviewTrajectorySummary()` uses `summaryReviewFiles()` and
  `SUMMARY_REVIEW_PROMPT` after the round's checks settle. This is editorial
  maintenance, not research planning. It may leave the view unchanged.
- **Stopping:** `finalizeTrajectory()` uses `trajectoryFinalFiles()` and
  `TRAJECTORY_FINAL_PROMPT`. Deterministic code fixes the result from the
  verification record and supplies active facts and unresolved correction
  warnings. Composition cannot elevate unchecked material. A deterministic
  fallback handles composition failure. Cross-claim conflict handling remains
  separate future work.
- **Publication:** `draftPublication()` uses `publicationPacketFiles()` and
  `PUBLICATION_PROMPT` after an explicit owner request. It receives the
  trajectory claims/facts index, current view, stopping report, and bounded
  record copies. It may downgrade an unsupported conclusion in its separate
  publication assessment. The saved stopping report is not rewritten. TeX is
  saved before a separate owner-requested local compilation; compilation
  retries make no model calls.

`runReaderCall()` provides the shared execution wrapper for intake,
comparison, summaries, stopping reports, and publication. The compatible
memory role name `research_manager` remains an internal tool-access label;
it is not an executable council controller.

## Writing and evidence

`shared.ts` asks for clear ordinary academic prose, stable terminology, exact
hypotheses, and complete derivations. It replaces the earlier obligation to
follow the full ASD-STE100 standard from memory. No sentence-length or grammar
quota competes with mathematical completeness. TeX layout guidance still
prevents delimiters crossing alignment cells or rows.

The failure evidence, limits of causal interpretation, token baseline, and
proposed controlled evaluation are recorded in
[the prompt audit](../../../../docs/PROMPT-AUDIT.md). These changes add no model
calls. Simulator tests check execution and packet contracts; improvements in
mathematical reliability require an explicitly authorized live evaluation.
