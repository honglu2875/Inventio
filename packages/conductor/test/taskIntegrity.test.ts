import { describe, expect, it } from "vitest";
import type { Memo, ReviewerOutput, WorkerOutput } from "@inventio/schema";
import { returnedWorkProblems } from "../src/engine/taskIntegrity.js";

const memo = (over: Partial<Memo> = {}): Memo => ({
  summary: "A substantive check was completed.",
  newClaims: [],
  issues: [],
  obligations: [],
  deadEnds: [],
  proposedCards: [],
  computations: [],
  budgetReport: "within budget",
  ...over,
});

const detail = "The argument checks the hypotheses one by one and records the remaining logical dependency. ".repeat(4);

describe("returned-work integrity", () => {
  it("accepts a substantive artifact with a matching conclusion", () => {
    const output: WorkerOutput = {
      conclusion: "UNCERTAIN",
      artifactMarkdown: `# Note\nCONCLUSION: UNCERTAIN\n\n${detail}`,
      memo: memo({ obligations: ["Check the final dependency."] }),
      recallLog: [],
    };
    expect(returnedWorkProblems("solver", output)).toEqual([]);
  });

  it("rejects a schema-valid permission request", () => {
    const output: WorkerOutput = {
      conclusion: "UNCERTAIN",
      artifactMarkdown: "CONCLUSION: UNCERTAIN\n\nI need permission and more input before I can proceed.",
      memo: memo({ summary: "Please provide access." }),
      recallLog: [],
    };
    expect(returnedWorkProblems("solver", output).join(" ")).toMatch(/placeholder|operational request/);
  });

  it("rejects a headline that contradicts the structured value", () => {
    const output: WorkerOutput = {
      conclusion: "PROVED",
      artifactMarkdown: `CONCLUSION: UNCERTAIN\n\n${detail}`,
      memo: memo({ obligations: ["A gap remains."] }),
      recallLog: [],
    };
    expect(returnedWorkProblems("solver", output).join(" ")).toContain("disagrees");
  });

  it("checks reviewer verdict headlines too", () => {
    const output: ReviewerOutput = {
      verdict: "PASS",
      artifactMarkdown: `# Referee note\nVERDICT: PASS\n\n${detail}`,
      memo: memo(),
      recallLog: [],
    };
    expect(returnedWorkProblems("reviewer", output)).toEqual([]);
  });
});
