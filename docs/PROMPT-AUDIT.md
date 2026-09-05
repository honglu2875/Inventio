# Prompt audit and evaluation plan

This audit examines the saved evidence in the five projects explicitly placed
in scope by the owner: `virasoro-quartic-4`, `virasoro-quartic-5`,
`toda-hierarchy-2`, `toda-hierarchy-on-surfaces`, and `quintic-dnc-bcov`.
The owner further identifies the D discrepancy as likely a mishandled TRR
summand: 10/3 is itself a summand, but the exact incorrect step is not yet
located. K146 concludes A - 2D = -10/3; K156 instead reports D = -35/18
and A = -35/9. These are conflicting derivations, not an expert-certified
corrected formula. This audit does not certify their conclusions. Runtime files remain
private and unchanged. References below are navigation pointers into those
local archives, not copied research artifacts.

## Findings

These findings describe the original runs and first revision. Current
implementation status is recorded in VALIDITY-ROADMAP.md.

| Evidence | Observation | Diagnosis | Response |
| --- | --- | --- | --- |
| `virasoro-quartic-5`, K146, V283/V284, F071 | The owner identifies the decisive claim as wrong. Both reports endorse the calculation without presenting the decisive contraction. | The verdict standard is strong, but the required evidence in the report is underspecified. Same-model checks can share the same mathematical mistake. | Require a concise derivation of the decisive step; give alternate verifiers an independent-derivation emphasis. This is not a blind check: both still receive the whole proof. |
| Same run, K156, V301/V302 | An opposing calculation gets one PASS and one missing-dependency failure in the same round. The latter does not refute its statement. | A missing cross-claim consistency mechanism, not simply a weak referee instruction. | Evaluate a bounded conflict check before decisive termination in a future change. Do not claim this is fixed by the prompt changes. |
| Same run, V283/V284 transcripts; `toda-hierarchy-2`, V145 transcript | Attempted Python/SymPy calculations exit unsuccessfully, yet the final reports endorse the mathematics. The transcripts do not identify the cause of those failures. | Runtime capability and evidence tracking; an unsuccessful command cannot confirm a calculation. A hand derivation may still be valid. | Tell verifiers to distinguish successful computation, failed execution, and explicit hand derivation. A tested calculation environment and durable computation evidence remain separate work. |
| The four trajectory runs, verification events | Many checks end with missing dependencies or presentation problems despite the request for complete claims. | Submission requirements are underspecified in practice; generic “complete proof” wording is not sufficient. | Ask for the decisive derivation in the claim, exact imported theorem statements, their sources and applicable hypotheses. Do not demand a fresh proof of every standard theorem. |
| K146/K156 saved verifier AGENTS.md | The contract describes the claim as intentionally self-contained before verifying completeness. | Misleading framing. | Say that self-containedness is a requirement to check, not an established property. |
| Current trajectory final-response contract | “Strongest natural statement” can encourage combining a useful proved result with an unsupported extension. | Possible overclaiming pressure; causality is not established by the logs. | Ask for exactly the scope supported by the proof. |
| Saved verifier AGENTS.md in both decisive trajectory runs | The shared English contract invokes a full external controlled-language standard and detailed sentence rules. | Possible overspecification unrelated to the mathematical decision; no evidence that it caused the error in D. | Replace it with shorter instructions for clear academic exposition and explicit priority for complete mathematical evidence. |
| `virasoro-quartic-4`, latest `artifacts/finals/final-3.md`, versus run 5 | The recorded degree-two conclusions are incompatible. | Cross-run inconsistency is evidence for review, not a way to choose the true result by voting. | Include both in an owner-authorized evaluation set. Do not silently share private project material across workers or projects. |
| `toda-hierarchy-2`, K075/F024, V145/V146 | The decisive argument joins localization, a charge filtration, wedge normalization, and the hierarchy; the final reports mostly affirm those transitions. | Evidence for the crucial interfaces is thin in the reports. This audit does not declare the theorem false. | In a future evaluation, require a derivation at the transition most capable of changing the conclusion, rather than only tests of downstream coefficients. |
| `toda-hierarchy-on-surfaces`, latest stopping report | Partial sectors and unresolved higher-genus content remain distinguished. | Useful uncertainty calibration worth preserving. | Include correct partial and honestly incomplete arguments in the evaluation, not only dramatic wrong proofs. |
| `quintic-dnc-bcov`, latest stopping report, C002.v1/v2 and C004.v1 | The report separates accepted scoped results, unchecked assertions, and conjecture; failed versions are excluded. | Useful scope discipline from the council workflow. | Preserve its archived meaning and retain this discipline in trajectory prompts without restoring the council controller. |

