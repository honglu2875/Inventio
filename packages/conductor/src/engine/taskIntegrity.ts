import type { AnyWorkerOutput, WorkerRole } from "@inventio/schema";

const MIN_ARTIFACT_CHARS = 240;

/**
 * Cheap, conservative returned-work check. Schema validity alone does not
 * make a mathematical artifact usable: a worker can put a refusal or request
 * for permission inside a perfectly valid JSON object. False positives are
 * costly, so operational-language detection only fires when the memo also
 * contains no mathematical signal.
 */
export function returnedWorkProblems(role: WorkerRole, output: AnyWorkerOutput): string[] {
  const problems: string[] = [];
  const artifact = output.artifactMarkdown.trim();

  if (artifact.length < MIN_ARTIFACT_CHARS) {
    problems.push(
      `artifact has only ${artifact.length} characters; return a mathematical note, not a placeholder`,
    );
  }

  if (role === "reviewer" && "verdict" in output) {
    const headline = /(?:^|\n)VERDICT:\s*(PASS|FAIL)\s*(?:\n|$)/.exec(artifact)?.[1] ?? null;
    if (headline === null) problems.push("artifact is missing a VERDICT: PASS/FAIL line");
    else if (headline !== output.verdict) {
      problems.push(`artifact verdict ${headline} disagrees with structured verdict ${output.verdict}`);
    }
  } else if ("conclusion" in output) {
    const headline = /(?:^|\n)CONCLUSION:\s*(PROVED|DISPROVED|UNCERTAIN)\s*(?:\n|$)/.exec(artifact)?.[1] ?? null;
    if (headline === null) {
      problems.push("artifact is missing a CONCLUSION: PROVED/DISPROVED/UNCERTAIN line");
    } else if (headline !== output.conclusion) {
      problems.push(`artifact conclusion ${headline} disagrees with structured conclusion ${output.conclusion}`);
    }
  }

  const operationalRequest =
    /\b(?:need|require|waiting for)\s+(?:permission|approval|access|more input)|\bplease\s+(?:provide|grant|clarify)\b|\b(?:cannot|can't|unable to)\s+(?:access|proceed|continue|read)\b/i;
  const memoSignals =
    output.memo.newClaims.length +
    output.memo.issues.length +
    output.memo.obligations.length +
    output.memo.deadEnds.length +
    output.memo.computations.length;
  if (
    memoSignals === 0 &&
    (operationalRequest.test(artifact) || operationalRequest.test(output.memo.summary))
  ) {
    problems.push("return is an operational request/refusal with no mathematical findings");
  }

  return problems;
}
