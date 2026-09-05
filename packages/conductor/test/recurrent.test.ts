import { defaultRecurrentConfig, resultMathematics, resultStatus, auditCoverage, type FrozenResult, type ResultSubmission } from "@inventio/schema";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/verification/executionEvidence.js";
import { Harness, INTAKE_MATCH, intakeOutput, plannerCall, USAGE, type SimCall } from "./helpers/harness.js";
import { RESEARCH_PROMPT, REPAIR_PROMPT, CHECK_PROMPT, AUDIT_PROMPT, EDITOR_PROMPT, FINAL_PROMPT } from "../src/prompts/recurrent.js";
let h: Harness | null = null;
afterEach(async () => { await h?.stop(); h = null; delete process.env.INVENTIO_SIM_SCENARIO; delete process.env.INVENTIO_SIM_STATE_DIR; });
const proposal = (over: Partial<ResultSubmission> = {}): ResultSubmission => ({ resultId: null, parentVersionId: null, kind: "PROPOSITION", title: "Roundness", statement: "The widget is round.", proofMarkdown: "The defining curvature identity gives the claimed roundness.", relationToGoal: "PROVES", dependencies: [], sourceIds: [], attachmentPaths: [], ...over });
const author = (results: ResultSubmission[] = []) => ({ writeupMarkdown: "A refined mathematical write-up, with no old raw execution trace.", results, responses: [], questions: [] });
function frozen(p: ResultSubmission, id = "B001.v1"): FrozenResult {
  return { ...p, resultId: id.split(".")[0]!, id, version: Number(id.split("v")[1]), sessionId: "S001", roundId: "W001", attachments: [], hash: "0".repeat(64) };
}
const assess = (p: ResultSubmission, id = "B001.v1", verdict: "CONFIRM" | "QUARANTINE" | "RETRACT" | "UNABLE" = "CONFIRM") => ({ versionId: id, hash: sha256(resultMathematics(frozen(p, id))), verdict, finding: verdict === "CONFIRM" ? "NONE" : verdict === "UNABLE" ? "OPERATIONAL" : "MATHEMATICAL_ERROR", reasonMarkdown: verdict === "CONFIRM" ? "The complete defining identity independently gives roundness with exactly the stated hypotheses." : "The displayed recurrence omits the boundary summand 10/3; this invalidates the proposed calculation.", scopeSupported: verdict === "CONFIRM", evidence: { basis: "derivation", supportingCommands: [] } });
function call(prompt: string, finalMessage: unknown, threadId: string, resumeOf?: string): SimCall {
  return { match: { promptContains: prompt, ...(resumeOf ? { resumeOf } : {}) }, finalMessage, threadId, usage: USAGE };
}
const editorial = { summaryMarkdown: "# Round summary\n\nThe precise mathematical record follows.", briefMarkdown: "Consult the recorded results with their exact hypotheses and qualifications.", referencedVersions: [] };
const final = { reportMarkdown: "# Mathematical report\n\nThe original problem and all supported mathematics are given below.", referencedVersions: [] };
async function start(calls: SimCall[], rounds = 1, concurrency = 1, totalTokens = 20_000_000) {
  const config = defaultRecurrentConfig(); config.limits.maxWaves = rounds; config.budget.totalTokens = totalTokens;
  h = Harness.create("recurrent", [plannerCall(INTAKE_MATCH, intakeOutput(), { threadId: "intake" }), ...calls], config);
  h.setConcurrency(concurrency); h.start(); await h.waitFor(s => s.phase === "AWAITING_CONFIRMATION", "intake"); h.confirm();
  return h;
}
describe("recurrent research", () => {
  it("uses one Solver and Explorer and requires a strong audit before decisive first-round stopping", async () => {
    const p = proposal();
    const harness = await start([
      call(RESEARCH_PROMPT, author([p]), "solver"), call(RESEARCH_PROMPT, author(), "explorer"),
      call(CHECK_PROMPT, { assessment: assess(p) }, "check"),
      call(AUDIT_PROMPT, { assessments: [assess(p)] }, "audit"),
      call(EDITOR_PROMPT, editorial, "editor"), call(FINAL_PROMPT, final, "writer"),
    ]);
    await harness.waitForTerminal();
    expect(harness.state.terminal?.result).toBe("PROVED");
    expect(resultStatus(harness.state.research, "B001.v1")).toBe("AUDITED");
    expect(auditCoverage(harness.state.research, "W001").complete).toBe(true);
    expect(Object.values(harness.state.research.sessions).map(s => s.role).sort()).toEqual(["solver", "explorer", "verifier", "auditor", "editor", "writer"].sort());
    expect(harness.state.claimOrder).toEqual([]);
    expect(harness.state.factOrder).toEqual([]);
    expect(harness.diskState()).toEqual(harness.state);
    expect(harness.state.research.rounds.W001?.editorial?.summaryMarkdown).toContain(p.statement);
    expect(harness.simLog().filter(c => c.prompt.includes(CHECK_PROMPT))).toHaveLength(1);
  });
  it("returns a weak checker's objection to the original session and checks the revised version afresh", async () => {
    const wrong = proposal({ relationToGoal: "DISPROVES", statement: "D is zero, disproving roundness.", proofMarkdown: "The recursion gives D=0 after omitting a boundary term." });
    const corrected = proposal({ resultId: "B001", parentVersionId: "B001.v1", proofMarkdown: "Include the previously omitted boundary term 10/3; the full recursion proves roundness." });
    const revision = { ...author([corrected]), responses: [{ versionId: "B001.v1", action: "REVISE", reasonMarkdown: "The objection is correct: 10/3 is a summand, not a discrepancy proving a contradiction.", objectionIds: ["A001"], replacementIndex: 0 }] };
    const harness = await start([
      call(RESEARCH_PROMPT, author([wrong]), "solver"), call(RESEARCH_PROMPT, author(), "explorer"),
      call(CHECK_PROMPT, { assessment: assess(wrong, "B001.v1", "QUARANTINE") }, "bad-check"),
      call(REPAIR_PROMPT, revision, "solver", "solver"),
      call(CHECK_PROMPT, { assessment: assess(corrected, "B001.v2") }, "new-check"),
      call(AUDIT_PROMPT, { assessments: [assess(wrong, "B001.v1", "RETRACT"), assess(corrected, "B001.v2")] }, "audit"),
      call(EDITOR_PROMPT, editorial, "editor"), call(FINAL_PROMPT, final, "writer"),
    ]);
    await harness.waitForTerminal();
    expect(harness.state.terminal?.result).toBe("PROVED");
    expect(resultStatus(harness.state.research, "B001.v1")).toBe("RETRACTED");
    expect(resultStatus(harness.state.research, "B001.v2")).toBe("AUDITED");
    const repair = harness.simLog().find(c => c.resumeOf === "solver");
    expect(repair?.prompt).toContain(REPAIR_PROMPT);
    expect(repair?.cwd).toContain("sessions/S001/packet");
    expect(harness.state.research.responses[0]?.replacementVersionId).toBe("B001.v2");
    expect(harness.diskState()).toEqual(harness.state);
    const repairId = Object.values(harness.state.research.turns).find(t => t.purpose === "repair")!.id;
    const calls = harness.simLog().length; const charged = harness.state.budget.spentTokens;
    await harness.stop();
    harness.truncateLogFrom(e => e.type === "research.updated" && e.change.kind === "turn.completed" && e.change.id === repairId);
    await harness.reload(); harness.start(); await harness.waitForTerminal();
    expect(harness.state.research.responses).toHaveLength(1);
    expect(harness.simLog()).toHaveLength(calls);
    expect(harness.state.budget.spentTokens).toBe(charged);
    expect(harness.diskState()).toEqual(harness.state);
  });
  it("allows a mathematical defense of a mistaken weak objection without a self-awarded pass", async () => {
    const p = proposal();
    const defense = { ...author(), responses: [{ versionId: "B001.v1", action: "DEFEND", reasonMarkdown: "The boundary summand is already included in equation (2), whose expansion is 1 + 10/3 - 10/3 = 1.", objectionIds: ["A001"], replacementIndex: null }] };
    const harness = await start([
      call(RESEARCH_PROMPT, author([p]), "solver"), call(RESEARCH_PROMPT, author(), "explorer"),
      call(CHECK_PROMPT, { assessment: assess(p, "B001.v1", "QUARANTINE") }, "check"),
      call(REPAIR_PROMPT, defense, "solver", "solver"),
      call(AUDIT_PROMPT, { assessments: [assess(p)] }, "audit"),
      call(EDITOR_PROMPT, editorial, "editor"), call(FINAL_PROMPT, final, "writer"),
    ]);
    await harness.waitForTerminal();
    expect(harness.state.terminal?.result).toBe("PROVED");
    expect(harness.state.research.versionOrder).toEqual(["B001.v1"]);
    expect(harness.state.research.assessments.map(a => a.assessment.verdict)).toEqual(["QUARANTINE", "CONFIRM"]);
    const auditor = Object.values(harness.state.research.sessions).find(s => s.role === "auditor")!;
    expect(harness.read(`research/sessions/${auditor.id}/packet/mathematics/argument-AR001.md`)).toContain("1 + 10/3");
    expect(harness.read(`research/sessions/${auditor.id}/packet/mathematics/B001.v1.md`)).not.toMatch(/QUARANTINE|Current qualification|S001/);
    expect(harness.simLog().filter(c => c.prompt === CHECK_PROMPT)).toHaveLength(1);
  });
  it("re-audits unchanged established versions in every later round with fresh researchers", async () => {
    const p = proposal({ relationToGoal: "PARTIAL" });
    const harness = await start([
      call(RESEARCH_PROMPT, author([p]), "solver-1"), call(RESEARCH_PROMPT, author(), "explorer-1"),
      call(CHECK_PROMPT, { assessment: assess(p) }, "check"), call(EDITOR_PROMPT, editorial, "editor-1"),
      call(AUDIT_PROMPT, { assessments: [assess(p)] }, "audit-2"),
      call(RESEARCH_PROMPT, author(), "solver-2"), call(RESEARCH_PROMPT, author(), "explorer-2"), call(EDITOR_PROMPT, editorial, "editor-2"),
      call(AUDIT_PROMPT, { assessments: [assess(p)] }, "audit-3"),
      call(RESEARCH_PROMPT, author(), "solver-3"), call(RESEARCH_PROMPT, author(), "explorer-3"), call(EDITOR_PROMPT, editorial, "editor-3"),
      call(FINAL_PROMPT, final, "writer"),
    ], 3);
    await harness.waitForTerminal();
    expect(harness.state.terminal?.result).toBe("UNCERTAIN");
    expect(harness.state.research.roundOrder).toHaveLength(3);
    expect(harness.state.research.assessments.filter(a => a.mode === "audit").map(a => a.roundId)).toEqual(["W002", "W003"]);
    const researchers = harness.simLog().filter(c => c.prompt === RESEARCH_PROMPT);
    expect(researchers).toHaveLength(6);
    expect(researchers.every(c => c.resumeOf === null)).toBe(true);
    expect(new Set(researchers.map(c => c.cwd)).size).toBe(6);
    const solver = Object.values(harness.state.research.sessions).find(s => s.roundId === "W002" && s.role === "solver")!;
    expect(harness.read(`research/sessions/${solver.id}/packet/brief.md`)).toContain("B001.v1");
    expect(harness.diskState()).toEqual(harness.state);
  });
  it("leaves an incomplete audit uncertain even after routine confirmation", async () => {
    const p = proposal();
    const harness = await start([
      call(RESEARCH_PROMPT, author([p]), "solver"), call(RESEARCH_PROMPT, author(), "explorer"),
      call(CHECK_PROMPT, { assessment: assess(p) }, "check"),
      call(AUDIT_PROMPT, { assessments: [assess(p, "B001.v1", "UNABLE")] }, "audit"),
      call(EDITOR_PROMPT, editorial, "editor"), call(FINAL_PROMPT, final, "writer"),
    ]);
    await harness.waitForTerminal();
    expect(harness.state.terminal?.result).toBe("UNCERTAIN");
    expect(auditCoverage(harness.state.research, "W001").remaining).toEqual(["B001.v1"]);
    expect(harness.state.research.final?.auditComplete).toBe(false);
  });
  it("recovers a captured return before its completion event without another model call or duplicate spend", async () => {
    const p = proposal();
    const harness = await start([
      call(RESEARCH_PROMPT, author([p]), "solver"), call(RESEARCH_PROMPT, author(), "explorer"),
      call(CHECK_PROMPT, { assessment: assess(p) }, "check"),
      call(AUDIT_PROMPT, { assessments: [assess(p)] }, "audit"),
      call(EDITOR_PROMPT, editorial, "editor"), call(FINAL_PROMPT, final, "writer"),
    ]);
    await harness.waitForTerminal(); await harness.stop();
    const spent = harness.state.budget.spentTokens;
    const calls = harness.simLog().length;
    harness.truncateLogFrom(e => e.type === "research.updated" && e.change.kind === "turn.completed" && e.change.id === "U001");
    await harness.reload(); harness.start(); await harness.waitForTerminal();
    expect(harness.simLog()).toHaveLength(calls);
    expect(harness.state.budget.spentTokens).toBe(spent);
    expect(harness.state.research.versionOrder).toEqual(["B001.v1"]);
    expect(harness.diskState()).toEqual(harness.state);
  });
  it("resumes an interrupted researcher in its saved conversation", async () => {
    const p = proposal();
    const harness = await start([
      { ...call(RESEARCH_PROMPT, author(), "solver"), behavior: "hang" },
      call(RESEARCH_PROMPT, author([p]), "solver", "solver"),
      call(RESEARCH_PROMPT, author(), "explorer"),
      call(CHECK_PROMPT, { assessment: assess(p) }, "check"),
      call(AUDIT_PROMPT, { assessments: [assess(p)] }, "audit"),
      call(EDITOR_PROMPT, editorial, "editor"), call(FINAL_PROMPT, final, "writer"),
    ]);
    await harness.waitFor(s => s.research.sessions.S001?.threadId === "solver", "saved conversation");
    await harness.stop(); await harness.reload(); harness.start(); await harness.waitForTerminal();
    expect(harness.simLog().some(c => c.resumeOf === "solver")).toBe(true);
    expect(harness.state.terminal?.result).toBe("PROVED");
    expect(harness.diskState()).toEqual(harness.state);
  });

  it("runs a strong round-two audit in parallel and serializes repair of an old result with the current Solver", async () => {
    const p = proposal({ relationToGoal: "PARTIAL" });
    const harness = await start([
      call(RESEARCH_PROMPT, author([p]), "solver-1"), call(RESEARCH_PROMPT, author(), "explorer-1"),
      call(CHECK_PROMPT, { assessment: assess(p) }, "check"), call(EDITOR_PROMPT, editorial, "editor-1"),
      { ...call(AUDIT_PROMPT, { assessments: [assess(p, "B001.v1", "QUARANTINE")] }, "audit-2"), delayMs: 50 },
      { ...call(RESEARCH_PROMPT, author(), "solver-2"), delayMs: 150 },
      { ...call(RESEARCH_PROMPT, author(), "explorer-2"), delayMs: 150 },
      call(REPAIR_PROMPT, { ...author(), responses: [{ versionId: "B001.v1", action: "WITHDRAW", reasonMarkdown: "The original derivation omits the boundary summand, so I withdraw this version.", objectionIds: ["A002"], replacementIndex: null }] }, "solver-1", "solver-1"),
      call(EDITOR_PROMPT, editorial, "editor-2"), call(FINAL_PROMPT, final, "writer"),
    ], 2, 4);
    await harness.waitForTerminal();
    expect(resultStatus(harness.state.research, "B001.v1")).toBe("RETRACTED");
    const events = harness.eventsOfType("research.updated");
    const session = Object.values(harness.state.research.sessions).find(s => s.role === "solver" && s.roundId === "W002")!;
    const currentTurn = session.turnIds[0]!;
    const repairAt = events.findIndex(e => e.change.kind === "turn.opened" && e.change.purpose === "repair");
    const finishedAt = events.findIndex(e => e.change.kind === "turn.completed" && e.change.id === currentTurn);
    expect(repairAt).toBeGreaterThan(finishedAt);
    const auditAt = events.findIndex(e => e.change.kind === "turn.opened" && e.change.purpose === "audit");
    expect(auditAt).toBeLessThan(finishedAt);
    expect(harness.simLog().find(c => c.prompt === REPAIR_PROMPT)?.resumeOf).toBe("solver-1");
    expect(harness.diskState()).toEqual(harness.state);
  });
  it("continues after a decisive report with fresh rounds and keeps new model choices pinned per round", async () => {
    const p = proposal();
    const harness = await start([
      call(RESEARCH_PROMPT, author([p]), "solver-1"), call(RESEARCH_PROMPT, author(), "explorer-1"),
      call(CHECK_PROMPT, { assessment: assess(p) }, "check"), call(AUDIT_PROMPT, { assessments: [assess(p)] }, "audit-1"),
      call(EDITOR_PROMPT, editorial, "editor-1"), call(FINAL_PROMPT, final, "writer-1"),
      call(AUDIT_PROMPT, { assessments: [assess(p)] }, "audit-2"),
      call(RESEARCH_PROMPT, author(), "solver-2"), call(RESEARCH_PROMPT, author(), "explorer-2"),
      call(EDITOR_PROMPT, editorial, "editor-2"), call(FINAL_PROMPT, final, "writer-2"),
    ]);
    await harness.waitForTerminal();
    harness.engine.setProjectSettings({ ...harness.engine.getProjectSettings(), researchModels: { research: { model: "new-research", effort: "max" }, support: { model: "new-support", effort: "high" } } });
    expect(harness.state.config.researchModels?.research.model).toBe("new-research");
    harness.engine.continueResearch("Check a wider family without weakening the original hypotheses.", 1_000_000, 1);
    await harness.waitFor(s => s.research.roundOrder.length === 2 && s.terminal !== null, "renewed stopping report");
    const solver = Object.values(harness.state.research.sessions).find(s => s.role === "solver" && s.roundId === "W002")!;
    expect(solver.model.model).toBe("new-research");
    expect(harness.state.research.rounds.W001!.researchModel.model).not.toBe("new-research");
    expect(harness.read(`research/sessions/${solver.id}/packet/owner-guidance.md`)).toContain("Check a wider family");
    expect(harness.state.terminalHistory).toHaveLength(2);
    expect(harness.diskState()).toEqual(harness.state);
  });

  it("captures every saved mathematical note immutably and rejects symlink escapes", async () => {
    const harness = await start([{ ...call(RESEARCH_PROMPT, author(), "solver"), behavior: "hang" }]);
    await harness.waitFor(s => s.research.sessions.S001?.threadId === "solver", "active author");
    const root = path.join(harness.paths.dir, "research/sessions/S001/packet/notes");
    mkdirSync(path.join(root, "drafts"), { recursive: true });
    writeFileSync(path.join(root, "drafts/first.md"), "An unsuccessful but useful calculation.");
    writeFileSync(path.join(root, "second.md"), "The full boundary summation.");
    const first = harness.engine.recurrent.snapshotNotes("S001", "W001");
    expect(first).toHaveLength(2);
    expect(harness.engine.recurrent.snapshotNotes("S001", "W001")).toEqual(first);
    writeFileSync(path.join(root, "second.md"), "The corrected full boundary summation.");
    harness.engine.recurrent.snapshotNotes("S001", "W001");
    expect(Object.values(harness.state.research.notes)).toHaveLength(3);
    expect(Object.values(harness.state.research.notes).some(n => n.markdown === "The full boundary summation.")).toBe(true);
    symlinkSync(path.join(harness.paths.dir, "project.json"), path.join(root, "outside.md"));
    expect(() => harness.engine.recurrent.snapshotNotes("S001", "W001")).toThrow("symbolic link");
    expect(harness.diskState()).toEqual(harness.state);
  });

  it("keeps fractional percentage reserves from breaking a small integer allowance", async () => {
    const harness = await start([call(EDITOR_PROMPT, editorial, "editor"), call(FINAL_PROMPT, final, "writer")], 1, 1, 100_001);
    await harness.waitForTerminal();
    expect(harness.state.terminal?.result).toBe("UNCERTAIN");
    expect(harness.simLog().some(c => c.prompt === RESEARCH_PROMPT)).toBe(false);
    expect(Object.values(harness.state.research.turns).every(t => Number.isInteger(t.budgetTokens))).toBe(true);
    expect(harness.state.budget.spentTokens + harness.state.budget.plannerSpentTokens).toBeLessThan(100_001);
  });

});