## First prompt revision (c9bb777)

- Shorter academic writing guidance replaces the full ASD-STE100 obligation.
- A claim must contain the decisive calculation and precise imported results;
  a scratch-work reference alone does not make a proof self-contained.
- Verifier ordinal 1 emphasizes the logical and dependency audit. Ordinal 2
  emphasizes independently deriving the decisive step before comparison.
  Larger verifier counts alternate these emphases. Every verifier still
  checks the complete proof and its relation to the original problem.
- Reports must document the decisive mathematical check rather than offer
  generic assurances. A failing report may stop at the concrete defect.
- Failed commands are not computational confirmation; code execution and
  mathematical correctness remain distinct.
- Publication now receives the trajectory claims/facts library and current
  mathematical view rather than an empty council-candidate projection.

No new model calls, roles, verifier counts, or token ceilings are introduced.
Saved prompts and completed verdicts are not rewritten. Process restart of a
research trajectory keeps its existing packet. An unfinished verifier that is
restarted receives the current verifier contract, as before this refactor.

## Cost baseline

Totals from completed verification events use Inventio's `usageSpend` metric:
uncached input plus output tokens. They are not dollar costs. Original logs
may include checks from before the current statement-deduplication behavior.

| Project | Checks | All verification tokens | Missing dependency / presentation verdicts |
| --- | ---: | ---: | ---: |
| virasoro-quartic-4 | 331 | 40,837,265 | 13,860,190 |
| virasoro-quartic-5 | 310 | 40,463,605 | 11,314,881 |
| toda-hierarchy-2 | 146 | 8,275,913 | 3,970,777 |
| toda-hierarchy-on-surfaces | 195 | 15,910,505 | 5,832,991 |

These failures are useful evidence. The potential waste is discovering the
same omitted dependency twice. Sequential checks and a focused revision loop
are candidates for a later budget experiment, with exceptions for decisive
claims and unresolved conflicts so useful dissent is not discarded.

## Further iterations

1. Have the domain expert label the exact defect in K146 and the status of the
   competing calculation. Until then, the former has an owner-supplied wrong
   label; the latter is conflicting evidence, not a certified correct answer.
2. Build a small evaluation set of correct proofs, wrong calculations,
   incomplete proofs, and correct partial results. Add held-out variations
   involving signs, boundary terms, source hypotheses, and limit operations.
3. Compare the old prompt, evidence-only revision, complementary emphases,
   and shorter style guidance separately. Keep model, tools, proof versions,
   total token allowance, and verdict policy fixed. Do not infer a causal
   effect from a single run or from prompt wording tests.
4. Score false acceptance and false rejection separately. Also score whether
   the report identifies the actual decisive step, whether claimed executions
   succeeded, and total usage. Schema/simulator tests establish orchestration
   behavior, not mathematical reliability.
5. Only after explicit authorization for live evaluation, run repeated paired
   trials. Accept a revision for its validity/cost tradeoff on held-out cases,
   not for longer or more confident reports.

The subsequent implementation is tracked in VALIDITY-ROADMAP.md. It adds
conflict-aware stopping, explicit project-fact dependencies, execution evidence
checks, and offline evaluation. Reproducible calculation certificates, exact
external theorem/formula snapshots, budget-policy experiments, and live paired
evaluations remain later work. These require their own validation rather than
being attributed to the first prompt revision.
