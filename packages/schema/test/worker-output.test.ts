import { describe, expect, it } from "vitest";
import {
  TrajectoryOutput,
  VerificationOutput,
  trajectoryClaimPreparationProblems,
} from "../src/worker-output.js";

const claim = {
  title: "A standalone lemma",
  statementMarkdown: "Every object satisfying $x=0$ has vanishing $x$.",
  proofMarkdown: "Substitution of the hypothesis gives $x=0$, which is the conclusion.",
  relationToGoal: "PARTIAL" as const,
};

describe("trajectory claim preparation", () => {
  it("accepts a concise standalone mathematical handoff", () => {
    expect(trajectoryClaimPreparationProblems(claim)).toEqual([]);
    expect(
      TrajectoryOutput.safeParse({
        conclusion: "UNCERTAIN",
        summaryMarkdown: "One elementary lemma was established.",
        writeupMarkdown: "# Work\n\nThe calculation is complete.",
        claims: [claim],
      }).success,
    ).toBe(true);
  });

  it("rejects project-local references, omitted arguments, and damaged math", () => {
    const result = trajectoryClaimPreparationProblems({
      statementMarkdown: "K003 proves that $x=0.",
      proofMarkdown: "As shown above, the claim follows.\t\\begin{aligned}x=0.",
    });
    expect(result.map((problem) => problem.message).join(" ")).toMatch(/internal project ID/);
    expect(result.map((problem) => problem.message).join(" ")).toMatch(/surrounding work/);
    expect(result.map((problem) => problem.message).join(" ")).toMatch(/control, tab/);
    expect(result.map((problem) => problem.message).join(" ")).toMatch(/unmatched/);
  });

  it("does not mistake a TeX row break before a parenthesis for a math delimiter", () => {
    const result = trajectoryClaimPreparationProblems({
      statementMarkdown: String.raw`The sum is over $\sum_{\substack{k\ge1\\(k,p,q)\ne(0,0,0)}} a_k$.`,
      proofMarkdown: String.raw`This is a finite sum after imposing $k\le d$.`,
    });
    expect(result).toEqual([]);

    expect(
      trajectoryClaimPreparationProblems({
        statementMarkdown: String.raw`A genuine delimiter \(x+1 remains open.`,
        proofMarkdown: "The rest is complete.",
      }).map((problem) => problem.message),
    ).toContain("has unmatched \\( ... \\) delimiters");
  });
});

describe("verification finding consistency", () => {
  it("requires NONE for PASS and a concrete category for FAIL", () => {
    const base = { summaryMarkdown: "Checked.", reportMarkdown: "# Check\n\nChecked." };
    expect(VerificationOutput.safeParse({ ...base, verdict: "PASS", finding: "NONE" }).success).toBe(true);
    expect(
      VerificationOutput.safeParse({ ...base, verdict: "PASS", finding: "PROOF_GAP" }).success,
    ).toBe(false);
    expect(VerificationOutput.safeParse({ ...base, verdict: "FAIL", finding: "NONE" }).success).toBe(false);
    expect(
      VerificationOutput.safeParse({ ...base, verdict: "FAIL", finding: "MISSING_DEPENDENCY" }).success,
    ).toBe(true);
  });
});
