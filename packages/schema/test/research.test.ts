import { describe, expect, it } from "vitest";
import { applyResearchChange, initialResearchState, resultStatus, auditCoverage, type ResearchState, type FrozenResult, type ResearchChange } from "../src/research.js";
const model = { model: "research", effort: "high" as const };
function setup(): ResearchState {
  const s = initialResearchState();
  applyResearchChange(s, { kind: "round.opened", id: "W001", number: 1, briefMarkdown: "Original problem", researchModel: model, supportModel: model });
  for (const [id, role] of [["S001", "solver"], ["S002", "verifier"], ["S003", "auditor"]] as const) applyResearchChange(s, { kind: "session.opened", id, role, roundId: "W001", model });
  return s;
}
const version = (id: string, dependencies: string[] = []): FrozenResult => ({ id, resultId: id.split(".")[0]!, version: 1, parentVersionId: null, sessionId: "S001", roundId: "W001", title: id, kind: "PROPOSITION", statement: "Exact hypothesis implies exact conclusion.", proofMarkdown: "Complete alleged derivation.", relationToGoal: "RELATED", dependencies, sourceIds: [], attachments: [], hash: "a".repeat(64) });
function assess(s: ResearchState, id: string, mode: "check" | "audit", verdict: "CONFIRM" | "QUARANTINE" | "UNABLE" = "CONFIRM") {
  const n = Object.keys(s.turns).length + 1; const turnId = `U${n}`; const sessionId = mode === "audit" ? "S003" : "S002";
  applyResearchChange(s, { kind: "turn.opened", id: turnId, sessionId, roundId: "W001", purpose: mode, targets: [{ versionId: id, hash: s.versions[id]!.hash }], objectionIds: [], budgetTokens: 100, resumeThreadId: null });
  const c: ResearchChange = { kind: "assessment.recorded", id: `A${n}`, turnId, sessionId, roundId: "W001", mode, assessment: { versionId: id, hash: s.versions[id]!.hash, verdict, finding: verdict === "CONFIRM" ? "NONE" : verdict === "UNABLE" ? "OPERATIONAL" : "MATHEMATICAL_ERROR", reasonMarkdown: "A self-contained mathematical explanation with the decisive expression.", scopeSupported: verdict === "CONFIRM", evidence: { basis: "derivation", supportingCommands: [] } }, evidencePath: "evidence.json", evidenceValid: true, evidenceIssues: [] };
  applyResearchChange(s, c);
  applyResearchChange(s, { kind: "turn.completed", id: turnId, status: "completed", chargedTokens: 10, elapsedMs: 5, usage: null, error: null, outputPath: null });
}
describe("exact-version mathematics", () => {
  it("propagates a quarantined premise and never inherits an older version's audit", () => {
    const s = setup();
    applyResearchChange(s, { kind: "result.recorded", result: version("B001.v1") });
    applyResearchChange(s, { kind: "result.recorded", result: version("B002.v1", ["B001.v1"]) });
    assess(s, "B001.v1", "audit"); assess(s, "B002.v1", "audit");
    expect(resultStatus(s, "B002.v1")).toBe("AUDITED");
    assess(s, "B001.v1", "audit", "QUARANTINE");
    expect(resultStatus(s, "B002.v1")).toBe("NEEDS_REVISION");
    const v2 = { ...version("B001.v2"), version: 2, parentVersionId: "B001.v1", proofMarkdown: "A revised derivation", hash: "b".repeat(64) };
    applyResearchChange(s, { kind: "result.recorded", result: v2 });
    expect(resultStatus(s, v2.id)).toBe("UNCHECKED");
    expect(s.versions["B002.v1"]!.dependencies).toEqual(["B001.v1"]);
    expect(() => applyResearchChange(s, { kind: "result.recorded", result: v2 })).toThrow("Immutable");
  });
  it("counts substantive objections as coverage and inability as unassessed", () => {
    const s = setup();
    for (const id of ["B001.v1", "B002.v1"]) applyResearchChange(s, { kind: "result.recorded", result: version(id) });
    applyResearchChange(s, { kind: "audit.targets", roundId: "W001", sessionId: "S003", targets: Object.values(s.versions).map(v => ({ versionId: v.id, hash: v.hash })), sealed: true });
    assess(s, "B001.v1", "audit", "QUARANTINE"); assess(s, "B002.v1", "audit", "UNABLE");
    expect(auditCoverage(s, "W001")).toEqual({ total: 2, assessed: 1, challenged: 1, remaining: ["B002.v1"], complete: false });
    expect(() => applyResearchChange(s, { kind: "final.fixed", roundId: "W001", result: "PROVED", reason: "Not actually audited", eligibleVersions: ["B002.v1"], auditComplete: true })).toThrow("complete independent audit");
  });
  it("rejects missing premises and overlapping author sessions", () => {
    const s = setup();
    expect(() => applyResearchChange(s, { kind: "result.recorded", result: version("B001.v1", ["B999.v1"]) })).toThrow("dependency");
    expect(() => applyResearchChange(s, { kind: "session.opened", id: "S004", role: "solver", roundId: "W001", model })).toThrow("Only one");
    const t = { kind: "turn.opened" as const, id: "U001", sessionId: "S001", roundId: "W001", purpose: "research" as const, targets: [], objectionIds: [], budgetTokens: 100, resumeThreadId: null };
    applyResearchChange(s, t);
    expect(() => applyResearchChange(s, { ...t, id: "U002" })).toThrow("already advancing");
  });
  it("rejects an opposite audited conclusion even when a proposed outcome lists only one side", () => {
    const s = setup();
    applyResearchChange(s, { kind: "result.recorded", result: { ...version("B001.v1"), relationToGoal: "PROVES" } });
    applyResearchChange(s, { kind: "result.recorded", result: { ...version("B002.v1"), relationToGoal: "DISPROVES" } });
    assess(s, "B001.v1", "audit"); assess(s, "B002.v1", "audit");
    applyResearchChange(s, { kind: "audit.targets", roundId: "W001", sessionId: "S003", targets: Object.values(s.versions).map(v => ({ versionId: v.id, hash: v.hash })), sealed: true });
    expect(() => applyResearchChange(s, { kind: "final.fixed", result: "PROVED", reason: "Selective conclusion", roundId: "W001", eligibleVersions: ["B001.v1"], auditComplete: true })).toThrow("opposing");
    expect(s.final).toBeNull();
  });

});
