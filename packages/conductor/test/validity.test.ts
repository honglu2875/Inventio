import { factIsSettled } from "@inventio/schema";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerPool } from "../src/engine/pool.js";
import { FileMemoryBackend } from "../src/memory/cardStore.js";
import { buildApp } from "../src/server/http.js";
import { EngineManager } from "../src/server/manager.js";
import { buildProjectExportSnapshot } from "../src/server/projectExport.js";
import {
  CLAIM_COMPARISON_MATCH,
  Harness, INTAKE_MATCH,
  SIM_BIN,
  SUMMARY_REVIEW_MATCH,
  TRAJECTORY_FINAL_MATCH, TRAJECTORY_WORKER_MATCH, VERIFICATION_MATCH,
  finalOutput,
  intakeOutput, plannerCall,
  summaryRevisionOutput,
  trajectoryOutput, trajectoryTestConfig,
  verificationOutput,
  type SimCall,
} from "./helpers/harness.js";

let current: Harness | null = null;
afterEach(async () => {
  if (current) await current.stop();
  current = null;
  delete process.env.INVENTIO_SIM_SCENARIO;
  delete process.env.INVENTIO_SIM_STATE_DIR;
});

const verification = (id: string, verdict: "PASS" | "FAIL", missing = false): SimCall => ({
  ...plannerCall(VERIFICATION_MATCH, verificationOutput(verdict, missing ? "An imported summand has not been derived." : "The calculation is verified.", missing ? "MISSING_DEPENDENCY" : verdict === "PASS" ? "NONE" : "PROOF_GAP")),
  match: { promptContains: VERIFICATION_MATCH, cwdContains: `/${id}/` },
});

