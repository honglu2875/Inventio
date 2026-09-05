import type { ProjectState, Result } from "@inventio/schema";

/**
 * The acceptance predicate (PROTOCOL §2, DESIGN §6.7), evaluated mechanically.
 * Returns the list of failing conditions; empty = accepted.
 */
export function evaluateAcceptance(
  state: ProjectState,
  candidateId: string,
): { passed: boolean; failing: string[]; result: Result | null; } {
  const failing: string[] = [];
  const c = state.candidates[candidateId];
  if (!c) return { passed: false, failing: [`candidate ${candidateId} does not exist`], result: null };

  if (c.scope !== null) {
    failing.push(
      `candidate is scoped to a partial result ("${c.scope.slice(0, 120)}"), which cannot satisfy problem.md in full`,
    );
  }

  if (c.obligations.length > 0) {
    failing.push(`obligation list is not empty (${c.obligations.length} open)`);
  }

  const openBlocking = c.issueIds.filter((iid) => {
    const issue = state.issues[iid]!;
    return issue.status === "open" && (issue.severity === "CRITICAL" || issue.severity === "MAJOR");
  });
  for (const iid of openBlocking) {
    failing.push(`open ${state.issues[iid]!.severity} issue ${iid}`);
  }

  for (const kid of c.usedClaimIds) {
    const claim = state.claims[kid];
    if (!claim) failing.push(`used claim ${kid} missing from the current claims record`);
    else if (claim.status !== "VERIFIED") {
      failing.push(`used claim ${kid} is ${claim?.status ?? "missing"}, not VERIFIED`);
    }
  }

  const reviews = c.reviewIds.map((rid) => state.reviews[rid]!);
  const passes = reviews.filter((r) => r.verdict === "PASS").length;
  const fails = reviews.filter((r) => r.verdict === "FAIL").length;
  if (passes < 2) failing.push(`only ${passes} PASS review(s) of ${candidateId}; two required`);
  if (fails > 0) failing.push(`${fails} FAIL review(s) stand against ${candidateId}`);

  const artifact = state.artifacts[c.fromArtifact];
  // A broken experiment may invalidate the artifact that used it, but an
  // unrelated experiment from another research branch must not make every
  // candidate in the project permanently unacceptable.
  const sourceTaskId = artifact?.taskId ?? null;
  for (const comp of Object.values(state.computations)) {
    if (sourceTaskId === null || comp.taskId !== sourceTaskId) continue;
    if (comp.exitCode !== null && comp.exitCode !== 0) {
      failing.push(`computation ${comp.id} did not run successfully (exit ${comp.exitCode})`);
    } else if (comp.reproduced === null) {
      failing.push(`computation ${comp.id} has not been independently reproduced`);
    } else if (comp.reproduced.match === false) {
      const detail =
        comp.reproduced.exitCode !== null && comp.reproduced.exitCode !== 0
          ? ` (rerun exit ${comp.reproduced.exitCode})`
          : "";
      failing.push(`computation ${comp.id} failed reproduction${detail}`);
    }
  }

  const conclusion = artifact?.conclusion ?? null;
  let result: Result | null = null;
  if (conclusion === "PROVED" || conclusion === "DISPROVED") {
    result = conclusion;
  } else {
    failing.push(`candidate conclusion is ${conclusion ?? "unknown"}, not PROVED/DISPROVED`);
  }

  return { passed: failing.length === 0, failing, result };
}
