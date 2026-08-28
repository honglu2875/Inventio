# Long-trajectory research workflow

This document specifies the second-generation Inventio workflow. It is kept
separate from the legacy council protocol so projects created by earlier
versions can still be replayed without reinterpretation.

## Compatibility boundary

- Every project records a workflow version. Missing workflow metadata means
  the legacy `council-v1` workflow.
- New projects use `trajectories-v2`.
- Existing event types and reducer meanings remain append-only. The new
  workflow adds events and optional fields; it does not rewrite old logs.
- The deterministic conductor owns scheduling, persistence, budgets, retries,
  and state transitions. It does not make mathematical choices.

## Research loop

1. Intake preserves the raw materials and produces an editable initial
   mathematical view (`W000`).
2. Each research round starts `N` independent Solvers and `M` independent
   Explorers from that common view, the current facts and claims, and any
   user guidance. Defaults are `N=2`, `M=2`, for at most five rounds.
3. A Solver works directly on the stated problem. An Explorer develops useful
   nearby mathematics, examples, special cases, obstructions, or methods.
   Both receive long wall-clock budgets, web access when the project permits
   it, a writable computation directory, and tools for inspecting the record.
4. During a trajectory a worker may record a small number of mathematical
   milestones. At the end it returns a write-up and a short, parseable list of
   genuinely useful claims. Every claim must contain a self-contained statement
   and a complete alleged proof. Assumptions, vague ideas, and repetitive
   instance-by-instance observations are not claims.
5. Each new claim is checked independently by `V` Verifiers. It becomes a fact
   after at least `W` passes (`1 <= W <= V`). Verification runs concurrently
   with later research whenever capacity permits. A claim that can no longer
   reach `W` passes is marked failed and hidden from the default library view.
6. Equivalent claims are linked transitively while retaining their distinct
   proofs. If one becomes a fact, the other active versions leave the claim
   pool and point to that fact.
7. At the end of a round, a strong summary reader may make a small revision to
   `W000` only when the new work materially changes the mathematical picture.
   This is editorial maintenance, not a planning or management layer.
8. The next round starts after its research trajectories and summary review
   finish. After the final round, outstanding verification finishes before the
   project result is written.

## Facts and corrections

Claims and facts are plain Markdown files and remain retrievable through tools.
A worker that finds a concrete contradiction or disproof may flag one fact once
with a short mathematical reason. The flag creates a new correction claim and
uses the same independent verification process. A passing correction retracts
the fact; a failing correction clears the warning. This is deliberately narrow:
mere doubt is not a correction claim.

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
- the library is organized as Facts, Active claims, Failed claims, Write-ups,
  and Verifications;
- the Summary view shows the current `W000` and its short revision history;
- legacy manager, candidate, and council terminology is not shown.