describe("conflicting mathematical evidence", () => {
  it("keeps an accepted calculation unsettled when the competing proof needs revision, without extra calls", async () => {
    const claims = [
      { title: "Nonzero residual", statementMarkdown: "The normalized residual equals 10/3 and the widget is not round.", proofMarkdown: "Contract the displayed tensors and sum the boundary contributions. The residual is ten thirds, giving the claimed obstruction.", relationToGoal: "DISPROVES" as const },
      { title: "Vanishing residual", statementMarkdown: "The same normalized residual vanishes.", proofMarkdown: "Include all terms in the topological recursion relation. Their sum cancels the earlier residual.", relationToGoal: "PARTIAL" as const },
    ];
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(TRAJECTORY_WORKER_MATCH, trajectoryOutput({ claims })),
      plannerCall(CLAIM_COMPARISON_MATCH, {
        equivalentClaimGroups: [], conflicts: [
          { leftClaimId: "K001", rightClaimId: "K002", reason: "The same residual is asserted to equal both 10/3 and zero." },
        ]
      }),
      verification("V001", "PASS"), verification("V002", "PASS"),
      verification("V003", "FAIL", true), verification("V004", "PASS"),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(TRAJECTORY_FINAL_MATCH, finalOutput("# Report\n\nThe two residual calculations remain unreconciled.")),
    ];
    const h = Harness.create("conflicting-residual", calls, trajectoryTestConfig());
    current = h;
    h.start();
    await h.waitFor(s => s.phase === "AWAITING_CONFIRMATION", "intake");
    h.confirm();
    await h.waitForTerminal();
    expect(h.state.claims.K001!.status).toBe("VERIFIED");
    expect(h.state.claims.K002!.status).toBe("NEEDS_REVISION");
    expect(h.state.claimConflicts).toHaveLength(1);
    expect(h.state.terminal!.result).toBe("UNCERTAIN");
    expect(factIsSettled(h.state, "F001")).toBe(false);
    expect(h.simLog()).toHaveLength(calls.length);
    const finalDecision = Object.values(h.state.decisions).find(d => d.kind === "final")!;
    expect(h.read(`decisions/${finalDecision.id}/packet/verified-results.md`)).not.toContain("10/3");
    expect(h.read(`decisions/${finalDecision.id}/packet/unsettled-warnings.md`)).toContain("K002");
    const backend = new FileMemoryBackend(h.engine.paths.dir, () => undefined, {
      getState: () => h.state, recordMilestone: () => ({ milestoneId: "unused" }), flagFact: () => ({ correctionClaimId: "unused" }),
    });
    expect(backend.openKnowledge(["F001"])[0]!.status).toBe("UNSETTLED");
    expect(backend.openKnowledge(["F001"])[0]!.markdown).toContain("10/3 and zero");
    expect(h.diskState()).toEqual(h.state);
    await h.stop();
    const manager = new EngineManager({ root: h.root, codexBin: SIM_BIN, pool: new WorkerPool(1), memoryService: null });
    manager.openAll();
    const app = buildApp(manager, { uiDir: null });
    try {
      const url = `/api/projects/${h.slug}/claim-conflicts/resolve`;
      expect((await app.inject({ method: "POST", url, payload: { leftClaimId: "K001", rightClaimId: "K002", reason: "" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url, payload: { leftClaimId: "K002", rightClaimId: "K001", reason: "The owner reconciled the two TRR formulas under their stated conventions." } })).statusCode).toBe(200);
      expect(factIsSettled(manager.require(h.slug).state, "F001")).toBe(true);
      expect(manager.require(h.slug).state.terminal!.result).toBe("UNCERTAIN");
    } finally { await app.close(); await manager.shutdown(); }
  });
  it.each(["computation", "derivation"] as const)("checks the declared %s basis against failed commands without a new model call", async (basis) => {
    const output = verificationOutput("PASS");
    output.evidence = { basis, supportingCommands: basis === "computation" ? ["python scratch/check.py"] : [] };
    const failedCommand = { id: "item_0", type: "command_execution", command: "python scratch/check.py", aggregated_output: "", exit_code: 1, status: "failed" };
    const calls = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(TRAJECTORY_WORKER_MATCH, trajectoryOutput({ claims: [{ title: "Roundness", statementMarkdown: "The widget is round.", proofMarkdown: "The defining curvature identity and the rigidity theorem imply that the widget is round.", relationToGoal: "PROVES" }] })),
      plannerCall(VERIFICATION_MATCH, output, { items: [failedCommand] }),
      plannerCall(VERIFICATION_MATCH, verificationOutput("PASS")),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(TRAJECTORY_FINAL_MATCH, finalOutput("# Report\n\nThe record retains the proof and its evidence.")),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(TRAJECTORY_FINAL_MATCH, finalOutput("# Report\n\nThe recovered verification retains its evidence.")),
    ];
    const h = Harness.create(`execution-${basis}`, calls, trajectoryTestConfig());
    current = h;
    h.start();
    await h.waitFor(state => state.phase === "AWAITING_CONFIRMATION", "intake");
    h.confirm();
    await h.waitForTerminal();
    expect(h.state.verifications.V001!.executionEvidence).toMatchObject({ failed: 1, supportValidated: basis === "derivation", declaredVerdict: "PASS" });
    expect(h.state.verifications.V001!.verdict).toBe(basis === "derivation" ? "PASS" : "FAIL");
    expect(h.state.claims.K001!.status).toBe(basis === "derivation" ? "VERIFIED" : "NEEDS_REVISION");
    expect(h.state.terminal!.result).toBe(basis === "derivation" ? "PROVED" : "UNCERTAIN");
    expect(JSON.parse(h.read("verifications/V001/output.json")).verdict).toBe("PASS");
    expect(h.simLog()).toHaveLength(calls.length - 2);
    const snapshot = buildProjectExportSnapshot(h.engine);
    expect(snapshot.verificationEvidence?.V001?.included).toBe(true);
    expect(h.diskState()).toEqual(h.state);
    // Crash before or after the evidence event, but before completion. The
    // authentic output and parent-owned archive already exist on disk.
    const cut = h.engine.events.find(event => event.type === (basis === "computation" ? "verification.evidenceRecorded" : "verification.completed"))!.seq;
    const prefix = h.engine.events.filter(event => event.seq < cut);
    await h.stop();
    writeFileSync(h.engine.paths.eventsFile, prefix.map(event => JSON.stringify(event)).join("\n") + "\n");
    await h.reload();
    h.start();
    await h.waitForTerminal();
    expect(h.state.verifications.V001!.verdict).toBe(basis === "derivation" ? "PASS" : "FAIL");
    expect(h.engine.events.filter(event => event.type === "verification.evidenceRecorded" && event.verificationId === "V001")).toHaveLength(1);
    expect(h.simLog().filter(call => call.prompt.includes(VERIFICATION_MATCH))).toHaveLength(2);
    expect(h.simLog()).toHaveLength(calls.length);
    expect(h.diskState()).toEqual(h.state);
    if (basis === "computation") {
      await h.stop();
      const manager = new EngineManager({ root: h.root, codexBin: SIM_BIN, pool: new WorkerPool(1), memoryService: null });
      manager.openAll();
      const app = buildApp(manager, { uiDir: null });
      try {
        const url = `/api/projects/${h.slug}/verifications/V001/evidence`;
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(200);
        expect(response.json().commands[0].status).toBe("FAILED");
        const evidenceFile = path.join(h.engine.paths.dir, "verifications/V001/execution-evidence.json");
        const original = h.read("verifications/V001/execution-evidence.json");
        writeFileSync(evidenceFile, original + " ");
        expect((await app.inject({ method: "GET", url })).statusCode).toBe(409);
        writeFileSync(evidenceFile, original);
      } finally { await app.close(); await manager.shutdown(); }
    }
  });

  it("records fact dependencies and withdraws their use when a premise is refuted", async () => {
    const base = { title: "Curvature", statementMarkdown: "The defining curvature is constant.", proofMarkdown: "The defining identity gives a constant curvature tensor.", relationToGoal: "PARTIAL" as const };
    const dependent = { title: "Roundness", statementMarkdown: "The widget is round.", proofMarkdown: "Constant curvature and the rigidity identity imply roundness.", relationToGoal: "PROVES" as const, dependsOnFactIds: ["F001"] };
    const calls = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(TRAJECTORY_WORKER_MATCH, trajectoryOutput({ claims: [base] })),
      verification("V001", "PASS"), verification("V002", "PASS"),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(TRAJECTORY_WORKER_MATCH, trajectoryOutput({ claims: [dependent] })),
      plannerCall(CLAIM_COMPARISON_MATCH, { equivalentClaimGroups: [], conflicts: [] }),
      verification("V003", "PASS"), verification("V004", "PASS"),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(TRAJECTORY_FINAL_MATCH, finalOutput("# Report\n\nThe curvature criterion proves roundness.")),
    ];
    const h = Harness.create("fact-dependencies", calls, trajectoryTestConfig(c => { c.limits.maxWaves = 2; }));
    current = h;
    h.start();
    await h.waitFor(state => state.phase === "AWAITING_CONFIRMATION", "intake");
    h.confirm();
    await h.waitForTerminal();
    expect(h.state.claims.K002!.dependsOn).toEqual(["F001"]);
    expect(h.state.terminal!.result).toBe("PROVED");
    expect(factIsSettled(h.state, "F002")).toBe(true);
    h.engine.humanClaimStatus("K001", "REFUTED", "The owner found a counterexample to the curvature premise.");
    expect(factIsSettled(h.state, "F001")).toBe(false);
    expect(factIsSettled(h.state, "F002")).toBe(false);
    expect(h.state.terminal!.result).toBe("PROVED"); // the saved stopping report remains historical
    expect(h.diskState()).toEqual(h.state);
  });

  it.each(["unknown claim", "inconsistent identity"])("stops uncertain on a comparison with %s and retries only after explicit continuation", async (failure) => {
    const claims = [
      { title: "Roundness", statementMarkdown: "The scalar A is zero.", proofMarkdown: "The rigidity identity establishes roundness from the defining curvature tensor.", relationToGoal: "PROVES" as const },
      { title: "Curvature", statementMarkdown: "The scalar a is zero.", proofMarkdown: "Contraction of the defining tensor gives a constant squared norm.", relationToGoal: "PARTIAL" as const },
    ];
    const calls = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(TRAJECTORY_WORKER_MATCH, trajectoryOutput({ claims })),
      plannerCall(CLAIM_COMPARISON_MATCH, failure === "unknown claim"
        ? { equivalentClaimGroups: [], conflicts: [{ leftClaimId: "K001", rightClaimId: "K999", reason: "This ID is not in the record." }] }
        : { equivalentClaimGroups: [["K001", "K002"]], conflicts: [{ leftClaimId: "K001", rightClaimId: "K002", reason: "These statements are also reported as incompatible." }] }),
      verification("V001", "PASS"), verification("V002", "PASS"), verification("V003", "PASS"), verification("V004", "PASS"),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(TRAJECTORY_FINAL_MATCH, finalOutput("# Report\n\nThe statement comparison is incomplete.")),
      plannerCall(CLAIM_COMPARISON_MATCH, { equivalentClaimGroups: [], conflicts: [] }),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(TRAJECTORY_FINAL_MATCH, finalOutput("# Report\n\nThe accepted proof establishes roundness.")),
    ];
    const h = Harness.create("comparison-unavailable", calls, trajectoryTestConfig());
    current = h;
    h.start(); await h.waitFor(state => state.phase === "AWAITING_CONFIRMATION", "intake"); h.confirm();
    await h.waitForTerminal();
    expect(h.state.waves.W001!.conflictCheck).toBe("UNAVAILABLE");
    expect(h.state.claims.K001!.equivalentIds).toEqual([]); // A and a must not collapse during deterministic deduplication.
    expect(h.state.terminal!.result).toBe("UNCERTAIN");
    expect(h.simLog().filter(call => call.prompt.includes(CLAIM_COMPARISON_MATCH))).toHaveLength(1);
    h.engine.continueResearch("Retry the statement comparison with the recorded claim identifiers.", 0, 0);
    await h.waitForTerminal();
    expect(h.state.waves.W001!.conflictCheck).toBe("COMPLETE");
    expect(h.state.terminal!.result).toBe("PROVED");
    expect(h.state.terminalHistory.map(record => record.result)).toEqual(["UNCERTAIN", "PROVED"]);
    expect(h.simLog()).toHaveLength(calls.length);
    expect(h.diskState()).toEqual(h.state);
  });

  it("keeps a challenged fact suspicious after a failed correction proof, until its statement is refuted", async () => {
    const calls = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(TRAJECTORY_WORKER_MATCH, trajectoryOutput({ claims: [{ title: "Curvature", statementMarkdown: "The curvature is constant.", proofMarkdown: "The defining identity gives a constant curvature tensor.", relationToGoal: "PARTIAL" }] })),
      verification("V001", "PASS"), verification("V002", "PASS"),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(TRAJECTORY_WORKER_MATCH, trajectoryOutput()),
      verification("V003", "FAIL"), verification("V004", "PASS"),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(TRAJECTORY_FINAL_MATCH, finalOutput("# Report\n\nThe challenge to the curvature premise remains unresolved.")),
    ];
    const h = Harness.create("failed-correction", calls, trajectoryTestConfig(c => { c.limits.maxWaves = 2; }));
    current = h;
    let flagged = false;
    h.engine.on("event", () => {
      const task = Object.values(h.state.tasks).find(task => task.waveId === "W002" && task.status === "running");
      if (flagged || !task) return;
      flagged = true;
      h.engine.flagTrajectoryFact(task.id, "F001", "An omitted boundary contribution changes the stated curvature calculation.");
    });
    h.start(); await h.waitFor(state => state.phase === "AWAITING_CONFIRMATION", "intake"); h.confirm();
    await h.waitForTerminal();
    expect(flagged).toBe(true);
    expect(h.state.claims.K002!.status).toBe("FAILED");
    expect(h.state.facts.F001!.status).toBe("SUSPICIOUS");
    expect(factIsSettled(h.state, "F001")).toBe(false);
    expect(h.state.terminal!.result).toBe("UNCERTAIN");
    h.engine.humanClaimStatus("K002", "REFUTED", "The owner derived the boundary contribution and refuted the alleged counterexample.");
    expect(h.state.facts.F001!.status).toBe("ACTIVE");
    expect(factIsSettled(h.state, "F001")).toBe(true);
    expect(h.diskState()).toEqual(h.state);
  });

});
