import { describe, expect, it } from "vitest";
import { decodeTaskMemo } from "../src/lib/api.js";

const memo = {
  summary: "A concise mathematical summary.",
  newClaims: [],
  issues: [],
  obligations: ["Check the remaining case."],
  deadEnds: [],
  proposedCards: [],
  computations: [],
  budgetReport: "Within budget.",
};

describe("task-detail memo decoding", () => {
  it("accepts the corrected direct memo response", () => {
    expect(decodeTaskMemo(memo)).toEqual(memo);
  });

  it("unwraps the legacy whole-worker-output response", () => {
    expect(
      decodeTaskMemo({
        conclusion: "UNCERTAIN",
        artifactMarkdown: "CONCLUSION: UNCERTAIN\n\nPartial work.",
        memo,
        recallLog: [],
      }),
    ).toEqual(memo);
  });

  it("turns malformed transport data into an absent memo instead of throwing", () => {
    expect(decodeTaskMemo({ summary: "missing required arrays" })).toBeNull();
    expect(decodeTaskMemo(undefined)).toBeNull();
  });
});
