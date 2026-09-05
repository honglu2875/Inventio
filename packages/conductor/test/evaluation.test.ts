import type { VerificationState } from "@inventio/schema";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCanonicalEvents } from "../../schema/test/fixtures.js";
import { readEvaluationCases } from "../src/evaluation/readCases.js";
import { EvaluationManifest, scoreVerifications } from "../src/evaluation/score.js";

function check(verdict: VerificationState["verdict"], usage = true): VerificationState {
  return {
    id: "V001", claimId: "K001", ordinal: 1, evidenceRequired: false, executionEvidence: null,
    status: "completed", verdict, finding: verdict === "PASS" ? "NONE" : "PROOF_GAP", summaryMarkdown: "Test", artifactPath: null,
    usage: usage ? { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100, reasoning_output_tokens: 0 } : null,
    requestedAtSeq: 1, completedAtSeq: 2
  };
}

describe("offline validity and cost evaluation", () => {
  it("separates invalid/incomplete acceptance, valid-proof rejection, abstentions and unlabelled evidence", () => {
    const score = scoreVerifications([
      { id: "wrong", variant: "old", label: "INVALID_PROOF", verification: check("PASS") },
      { id: "incomplete", variant: "old", label: "INCOMPLETE_PROOF", verification: check("FAIL") },
      { id: "right", variant: "old", label: "VALID_PROOF", verification: check("FAIL") },
      { id: "error", variant: "new", label: "VALID_PROOF", verification: check("ERROR", false) },
      { id: "competing", variant: "new", label: "UNLABELLED", verification: check("PASS") },
    ]);
    expect(score.total.falseAcceptance).toEqual({ count: 1, denominator: 2, rate: 0.5 });
    expect(score.total.falseRejection).toEqual({ count: 1, denominator: 2, rate: 0.5 });
    expect(score.total).toMatchObject({ checks: 5, labelledChecks: 4, decided: 4, abstentions: 1, observedTokens: 1200, missingUsage: 1, meanTokens: null, unauditedChecks: 5 });
    expect(score.variants.old!.meanTokens).toBe(300);
    expect(score.variants.new!.falseAcceptance.rate).toBeNull();
  });
  it("reads selected archived results without opening a writer lease or changing bytes", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "inventio-evaluation-"));
    const events = buildCanonicalEvents();
    const file = path.join(root, "events.jsonl");
    const original = events.map(event => JSON.stringify(event)).join("\n") + "\n";
    writeFileSync(file, original);
    writeFileSync(file + ".lock", "immutable old lock");
    const manifest = path.join(root, "cases.json");
    writeFileSync(manifest, JSON.stringify({ version: 1, cases: [{ id: "synthetic", variant: "fixture", eventsFile: "events.jsonl", verificationId: "V001", label: "UNLABELLED" }] }));
    expect(readEvaluationCases(manifest)[0]!.verification.verdict).toBe("PASS");
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(readFileSync(file + ".lock", "utf8")).toBe("immutable old lock");
  });
  it("refuses repeated case IDs rather than silently double counting results", () => {
    const entry = { id: "x", variant: "fixture", eventsFile: "events.jsonl", verificationId: "V001", label: "UNLABELLED" };
    expect(EvaluationManifest.safeParse({ version: 1, cases: [entry, entry] }).success).toBe(false);
  });
});
