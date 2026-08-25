import { afterEach, describe, expect, it } from "vitest";
import type { Event, IntakeMemory } from "@inventio/schema";
import type { MemoryAccess } from "../src/engine/engine.js";
import type { TaskScope } from "../src/memory/types.js";
import {
  CURATION_MATCH,
  DECISION_MATCH,
  FINAL_MATCH,
  Harness,
  INTAKE_MATCH,
  assessResults,
  curationOutput,
  envelope,
  finalOutput,
  freezeCandidate,
  intakeOutput,
  memo,
  planWave,
  plannedTask,
  plannerCall,
  reviewerOutput,
  solverOutput,
  terminate,
  testConfig,
  USAGE,
  workerCall,
  type SimCall,
} from "./helpers/harness.js";

/**
 * M5 end-to-end verification: a real ProjectEngine driven against the
 * codex-sim fake CLI, one scripted scenario per protocol path.
 *
 * Every sim call is discriminated by prompt substring (planner modes) or by
 * the task id in the packet cwd (workers), because worker prompts are
 * identical across tasks. The pool is capped at one worker so the sim's
 * file-order consumption is deterministic.
 */

let current: Harness | null = null;

afterEach(async () => {
  if (current) {
    await current.stop();
    current = null;
  }
  delete process.env["INVENTIO_SIM_SCENARIO"];
  delete process.env["INVENTIO_SIM_STATE_DIR"];
});

function harness(name: string, calls: SimCall[], config = testConfig()): Harness {
  const h = Harness.create(name, calls, config);
  current = h;
  return h;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- shared scenario fragments ---------------------------------------------

const soloDiscovery = (budget = 200_000, reserve = 100_000) =>
  planWave({
    title: "Discovery",
    reserveTokens: reserve,
    tasks: [
      plannedTask({ role: "solver", methodTag: "direct", brief: "Attack the statement head on.", tokenBudget: budget }),
    ],
  });

const reviewWave = (candidateId: string) =>
  planWave({
    title: `Review ${candidateId}`,
    reserveTokens: 70_000,
    tasks: [
      plannedTask({
        role: "reviewer",
        methodTag: "audit-logic",
        brief: "Audit every implication in order.",
        tokenBudget: 100_000,
        reviewOf: candidateId,
        artifactIds: [candidateId],
      }),
      plannedTask({
        role: "reviewer",
        methodTag: "audit-counterexample",
        brief: "Hunt for a counterexample to the candidate.",
        tokenBudget: 100_000,
        reviewOf: candidateId,
        artifactIds: [candidateId],
      }),
    ],
  });

async function runToConfirmation(h: Harness): Promise<void> {
  h.start();
  await h.waitFor((s) => s.phase === "AWAITING_CONFIRMATION", "intake to finish");
  h.confirm();
}

// ---------------------------------------------------------------------------

describe("ProjectEngine end-to-end (codex-sim)", () => {
  it("records W000 over immutable raw intake and accepts the owner's direct edit", async () => {
    const generated = {
      ...intakeOutput("Show that the widget is round."),
      managerAbstract: "The goal is to prove roundness of the stated widget.",
      managerNoteMarkdown:
        "# Current mathematical view\n\nThe natural first reading is a direct roundness problem.",
      sourceSummaries: [{
        sourceId: "S001",
        abstract: "The owner asks for a proof that the widget is round.",
        excerptMarkdown: "**Objective.** Prove that the widget is round.",
      }],
    };
    const h = harness("w000-edit", [plannerCall(INTAKE_MATCH, generated)]);

    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "W000 preview");

    expect(h.state.problem.sources).toEqual([
      expect.objectContaining({
        id: "S001",
        kind: "objective",
        abstract: "The owner asks for a proof that the widget is round.",
      }),
    ]);
    expect(h.state.researchManagerNotes).toEqual([
      expect.objectContaining({ waveId: "W000", source: "research_manager" }),
    ]);
    expect(h.read("intake/original-objective.md")).toBe("Show that the widget is round.");
    expect(h.read("decisions/DEC001/packet/raw-materials/index.md")).toContain("S001");

    h.engine.confirmProblem(
      "Show that the widget is round.",
      undefined,
      undefined,
      "The owner has specified the intended geometric interpretation.",
      "# Current mathematical view\n\nUse the intended geometric interpretation of roundness.",
    );

    expect(h.state.researchManagerNotes).toEqual([
      expect.objectContaining({
        waveId: "W000",
        source: "human_edited",
        abstract: "The owner has specified the intended geometric interpretation.",
      }),
    ]);
    expect(h.read("artifacts/manager-notes/W000.md")).toContain("intended geometric interpretation");
  });

  it("turns human-approved intake notes into durable unverified memory", async () => {
    const generatedMemory: IntakeMemory = {
      type: "ATTEMPT-SUMMARY",
      title: "Generated reduction",
      abstract: "The submitted notes suggest a reduction.",
      content: "Try reducing the target to the boundary identity.",
      tags: ["reduction"],
    };
    const generated = {
      ...intakeOutput("# Normalized target\n\nProve the genus-2 restriction."),
      contextDigestMarkdown: "The supplied notes emphasize a boundary reduction.",
      rawMemories: [generatedMemory],
    };
    const h = harness("intake-memory", [plannerCall(INTAKE_MATCH, generated)]);

    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "intake to finish");
    expect(h.state.problem.rawMemories).toEqual([generatedMemory]);

    const editedMemory: IntakeMemory = {
      ...generatedMemory,
      title: "Human-edited reduction",
      content: "Check whether the boundary identity really implies the genus-2 restriction.",
      tags: ["genus-2", "boundary"],
    };
    h.engine.confirmProblem(
      "# Confirmed target\n\nProve the genus-2 restriction.",
      "Human-edited context digest.",
      [editedMemory],
    );

    expect(h.state.problem.contextDigestMarkdown).toBe("Human-edited context digest.");
    expect(h.state.cards["M001"]?.proposedBy).toBe("human:intake");
    expect(h.state.cards["M001"]?.status).toBe("PROPOSED");
    expect(h.state.cards["M001"]?.card.title).toBe("Human-edited reduction");
    expect(h.read("memory/intake-digest.md")).toBe("Human-edited context digest.");
    expect(h.read("memory/cards/M001.md")).toContain("status: PROPOSED");
    expect(h.read("memory/cards/M001.md")).toContain("provenance: human intake context");

    // Keep every confirmation/card event but simulate a crash immediately
    // before the final phase transition. Recovery must not duplicate M001.
    await h.stop();
    h.truncateLogFrom(
      (event) =>
        event.type === "phase.changed" &&
        event.from === "AWAITING_CONFIRMATION" &&
        event.to === "DISCOVERY",
    );
    await h.reload();
    h.start();
    await h.waitFor((state) => state.phase === "DISCOVERY", "confirmed-intake recovery");
    expect(h.state.cards["M001"]?.status).toBe("PROPOSED");
    expect(Object.keys(h.state.cards)).toEqual(["M001"]);
    expect(h.state.problem.rawMemories).toEqual([editedMemory]);
  });

  it("1. happy path: intake → wave → freeze → two PASS reviews → PROVED", async () => {
    const h = harness("happy", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall(
        "T001",
        solverOutput(
          "PROVED",
          "CONCLUSION: PROVED\n\nA complete argument.",
          memo({
            newClaims: [
              { statement: "The widget is round in the plane case.", evidence: "proved-in-artifact", where: "Lemma 2" },
            ],
            proposedCards: [
              {
                type: "LEMMA",
                title: "Planar roundness",
                content: "Full lemma text.",
                abstract: "the planar case",
                tags: ["geometry"],
                provenance: "proved in this attempt",
              },
            ],
          }),
        ),
      ),
      plannerCall(
        CURATION_MATCH,
        curationOutput({
          managerNoteMarkdown:
            "The first round reduced the problem to one planar lemma. That lemma now deserves independent review.",
          // The proposer's own new lemma may never enter VERIFIED (PROTOCOL §7).
          cardDecisions: [{ cardId: "M001", admit: true, status: "VERIFIED", reason: "the proof looks complete" }],
          claimExtractions: [
            {
              statement: "The widget is round in the plane case.",
              provenance: "attempt A001",
              fromTaskId: "T001",
              dependsOn: [],
            },
          ],
        }),
      ),
      plannerCall(DECISION_MATCH, freezeCandidate({ fromArtifactId: "A001", newLineageTitle: "Main line" })),
      plannerCall(DECISION_MATCH, reviewWave("C001.v1")),
      workerCall("T002", reviewerOutput("PASS", "VERDICT: PASS\n\nEvery step checks out.")),
      workerCall("T003", reviewerOutput("PASS", "VERDICT: PASS\n\nNo counterexample exists.")),
      plannerCall(
        CURATION_MATCH,
        curationOutput(
          {
            managerNoteMarkdown:
              "The candidate has survived two independent reviews, so the complete argument is established.",
          },
          ["T002", "T003"],
        ),
      ),
      plannerCall(FINAL_MATCH, finalOutput("# Final report\n\nThe widget is round.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    expect(h.state.terminal).toEqual({ result: "PROVED", finalPath: "artifacts/final.md" });
    expect(h.state.phase).toBe("TERMINAL");
    expect(h.read("artifacts/final.md").startsWith("RESULT: PROVED\n")).toBe(true);

    // Protocol shape
    expect(h.state.waveOrder).toEqual(["W001", "W002"]);
    expect(Object.keys(h.state.candidates)).toEqual(["C001.v1"]);
    expect(h.state.candidates["C001.v1"]!.acceptance).toEqual({ passed: true, failing: [] });
    expect(h.state.candidates["C001.v1"]!.reviewIds).toEqual(["R001", "R002"]);
    expect(Object.values(h.state.tasks).map((t) => t.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(h.state.artifacts["A001"]!.conclusion).toBe("PROVED");

    // Curation materialization (DESIGN §6.3 / §9.4)
    expect(h.state.claimOrder).toEqual(["K001"]);
    expect(h.state.claims["K001"]!.status).toBe("UNVERIFIED");
    expect(h.state.claims["K001"]!.provenance).toContain("(from T001)");
    // A proposer's own new lemma cannot be admitted VERIFIED.
    expect(h.state.cards["M001"]!.status).toBe("PROPOSED");
    expect(h.state.cards["M001"]!.admissionReason).toMatch(/kept PROPOSED because VERIFIED requires independent evidence/);
    expect(h.read("memory/cards/M001.md")).toContain("status: PROPOSED");
    expect(h.state.waves["W001"]!.resolutionPath).toBe("artifacts/resolutions/W001.md");
    expect(h.read("artifacts/resolutions/W001.md")).toContain("# Resolution");
    expect(h.read("memory/capsules/solver.md")).toBe("solver capsule");
    expect(h.read("digest.md")).toContain("# Digest");
    expect(h.state.researchManagerNotes).toHaveLength(3);
    expect(h.state.researchManagerNotes.map((note) => note.waveId)).toEqual(["W000", "W001", "W002"]);
    expect(h.state.researchManagerNotes[2]?.markdown).toContain("survived two independent reviews");
    expect(h.read("artifacts/manager-notes/W001.md")).toContain("reduced the problem");
    expect(h.read("artifacts/manager-notes/W002.md")).toContain("complete argument is established");
    expect(h.read("decisions/DEC004/packet/research-manager-current-view.md")).toContain(
      "planar lemma",
    );
    expect(h.read("decisions/DEC007/packet/research-manager-current-view.md")).toContain(
      "survived two independent reviews",
    );

    // Packet jail (DESIGN §7): the solver saw no ledger; the reviewer saw the
    // frozen candidate, the ledger extract and the reviewer capsule.
    const solverPacket = h.state.tasks["T001"]!.packetManifest;
    expect(solverPacket).toContain("AGENTS.md");
    expect(solverPacket).toContain("problem.md");
    expect(solverPacket).toContain("research-question.md");
    expect(solverPacket).not.toContain("references/relevant-claims.md");
    const reviewerPacket = h.state.tasks["T002"]!.packetManifest;
    expect(reviewerPacket).toContain("references/write-ups/C001.v1.md");
    expect(reviewerPacket).toContain("references/relevant-claims.md");
    expect(reviewerPacket).toContain("research-notes.md");
    expect(h.read("tasks/T002/packet/references/relevant-claims.md")).toContain("K001");
    // Never another review or the attempt history.
    expect(reviewerPacket.some((f) => f.includes("A001") || f.includes("R00"))).toBe(false);

    // Budget arithmetic (DESIGN §6.5): 3 worker calls, 7 planner calls.
    expect(h.state.budget.spentTokens).toBe(3 * 1100);
    expect(h.state.budget.plannerSpentTokens).toBe(7 * 1100);

    // Replay from disk reproduces the identical state (DESIGN §5).
    await h.stop();
    expect(h.diskState()).toEqual(h.state);
  }, 30_000);

  it("2. repair loop: FAIL review → repair wave → v2 → PROVED", async () => {
    const h = harness("repair", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", solverOutput("PROVED", "CONCLUSION: PROVED\n\nFirst argument.")),
      plannerCall(
        CURATION_MATCH,
        curationOutput({
          claimExtractions: [
            { statement: "The key bound holds.", provenance: "attempt A001", fromTaskId: "T001", dependsOn: [] },
          ],
        }),
      ),
      plannerCall(
        DECISION_MATCH,
        freezeCandidate({ fromArtifactId: "A001", newLineageTitle: "Main line", usedClaimIds: ["K001"] }),
      ),
      plannerCall(DECISION_MATCH, reviewWave("C001.v1")),
      workerCall("T002", reviewerOutput("PASS", "VERDICT: PASS\n\nLooks sound to me.")),
      workerCall(
        "T003",
        reviewerOutput(
          "FAIL",
          "VERDICT: FAIL\n\nStep 3 is unjustified.",
          memo({
            summary: "the bound in step 3 is asserted, not proved",
            issues: [
              {
                severity: "CRITICAL",
                location: "Step 3",
                summary: "the key bound is asserted without proof",
                repairHint: "prove the bound or weaken the conclusion",
              },
            ],
          }),
        ),
      ),
      plannerCall(CURATION_MATCH, curationOutput({}, ["T002", "T003"])),
      plannerCall(
        DECISION_MATCH,
        planWave({
          title: "Repair step 3",
          reserveTokens: 100_000,
          tasks: [
            plannedTask({
              role: "solver",
              methodTag: "repair-step3",
              brief: "Close the gap at step 3 of the frozen candidate.",
              tokenBudget: 200_000,
              artifactIds: ["C001.v1"],
            }),
          ],
        }),
      ),
      workerCall("T004", solverOutput("PROVED", "CONCLUSION: PROVED\n\nSecond argument, step 3 proved.")),
      plannerCall(CURATION_MATCH, curationOutput({}, ["T004"])),
      plannerCall(DECISION_MATCH, freezeCandidate({ fromArtifactId: "A002", lineageId: "C001" })),
      plannerCall(DECISION_MATCH, reviewWave("C001.v2")),
      workerCall("T005", reviewerOutput("PASS", "VERDICT: PASS\n\nStep 3 is now proved.")),
      workerCall("T006", reviewerOutput("PASS", "VERDICT: PASS\n\nNo counterexample.")),
      plannerCall(CURATION_MATCH, curationOutput({}, ["T005", "T006"])),
      plannerCall(FINAL_MATCH, finalOutput("# Final report\n\nThe repaired argument holds.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal(28_000);

    expect(h.state.terminal!.result).toBe("PROVED");

    // v1 collected the CRITICAL issue and failed acceptance; the issue stays
    // open because it is attached to v1, not to the repaired v2.
    const v1 = h.state.candidates["C001.v1"]!;
    const v2 = h.state.candidates["C001.v2"]!;
    expect(v1.issueIds).toEqual(["I001"]);
    expect(h.state.issues["I001"]!.status).toBe("open");
    expect(h.state.issues["I001"]!.severity).toBe("CRITICAL");
    expect(v1.acceptance!.passed).toBe(false);
    expect(v1.acceptance!.failing.join(" ")).toMatch(/open CRITICAL issue I001/);
    expect(v1.acceptance!.failing.join(" ")).toMatch(/FAIL review/);
    // A candidate leaning on an UNVERIFIED ledger claim cannot be accepted.
    expect(v1.usedClaimIds).toEqual(["K001"]);
    expect(v1.acceptance!.failing.join(" ")).toMatch(/used claim K001 is UNVERIFIED/);

    expect(v2.version).toBe(2);
    expect(v2.issueIds).toEqual([]);
    expect(v2.acceptance).toEqual({ passed: true, failing: [] });
    expect(h.state.lineages["C001"]!.versionIds).toEqual(["C001.v1", "C001.v2"]);
    expect(h.state.waveOrder).toEqual(["W001", "W002", "W003", "W004"]);

    // Repair wave ran in REPAIR phase while v1 had an open issue.
    const repairPhase = h
      .eventsOfType("phase.changed")
      .find((e) => e.reason === "wave W003 planned");
    expect(repairPhase?.to).toBe("REPAIR");
  }, 30_000);

  it("3. terminate yields UNCERTAIN and the conductor stamps RESULT itself", async () => {
    const h = harness("uncertain", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", solverOutput("UNCERTAIN", "CONCLUSION: UNCERTAIN\n\nPartial progress only.")),
      plannerCall(CURATION_MATCH, curationOutput()),
      plannerCall(DECISION_MATCH, terminate("no productive direction remains")),
      // The model deviously stamps its own (wrong) RESULT line.
      plannerCall(FINAL_MATCH, finalOutput("RESULT: PROVED\n\nEverything is fine, trust me.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    expect(h.state.terminal!.result).toBe("UNCERTAIN");
    const final = h.read("artifacts/final.md");
    expect(final.startsWith("RESULT: UNCERTAIN\n")).toBe(true);
    expect(final).not.toContain("RESULT: PROVED");
    expect(final).toContain("Everything is fine, trust me.");
    expect(h.state.artifacts["final"]!.conclusion).toBe("UNCERTAIN");
  }, 30_000);

  it("3a. Manager calls can inspect project memory and raw intake sources", async () => {
    const minted: TaskScope[] = [];
    const revoked: string[] = [];
    const memory: MemoryAccess = {
      url: "http://127.0.0.1:65530/mcp",
      mintToken: (scope) => {
        minted.push(scope);
        return "manager-token-" + minted.length;
      },
      revokeToken: (token) => revoked.push(token),
    };
    const h = Harness.create(
      "manager-memory",
      [
        plannerCall(INTAKE_MATCH, intakeOutput()),
        plannerCall(DECISION_MATCH, terminate("the bounded test is complete")),
        plannerCall(FINAL_MATCH, finalOutput("# Final\n\nNo claim was established.")),
      ],
      testConfig(),
      memory,
    );
    current = h;

    await runToConfirmation(h);
    await h.waitForTerminal();

    expect(minted).toEqual([
      expect.objectContaining({ taskId: "DEC001", role: "research_manager" }),
      expect.objectContaining({ taskId: "DEC002", role: "research_manager" }),
      expect.objectContaining({ taskId: "DEC003", role: "research_manager" }),
    ]);
    expect(revoked).toEqual(["manager-token-1", "manager-token-2", "manager-token-3"]);
    const calls = h.simLog();
    expect(calls[0]?.taskToken).toBe("manager-token-1");
    expect(calls[1]?.taskToken).toBe("manager-token-2");
    expect(calls[2]?.taskToken).toBe("manager-token-3");
    expect(calls[1]?.argv).toEqual(expect.arrayContaining(["gpt-5.6-sol"]));
    expect(calls[2]?.argv).toEqual(expect.arrayContaining(["gpt-5.6-sol"]));
  });

  it("3b. synthesis uses the smaller rigorous-assembly model by default", async () => {
    const h = harness("synthesis-model", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(
        DECISION_MATCH,
        planWave({
          title: "Assemble the available reduction",
          reserveTokens: 100_000,
          tasks: [
            plannedTask({
              role: "synthesizer",
              methodTag: "assemble-reduction",
              brief: "Assemble the supplied ingredients without adding a new premise.",
              tokenBudget: 200_000,
            }),
          ],
        }),
      ),
      workerCall(
        "T001",
        solverOutput(
          "UNCERTAIN",
          "CONCLUSION: UNCERTAIN\n\nThe supplied ingredients leave one exact implication open.",
        ),
      ),
      plannerCall(CURATION_MATCH, curationOutput()),
      plannerCall(DECISION_MATCH, terminate("the missing implication needs new mathematics")),
      plannerCall(FINAL_MATCH, finalOutput("# Final\n\nThe assembly exposed one exact gap.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    const call = h.simLog().find((row) => row.cwd.includes("/T001/"));
    expect(call?.argv).toEqual(expect.arrayContaining(["gpt-5.6-terra"]));
    expect(h.state.tasks["T001"]?.role).toBe("synthesizer");
  });

  it("3c. changed project settings reach subsequent Manager and worker processes", async () => {
    const h = harness("worker-model-settings", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", solverOutput("UNCERTAIN", "CONCLUSION: UNCERTAIN\n\nThe direct argument remains incomplete.")),
      plannerCall(CURATION_MATCH, curationOutput()),
      plannerCall(DECISION_MATCH, terminate("the direct argument exposed a precise remaining gap")),
      plannerCall(FINAL_MATCH, finalOutput("# Final\n\nThe direct argument remains incomplete.")),
    ]);

    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "intake to finish");
    h.engine.setModelSettings({
      researchManager: { model: "gpt-5.5", effort: "xhigh" },
      solver: { model: "gpt-5.6-sol", effort: "max" },
      explorer: { model: null, effort: "medium" },
      reviewer: { model: null, effort: "high" },
      synthesizer: { model: "gpt-5.6-terra", effort: "high" },
    });
    h.confirm();
    await h.waitForTerminal();

    const calls = h.simLog();
    const managerCalls = calls.slice(1).filter((row) => row.cwd.includes("/decisions/"));
    expect(managerCalls.length).toBeGreaterThan(0);
    for (const call of managerCalls) {
      expect(call.argv).toEqual(expect.arrayContaining(["-m", "gpt-5.5", 'model_reasoning_effort="xhigh"']));
    }
    const call = calls.find((row) => row.cwd.includes("/T001/"));
    expect(call?.argv).toEqual(expect.arrayContaining(["-m", "gpt-5.6-sol", 'model_reasoning_effort="max"']));
    const meta = JSON.parse(h.read("tasks/T001/meta.json")) as { model: string | null; effort: string };
    expect(meta).toMatchObject({ model: "gpt-5.6-sol", effort: "max" });
  }, 30_000);

  it("3d. Web search is granted per assignment only when the project permits it", async () => {
    const h = harness(
      "worker-web-search",
      [
        plannerCall(INTAKE_MATCH, intakeOutput()),
        plannerCall(
          DECISION_MATCH,
          planWave({
            title: "Compare two approaches",
            reserveTokens: 100_000,
            tasks: [
              plannedTask({
                role: "explorer",
                methodTag: "literature",
                brief: "Check the relevant literature.",
                tokenBudget: 150_000,
                webSearch: true,
              }),
              plannedTask({
                role: "solver",
                methodTag: "direct",
                brief: "Try a self-contained proof.",
                tokenBudget: 150_000,
                webSearch: false,
              }),
            ],
          }),
        ),
        workerCall(
          "T001",
          solverOutput("UNCERTAIN", "CONCLUSION: UNCERTAIN\n\nThe literature search found a related theorem."),
        ),
        workerCall(
          "T002",
          solverOutput("UNCERTAIN", "CONCLUSION: UNCERTAIN\n\nThe direct proof leaves one gap."),
        ),
        plannerCall(CURATION_MATCH, curationOutput({}, ["T001", "T002"])),
        plannerCall(DECISION_MATCH, terminate("both approaches leave a precise gap")),
        plannerCall(FINAL_MATCH, finalOutput("# Final\n\nTwo approaches were assessed.")),
      ],
      testConfig((config) => {
        config.allowWebSearch = true;
      }),
    );

    await runToConfirmation(h);
    await h.waitForTerminal();

    const calls = h.simLog();
    const online = calls.find((row) => row.cwd.includes("/T001/"));
    const offline = calls.find((row) => row.cwd.includes("/T002/"));
    expect(online?.argv).toEqual(expect.arrayContaining(["tools.web_search=true"]));
    expect(offline?.argv).not.toEqual(expect.arrayContaining(["tools.web_search=true"]));
    expect(h.read("tasks/T001/packet/AGENTS.md")).toContain("You have web search");
    expect(h.read("tasks/T002/packet/AGENTS.md")).not.toContain("You have web search");
  }, 30_000);

  it("3e. disabling Web search before a gated assignment launches revokes the queued grant", async () => {
    const h = harness(
      "queued-web-search-revocation",
      [
        plannerCall(INTAKE_MATCH, intakeOutput()),
        plannerCall(
          DECISION_MATCH,
          planWave({
            title: "Literature check",
            reserveTokens: 100_000,
            tasks: [
              plannedTask({
                role: "explorer",
                methodTag: "literature",
                brief: "Check whether the needed theorem is known.",
                tokenBudget: 150_000,
                webSearch: true,
              }),
            ],
          }),
        ),
        workerCall(
          "T001",
          solverOutput("UNCERTAIN", "CONCLUSION: UNCERTAIN\n\nNo external search was available."),
        ),
        plannerCall(CURATION_MATCH, curationOutput()),
        plannerCall(DECISION_MATCH, terminate("the offline check is complete")),
        plannerCall(FINAL_MATCH, finalOutput("# Final\n\nThe assignment remained offline.")),
      ],
      testConfig((config) => {
        config.autonomy = "gated";
        config.allowWebSearch = true;
      }),
    );

    await runToConfirmation(h);
    const gate = (await h.waitForEvent((event) => event.type === "gate.opened", "the Web-search gate")) as Extract<
      Event,
      { type: "gate.opened" }
    >;
    h.engine.setWebSearch(false);
    autoResolveGates(h);
    h.engine.resolveGate(gate.decisionId, "approve");
    await h.waitForTerminal();

    const call = h.simLog().find((row) => row.cwd.includes("/T001/"));
    expect(call?.argv).not.toEqual(expect.arrayContaining(["tools.web_search=true"]));
    expect(h.read("tasks/T001/packet/AGENTS.md")).not.toContain("You have web search");
    expect(h.state.config.allowWebSearch).toBe(false);
  }, 30_000);

  it("3f. continuing research preserves the first report and reaches a new checkpoint", async () => {
    const h = harness("continue-research", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, terminate("the first pass found no productive direction")),
      plannerCall(FINAL_MATCH, finalOutput("# First checkpoint\n\nNo useful reduction was found yet.")),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall(
        "T001",
        solverOutput("UNCERTAIN", "CONCLUSION: UNCERTAIN\n\nA local lemma remains plausible."),
      ),
      plannerCall(CURATION_MATCH, curationOutput()),
      plannerCall(DECISION_MATCH, terminate("the focused continuation produced a partial result")),
      plannerCall(FINAL_MATCH, finalOutput("# Second checkpoint\n\nThe local lemma is the strongest surviving lead.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    const originalTotal = h.state.config.budget.totalTokens;
    const originalMaxWaves = h.state.config.limits.maxWaves;
    const firstPath = h.state.terminal!.finalPath;
    const firstText = h.read(firstPath);
    expect(firstPath).toBe("artifacts/final.md");

    h.engine.continueResearch("Push the local lemma instead of repeating the global attack.", 200_000, 3);

    expect(h.state.terminal).toBeNull();
    expect(h.state.phase).toBe("DISCOVERY");
    await h.waitFor(
      (state) => state.terminalHistory.length === 2 && state.terminal !== null,
      "a second stopping checkpoint",
      28_000,
    );

    expect(h.state.config.budget.totalTokens).toBe(originalTotal + 200_000);
    expect(h.state.budget.totalTokens).toBe(originalTotal + 200_000);
    expect(h.state.config.limits.maxWaves).toBe(originalMaxWaves + 3);
    expect(h.state.waveOrder).toEqual(["W001"]);
    expect(h.state.terminalHistory.map((report) => report.finalPath)).toEqual([
      "artifacts/final.md",
      "artifacts/finals/final-2.md",
    ]);
    expect(h.state.artifacts["final"]!.path).toBe("artifacts/final.md");
    expect(h.state.artifacts["final-2"]!.path).toBe("artifacts/finals/final-2.md");
    expect(h.read(firstPath)).toBe(firstText);
    expect(h.read("artifacts/finals/final-2.md")).toContain("Second checkpoint");

    const continued = h.diskEvents().find((event) => event.type === "project.continued");
    expect(continued).toMatchObject({
      previousFinalPath: "artifacts/final.md",
      note: "Push the local lemma instead of repeating the global attack.",
      addTokens: 200_000,
      addWaves: 3,
    });
    const events = h.diskEvents();
    const continuedAt = events.findIndex((event) => event.type === "project.continued");
    const nextDecision = events
      .slice(continuedAt + 1)
      .find((event): event is Extract<Event, { type: "decision.requested" }> =>
        event.type === "decision.requested" && event.kind === "next_move",
      );
    expect(nextDecision).toBeTruthy();
    expect(h.readDecisionPacket(nextDecision!.decisionId, "current-record.md")).toContain(
      "Push the local lemma instead of repeating the global attack.",
    );
    expect(h.readDecisionPacket(nextDecision!.decisionId, "earlier-report.md")).toBe(firstText);
    expect(h.diskState()).toEqual(h.state);
  }, 30_000);

  it("4. an illegal proposal is bounced once and the corrected wave runs", async () => {
    const h = harness("bounce", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(
        DECISION_MATCH,
        planWave({
          title: "Reserve-free wave",
          reserveTokens: 0,
          tasks: [
            plannedTask({ role: "solver", methodTag: "greedy", brief: "Spend everything.", tokenBudget: 100_000 }),
          ],
        }),
      ),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", solverOutput("UNCERTAIN", "CONCLUSION: UNCERTAIN\n\nPartial.")),
      plannerCall(CURATION_MATCH, curationOutput()),
      plannerCall(DECISION_MATCH, terminate()),
      plannerCall(FINAL_MATCH, finalOutput("# Final\n\nBounced but progressed.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    const rejected = h.eventsOfType("decision.rejected");
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.violations.join(" ")).toMatch(/follow-up allowance 0 is below 25%/);

    // Same decision id: the bounce is a retry, not a new decision point.
    const accepted = h.eventsOfType("decision.accepted").find((e) => e.decisionId === rejected[0]!.decisionId);
    expect(accepted).toBeTruthy();
    expect(h.state.decisions[rejected[0]!.decisionId]!.violations.length).toBe(1);

    // …and the wave still ran.
    expect(h.state.waveOrder).toEqual(["W001"]);
    expect(h.state.waves["W001"]!.status).toBe("closed");
    expect(h.state.tasks["T001"]!.status).toBe("completed");
    expect(h.state.terminal!.result).toBe("UNCERTAIN");
  }, 30_000);

  it("4a. a second, grant-namespace mistake receives another automatic repair turn", async () => {
    const h = harness("grant-namespace-repair", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(
        DECISION_MATCH,
        planWave({
          title: "Bad reserve",
          reserveTokens: 0,
          tasks: [
            plannedTask({ role: "solver", methodTag: "first-error", brief: "First invalid move.", tokenBudget: 100_000 }),
          ],
        }),
      ),
      plannerCall(
        DECISION_MATCH,
        planWave({
          title: "Wrong reference namespace",
          reserveTokens: 100_000,
          tasks: [
            plannedTask({
              role: "solver",
              methodTag: "second-error",
              brief: "Try the claim directly.",
              tokenBudget: 200_000,
              cardIds: ["K001"],
            }),
          ],
        }),
      ),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", solverOutput("UNCERTAIN", "CONCLUSION: UNCERTAIN\n\nPartial.")),
      plannerCall(CURATION_MATCH, curationOutput()),
      plannerCall(DECISION_MATCH, terminate()),
      plannerCall(FINAL_MATCH, finalOutput("# Final\n\nReference mistake repaired automatically.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    const rejected = h.eventsOfType("decision.rejected");
    expect(rejected).toHaveLength(2);
    expect(rejected[1]!.violations.join(" ")).toContain(
      "grants.cardIds accepts only existing M-prefixed IDs",
    );
    expect(h.eventsOfType("question.raised")).toHaveLength(0);
    expect(h.state.waveOrder).toEqual(["W001"]);
  }, 30_000);

  it("4b. referee questions cannot be smuggled into acceptance-blocking obligations", async () => {
    const check = "Check the equality case independently.";
    const h = harness("review-question-semantics", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", solverOutput("PROVED", "CONCLUSION: PROVED\n\nA complete argument.")),
      plannerCall(CURATION_MATCH, curationOutput()),
      plannerCall(
        DECISION_MATCH,
        freezeCandidate({
          fromArtifactId: "A001",
          newLineageTitle: "Main line",
          obligations: [check],
        }),
      ),
      plannerCall(
        DECISION_MATCH,
        freezeCandidate({
          fromArtifactId: "A001",
          newLineageTitle: "Main line",
          reviewQuestions: [check],
        }),
      ),
      plannerCall(DECISION_MATCH, reviewWave("C001.v1")),
      workerCall("T002", reviewerOutput("PASS", "VERDICT: PASS\n\nThe equality case works.")),
      workerCall("T003", reviewerOutput("PASS", "VERDICT: PASS\n\nThe proof survives a second check.")),
      plannerCall(CURATION_MATCH, curationOutput({}, ["T002", "T003"])),
      plannerCall(FINAL_MATCH, finalOutput("# Final report\n\nThe complete proof passed review.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    expect(
      h.eventsOfType("decision.rejected").some((event) =>
        event.violations.join(" ").includes("put adversarial checks in reviewQuestions"),
      ),
    ).toBe(true);
    expect(h.state.candidates["C001.v1"]?.obligations).toEqual([]);
    expect(h.state.candidates["C001.v1"]?.reviewQuestions).toEqual([check]);
    expect(h.read("tasks/T002/packet/research-question.md")).toContain(check);
    expect(h.state.terminal?.result).toBe("PROVED");
  }, 30_000);

  it("5. three illegal proposals expose an operational retry; dismissing it resumes the loop", async () => {
    const illegal = (title: string) =>
      planWave({
        title,
        reserveTokens: 0,
        tasks: [
          plannedTask({ role: "solver", methodTag: "greedy", brief: `Spend everything (${title}).`, tokenBudget: 100_000 }),
        ],
      });

    const h = harness("blocking", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, illegal("first illegal")),
      plannerCall(DECISION_MATCH, illegal("second illegal")),
      plannerCall(DECISION_MATCH, illegal("third illegal")),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", solverOutput("UNCERTAIN", "CONCLUSION: UNCERTAIN\n\nPartial.")),
      plannerCall(CURATION_MATCH, curationOutput()),
      plannerCall(DECISION_MATCH, terminate()),
      plannerCall(FINAL_MATCH, finalOutput("# Final\n\nUnblocked and finished.")),
    ]);

    await runToConfirmation(h);
    const raised = (await h.waitForEvent(
      (e) => e.type === "question.raised" && e.blocking,
      "a blocking question",
    )) as Extract<Event, { type: "question.raised" }>;

    expect(raised.raisedBy).toBe("conductor");
    expect(raised.interaction).toBe("retry");
    expect(raised.text).toMatch(/invalid move 3 times/);
    expect(raised.text).toMatch(/No mathematical answer is required/);
    expect(h.eventsOfType("decision.rejected").length).toBe(3);

    // The engine idles: no wave, phase untouched.
    await sleep(150);
    expect(h.state.waveOrder).toEqual([]);
    expect(h.state.phase).toBe("DISCOVERY");
    expect(h.state.questions[raised.id]!.status).toBe("open");

    h.engine.dismissQuestion(raised.id);
    await h.waitFor((s) => s.waveOrder.length > 0, "the wave to be planned after the answer");
    await h.waitForTerminal();

    expect(h.state.questions[raised.id]!.status).toBe("dismissed");
    expect(h.state.tasks["T001"]!.status).toBe("completed");
    expect(h.state.terminal!.result).toBe("UNCERTAIN");
    // The retry was a fresh decision point, not the blocked one.
    expect(h.state.decisions[raised.context.match(/Decision: (DEC\d+)/)![1]!]!.status).toBe("rejected");
  }, 30_000);

  it("6. a budget-interrupted task still lets the wave close, and shows up in the docket", async () => {
    const h = harness("interrupt", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(
        DECISION_MATCH,
        planWave({
          title: "Two directions",
          // ≥ 25% of the wave total (160,000 of task budget + this reserve).
          reserveTokens: 60_000,
          tasks: [
            plannedTask({ role: "solver", methodTag: "alpha", brief: "Direction alpha.", tokenBudget: 100_000 }),
            // The smallest legal budget (MIN_TASK_TOKENS): a runaway worker
            // must still be killed by the streamed estimator.
            plannedTask({ role: "solver", methodTag: "beta", brief: "Direction beta.", tokenBudget: 60_000 }),
          ],
        }),
      ),
      workerCall("T001", solverOutput("UNCERTAIN", "CONCLUSION: UNCERTAIN\n\nAlpha made partial progress.")),
      workerCall("T002", null, {
        behavior: "hang",
        // Far past the 66,000-token cap once the estimator's turn/packet base
        // is counted; emitted twice (item.started + item.completed).
        items: [{ type: "reasoning", text: "z".repeat(200_000) }],
      }),
      plannerCall(CURATION_MATCH, curationOutput({}, ["T001", "T002"])),
      plannerCall(DECISION_MATCH, terminate()),
      plannerCall(FINAL_MATCH, finalOutput("# Final\n\nOne direction was cut short.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    expect(h.state.tasks["T001"]!.status).toBe("completed");
    expect(h.state.tasks["T002"]!.status).toBe("interrupted");
    expect(h.state.tasks["T002"]!.interruptReason).toBe("budget");
    expect(h.state.waves["W001"]!.status).toBe("closed");
    expect(h.state.waves["W001"]!.docketMarkdown).toContain("INTERRUPTED (budget)");
    expect(h.state.terminal!.result).toBe("UNCERTAIN");
  }, 30_000);

  it("7. gated autonomy: approve executes, reject abandons the decision and re-decides", async () => {
    const h = harness(
      "gated-approve",
      [
        plannerCall(INTAKE_MATCH, intakeOutput()),
        plannerCall(DECISION_MATCH, soloDiscovery()),
        workerCall("T001", solverOutput("UNCERTAIN", "CONCLUSION: UNCERTAIN\n\nPartial.")),
        plannerCall(CURATION_MATCH, curationOutput()),
        plannerCall(DECISION_MATCH, terminate()),
        plannerCall(FINAL_MATCH, finalOutput("# Final\n\nGated run.")),
      ],
      testConfig((c) => {
        c.autonomy = "gated";
      }),
    );

    await runToConfirmation(h);
    const gate = (await h.waitForEvent((e) => e.type === "gate.opened", "the first gate")) as Extract<
      Event,
      { type: "gate.opened" }
    >;

    // The engine idles at the gate: nothing is executed until a human resolves it.
    expect(h.state.openGateDecisionId).toBe(gate.decisionId);
    await sleep(100);
    expect(h.state.waveOrder).toEqual([]);
    expect(h.state.decisions[gate.decisionId]!.status).toBe("gated");

    autoResolveGates(h);
    h.engine.resolveGate(gate.decisionId, "approve");

    await h.waitFor((s) => s.waveOrder.length > 0, "the approved wave");
    await h.waitForTerminal();
    expect(h.state.decisions[gate.decisionId]!.gateResolution).toBe("approve");
    expect(h.state.tasks["T001"]!.status).toBe("completed");
    expect(h.state.terminal!.result).toBe("UNCERTAIN");
  }, 30_000);

  it("7b. gated rejection records a directive and re-runs the decision point", async () => {
    const h = harness(
      "gated-reject",
      [
        plannerCall(INTAKE_MATCH, intakeOutput()),
        plannerCall(DECISION_MATCH, soloDiscovery()),
        plannerCall(DECISION_MATCH, terminate("the owner asked us to stop instead")),
        plannerCall(FINAL_MATCH, finalOutput("# Final\n\nStopped on the owner's instruction.")),
      ],
      testConfig((c) => {
        c.autonomy = "gated";
      }),
    );

    await runToConfirmation(h);
    const gate = (await h.waitForEvent((e) => e.type === "gate.opened", "the first gate")) as Extract<
      Event,
      { type: "gate.opened" }
    >;
    autoResolveGates(h); // approve every later gate
    h.engine.resolveGate(gate.decisionId, "reject", undefined, "do not spend a wave here");

    await h.waitForTerminal();

    // The rejected decision was abandoned without a wave…
    expect(h.state.decisions[gate.decisionId]!.gateResolution).toBe("reject");
    expect(h.state.waveOrder).toEqual([]);
    // …the note became a directive…
    const directive = Object.values(h.state.directives).find((d) => d.text.includes("do not spend a wave here"));
    expect(directive).toBeTruthy();
    expect(directive!.status).toBe("consumed");
    // …and a fresh decision point ran (a second gate for the terminate).
    expect(h.eventsOfType("gate.opened").length).toBe(2);
    expect(h.state.terminal!.result).toBe("UNCERTAIN");
  }, 30_000);

  it("8. stop mid-task then reload: the interrupted task closes its wave, work is not repeated", async () => {
    const T001_THREAD = "th-recovery-t001";
    const h = harness("recovery", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", solverOutput("PROVED", "CONCLUSION: PROVED\n\nNever delivered."), {
        threadId: T001_THREAD,
        delayMs: 60,
        items: Array.from({ length: 8 }, (_, i) => ({ type: "reasoning", text: `step ${i}` })),
      }),
      // Present but never selected — see the recovery note below.
      {
        match: { resumeOf: T001_THREAD },
        finalMessage: solverOutput("PROVED", "CONCLUSION: PROVED\n\nResumed after the restart."),
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 },
      },
      plannerCall(CURATION_MATCH, curationOutput()),
      plannerCall(DECISION_MATCH, terminate("the only attempt was cut short by the restart")),
      plannerCall(FINAL_MATCH, finalOutput("# Final\n\nRestarted mid-wave.")),
    ]);

    await runToConfirmation(h);
    await h.waitForEvent(
      (e) => e.type === "task.session" && e.taskId === "T001",
      "T001 to open a codex session",
    );
    await h.stop();

    /*
     * Observed recovery semantics (engine.ts `stop` + `executeTask`):
     * stop() kills the child with SIGINT, so the run returns `interrupted`
     * and the engine records `task.interrupted { reason: "killed" }` BEFORE
     * stop() resolves — the log is never left with a dangling running task.
     * Consequently the reloaded engine does not take the §6.8 resume branch
     * (which only fires for a task still `running` in the log, e.g. after a
     * hard process kill): it finds a terminal task, closes the wave with the
     * interrupted outcome, and carries on. That is coherent — the work is
     * neither repeated nor silently lost — so the resume scenario call above
     * is deliberately never consumed.
     */
    expect(h.state.tasks["T001"]!.status).toBe("interrupted");
    expect(h.state.tasks["T001"]!.interruptReason).toBe("killed");
    expect(h.state.tasks["T001"]!.threadId).toBe(T001_THREAD);
    expect(h.state.waves["W001"]!.status).toBe("open");

    const beforeReload = h.diskState();
    await h.reload();
    expect(h.state).toEqual(beforeReload); // load = fold of the on-disk log

    h.start();
    await h.waitForTerminal();

    expect(h.state.terminal!.result).toBe("UNCERTAIN");
    expect(h.state.waves["W001"]!.status).toBe("closed");
    expect(h.state.waves["W001"]!.docketMarkdown).toContain("INTERRUPTED (killed)");

    // No repeated work: T001 was dispatched exactly once across both boots…
    const dispatches = h.diskEvents().filter((e) => e.type === "task.dispatched" && e.taskId === "T001");
    expect(dispatches.length).toBe(1);
    // …and the resume branch was never taken.
    expect(h.simLog().filter((r) => r.resumeOf !== null)).toEqual([]);
    expect(h.diskState()).toEqual(h.state);
  }, 30_000);

  it("8b. a hard conductor crash resumes the in-flight task with `codex exec resume` (§6.8)", async () => {
    const T001_THREAD = "th-crash-t001";
    const h = harness("crash", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", solverOutput("PROVED", "CONCLUSION: PROVED\n\nNever delivered."), {
        threadId: T001_THREAD,
        delayMs: 60,
        items: Array.from({ length: 8 }, (_, i) => ({ type: "reasoning", text: `step ${i}` })),
      }),
      {
        match: { resumeOf: T001_THREAD },
        finalMessage: solverOutput("PROVED", "CONCLUSION: PROVED\n\nFinished after the restart."),
        usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0 },
      },
      plannerCall(
        CURATION_MATCH,
        curationOutput({
          taskDispositions: [{
            taskId: "T001",
            disposition: "set_aside",
            reason: "This recovery scenario does not supply enough evidence to make the attempt reviewable.",
            unblock: null,
          }],
        }),
      ),
      plannerCall(DECISION_MATCH, terminate("one attempt is not enough to freeze")),
      plannerCall(FINAL_MATCH, finalOutput("# Final\n\nResumed after a crash.")),
    ]);

    await runToConfirmation(h);
    await h.waitForEvent(
      (e) => e.type === "task.session" && e.taskId === "T001",
      "T001 to open a codex session",
    );
    await h.stop();

    // Simulate `kill -9` of the conductor: the log ends with T001 still
    // `running` and holding a thread id, which is the real §6.8 crash state
    // (a graceful stop would have appended task.interrupted).
    h.truncateLogFrom((e) => e.type === "task.interrupted");
    await h.reload();
    expect(h.state.tasks["T001"]!.status).toBe("running");
    expect(h.state.tasks["T001"]!.threadId).toBe(T001_THREAD);

    h.start();
    await h.waitForTerminal();

    // The task was resumed, not re-dispatched, and its work landed.
    expect(h.simLog().filter((r) => r.resumeOf === T001_THREAD).length).toBe(1);
    expect(h.diskEvents().filter((e) => e.type === "task.dispatched" && e.taskId === "T001").length).toBe(1);
    expect(h.state.tasks["T001"]!.status).toBe("completed");
    expect(h.state.artifacts["A001"]!.conclusion).toBe("PROVED");
    expect(h.read("artifacts/attempts/A001.md")).toContain("Finished after the restart.");
    expect(h.state.waves["W001"]!.status).toBe("closed");
    expect(h.state.terminal!.result).toBe("UNCERTAIN");
    expect(h.diskState()).toEqual(h.state);
  }, 30_000);

  it("8c. graceful restarts resume curation and planning without inventing human questions", async () => {
    const h = harness("planner-restart", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", solverOutput("UNCERTAIN", "CONCLUSION: UNCERTAIN\n\nA useful partial argument.")),
      plannerCall(CURATION_MATCH, curationOutput(), {
        delayMs: 80,
        items: [{ type: "reasoning", text: "Curating the closed round." }],
      }),
      plannerCall(CURATION_MATCH, curationOutput()),
      plannerCall(DECISION_MATCH, terminate("the remaining gap is structural"), {
        delayMs: 80,
        items: [{ type: "reasoning", text: "Choosing the next move." }],
      }),
      plannerCall(DECISION_MATCH, terminate("the remaining gap is structural")),
      plannerCall(FINAL_MATCH, finalOutput("# Final\n\nThe partial result and structural gap are recorded.")),
    ]);

    await runToConfirmation(h);
    await h.waitFor(
      (state) =>
        state.waves["W001"]?.status === "closed" &&
        Object.values(state.decisions).some((decision) => decision.kind === "curation"),
      "curation to be requested",
    );
    await sleep(130);
    await h.stop();

    expect(h.state.waves["W001"]!.status).toBe("closed");
    expect(h.state.waves["W001"]!.resolutionPath).toBeNull();
    expect(Object.keys(h.state.questions)).toEqual([]);

    await h.reload();
    const nextMoveRequested = h.waitForEvent(
      (event) => event.type === "decision.requested" && event.kind === "next_move",
      "next move after recovered curation",
    );
    h.start();
    await nextMoveRequested;
    expect(h.state.waves["W001"]!.resolutionPath).toBe("artifacts/resolutions/W001.md");
    await sleep(130);
    await h.stop();

    expect(Object.keys(h.state.questions)).toEqual([]);
    expect(h.eventsOfType("resolution.recorded")).toHaveLength(1);

    await h.reload();
    h.start();
    await h.waitForTerminal();

    expect(h.state.terminal?.result).toBe("UNCERTAIN");
    expect(Object.keys(h.state.questions)).toEqual([]);
    expect(h.simLog().filter((row) => row.prompt.includes(CURATION_MATCH))).toHaveLength(2);
    expect(h.simLog().filter((row) => row.prompt.includes(DECISION_MATCH))).toHaveLength(3);
    expect(h.diskState()).toEqual(h.state);
  }, 30_000);

  it("8d. an incomplete curator result retries automatically and records how to use the attempt", async () => {
    const h = harness("curation-retry", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", solverOutput("UNCERTAIN", "CONCLUSION: UNCERTAIN\n\nA useful local reduction.")),
      plannerCall(CURATION_MATCH, curationOutput({ taskDispositions: [] })),
      plannerCall(
        CURATION_MATCH,
        curationOutput({
          taskDispositions: [
            {
              taskId: "T001",
              disposition: "needs_precise_unblock",
              reason: "The reduction is relevant, but its only imported lemma was not supplied.",
              unblock: "State the exact lemma used in step 2 and verify that its hypotheses hold here.",
            },
          ],
        }),
      ),
      plannerCall(DECISION_MATCH, terminate("the missing source is unavailable in this run")),
      plannerCall(FINAL_MATCH, finalOutput("# Final\n\nThe precise missing lemma is recorded.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    expect(Object.keys(h.state.questions)).toEqual([]);
    expect(h.simLog().filter((row) => row.prompt.includes(CURATION_MATCH))).toHaveLength(2);
    expect(h.eventsOfType("decision.rejected").some((event) =>
      event.violations.some((violation) => violation.includes("taskDispositions is missing T001")),
    )).toBe(true);
    const resolution = h.read("artifacts/resolutions/W001.md");
    expect(resolution).toContain("ask one focused follow-up");
    expect(resolution).toContain("State the exact lemma used in step 2");
  }, 30_000);

  it("8e. two curator failures preserve the round and continue without asking the owner", async () => {
    const h = harness("curation-fallback", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", solverOutput("PROVED", "CONCLUSION: PROVED\n\nA claimed local result survives in the raw note.")),
      plannerCall(CURATION_MATCH, null, { behavior: "exit-nonzero" }),
      plannerCall(CURATION_MATCH, null, { behavior: "exit-nonzero" }),
      plannerCall(CURATION_MATCH, null, { behavior: "exit-nonzero" }),
      plannerCall(CURATION_MATCH, null, { behavior: "exit-nonzero" }),
      // Stopping is bounced because the fallback left a conclusive artifact
      // unassessed. The chair explicitly sets it aside, then may stop.
      plannerCall(DECISION_MATCH, terminate("the preserved attempt is not enough to finish")),
      plannerCall(
        DECISION_MATCH,
        assessResults([
          {
            taskId: "T001",
            disposition: "set_aside",
            reason: "The curator failed and the raw note alone is not enough to spend an independent review round.",
            unblock: null,
          },
        ]),
      ),
      plannerCall(DECISION_MATCH, terminate("the preserved attempt is not enough to finish")),
      plannerCall(FINAL_MATCH, finalOutput("# Final\n\nThe unreviewed local claim remains in the record.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    expect(Object.keys(h.state.questions)).toEqual([]);
    // Each of the two reconciliation attempts gets the structured runner's
    // one process-crash retry before the engine falls back mechanically.
    expect(h.simLog().filter((row) => row.prompt.includes(CURATION_MATCH))).toHaveLength(4);
    const resolution = h.read("artifacts/resolutions/W001.md");
    expect(resolution).toContain("notes preserved");
    expect(resolution).toContain("No response from the owner is required");
    expect(resolution).toContain("T001");
    expect(h.state.researchManagerNotes).toEqual([
      expect.objectContaining({ waveId: "W000", source: "research_manager" }),
      expect.objectContaining({ waveId: "W001", source: "fallback" }),
    ]);
    expect(h.read("artifacts/manager-notes/W001.md")).toContain(
      "No new mathematical judgment was returned",
    );
    expect(h.state.tasks["T001"]!.disposition).toBe("set_aside");
    expect(
      h.eventsOfType("decision.rejected").some((event) =>
        event.violations.join(" ").includes("concrete mathematical results still need decisions"),
      ),
    ).toBe(true);
  }, 30_000);

  it("8f. a failed next-move call retries automatically before involving the owner", async () => {
    const h = harness("planner-auto-retry", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, null, { behavior: "exit-nonzero" }),
      plannerCall(DECISION_MATCH, null, { behavior: "exit-nonzero" }),
      plannerCall(DECISION_MATCH, terminate("the retry made an honest stopping decision")),
      plannerCall(FINAL_MATCH, finalOutput("# Final\n\nThe automatic retry recovered.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    expect(Object.keys(h.state.questions)).toEqual([]);
    expect(h.simLog().filter((row) => row.prompt.includes(DECISION_MATCH))).toHaveLength(3);
    expect(h.eventsOfType("decision.rejected")).toHaveLength(1);
    expect(h.state.terminal?.result).toBe("UNCERTAIN");
  }, 30_000);

  it("9. an urgent directive soft-interrupts the wave and is consumed by the next decision", async () => {
    const h = harness("directive", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(
        DECISION_MATCH,
        planWave({
          title: "Two directions",
          reserveTokens: 100_000,
          tasks: [
            plannedTask({ role: "solver", methodTag: "alpha", brief: "Direction alpha.", tokenBudget: 100_000 }),
            plannedTask({ role: "solver", methodTag: "beta", brief: "Direction beta.", tokenBudget: 100_000 }),
          ],
        }),
      ),
      workerCall("T001", solverOutput("UNCERTAIN", "CONCLUSION: UNCERTAIN\n\nAlpha partial."), {
        delayMs: 40,
        items: Array.from({ length: 6 }, (_, i) => ({ type: "reasoning", text: `alpha step ${i}` })),
      }),
      plannerCall(CURATION_MATCH, curationOutput({}, ["T001", "T002"])),
      plannerCall(DECISION_MATCH, terminate("following the owner's pivot instruction")),
      plannerCall(FINAL_MATCH, finalOutput("# Final\n\nPivoted on request.")),
    ]);

    await runToConfirmation(h);
    await h.waitForEvent(
      (e) => e.type === "task.session" && e.taskId === "T001",
      "T001 to start running",
    );
    expect(h.state.tasks["T002"]!.status).toBe("queued"); // pool max 1 → not dispatched yet

    const directiveId = h.engine.submitDirective("Pivot to the spectral approach.", true);
    expect(h.eventsOfType("wave.softInterrupted").length).toBe(1);

    await h.waitForTerminal();

    expect(h.state.tasks["T001"]!.status).toBe("completed");
    expect(h.state.tasks["T002"]!.status).toBe("interrupted");
    expect(h.state.tasks["T002"]!.interruptReason).toBe("wave-soft-interrupt");
    expect(h.state.waves["W001"]!.status).toBe("closed");
    expect(h.state.waves["W001"]!.docketMarkdown).toContain("INTERRUPTED (wave-soft-interrupt)");

    const directive = h.state.directives[directiveId]!;
    expect(directive.urgent).toBe(true);
    expect(directive.status).toBe("consumed");
    expect(directive.consumedByDecision).toBeTruthy();
    expect(h.state.decisions[directive.consumedByDecision!]!.kind).toBe("next_move");
    expect(h.eventsOfType("directive.consumed").map((e) => e.id)).toContain(directiveId);
    expect(h.state.terminal!.result).toBe("UNCERTAIN");

    // DESIGN §6.2: the consuming decision packet must carry the directive
    // verbatim, marked as human — consuming it must not hide it from the
    // Planner that is supposed to act on it.
    const ledger = h.readDecisionPacket(directive.consumedByDecision!, "current-record.md");
    expect(ledger).toContain("Pivot to the spectral approach.");
  }, 30_000);

  it("10. a disposition that clears the last blocking issue must reach the acceptance predicate", async () => {
    const h = harness("dispositions", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", solverOutput("PROVED", "CONCLUSION: PROVED\n\nA complete argument.")),
      plannerCall(CURATION_MATCH, curationOutput()),
      plannerCall(DECISION_MATCH, freezeCandidate({ fromArtifactId: "A001", newLineageTitle: "Main line" })),
      plannerCall(DECISION_MATCH, reviewWave("C001.v1")),
      // Both reviewers PASS, but one still records a MAJOR issue — acceptance
      // blocks on it until the Planner dispositions it.
      workerCall(
        "T002",
        reviewerOutput(
          "PASS",
          "VERDICT: PASS\n\nSound, with one presentational gap.",
          memo({
            issues: [
              {
                severity: "MAJOR",
                location: "Step 5",
                summary: "the constant is not tracked explicitly",
                repairHint: "state the constant",
              },
            ],
          }),
        ),
      ),
      workerCall("T003", reviewerOutput("PASS", "VERDICT: PASS\n\nNo counterexample.")),
      plannerCall(CURATION_MATCH, curationOutput({}, ["T002", "T003"])),
      plannerCall(
        DECISION_MATCH,
        envelope("record_dispositions", {
          items: [
            {
              issueId: "I001",
              disposition: "rejected",
              reason: "the constant is fixed by the hypothesis; no mathematical gap exists",
            },
          ],
        }),
      ),
      plannerCall(FINAL_MATCH, finalOutput("# Final report\n\nAccepted after the disposition.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    expect(h.state.issues["I001"]!.status).toBe("resolved");
    expect(h.state.issues["I001"]!.disposition).toBe("rejected");
    const evaluations = h.eventsOfType("acceptance.evaluated");
    expect(evaluations.map((e) => e.passed)).toEqual([false, true]);
    expect(evaluations[0]!.failing).toEqual(["open MAJOR issue I001"]);
    expect(h.state.terminal!.result).toBe("PROVED");
    expect(h.read("artifacts/final.md")).toContain("Accepted after the disposition.");
  }, 30_000);

  it("11. an exhausted budget terminates UNCERTAIN with a mechanical final report", async () => {
    // One intake call spends the whole ceiling (usageSpend = 1000-200+300).
    const h = harness(
      "budget",
      [plannerCall(INTAKE_MATCH, intakeOutput())],
      testConfig((c) => {
        c.budget.totalTokens = 1100;
      }),
    );

    await runToConfirmation(h);
    await h.waitForTerminal();

    expect(h.state.budget.plannerSpentTokens).toBe(1100);
    expect(h.state.terminal!.result).toBe("UNCERTAIN");
    expect(h.state.waveOrder).toEqual([]);
    const final = h.read("artifacts/final.md");
    expect(final.startsWith("RESULT: UNCERTAIN\n")).toBe(true);
    // No budget was left for a Final call, so the conductor composed it itself.
    expect(final).toContain("# Automatic fallback report");
    expect(final).toContain("Reason for ending the run: token budget exhausted");
    expect(h.eventsOfType("decision.requested").some((e) => e.kind === "final")).toBe(false);
  }, 30_000);

  it("12. abandon_lineage stales the open issues and returns the project to DISCOVERY", async () => {
    const h = harness("abandon", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", solverOutput("PROVED", "CONCLUSION: PROVED\n\nA flawed argument.")),
      plannerCall(CURATION_MATCH, curationOutput()),
      plannerCall(DECISION_MATCH, freezeCandidate({ fromArtifactId: "A001", newLineageTitle: "Main line" })),
      plannerCall(DECISION_MATCH, reviewWave("C001.v1")),
      workerCall("T002", reviewerOutput("PASS", "VERDICT: PASS\n\nI find no error.")),
      workerCall(
        "T003",
        reviewerOutput(
          "FAIL",
          "VERDICT: FAIL\n\nThe approach cannot work.",
          memo({
            issues: [
              {
                severity: "CRITICAL",
                location: "Overall strategy",
                summary: "the method provably cannot reach the conclusion",
                repairHint: "abandon this route",
              },
            ],
          }),
        ),
      ),
      plannerCall(CURATION_MATCH, curationOutput({}, ["T002", "T003"])),
      plannerCall(
        DECISION_MATCH,
        envelope("abandon_lineage", { lineageId: "C001", reason: "the strategy has a structural flaw" }),
      ),
      plannerCall(DECISION_MATCH, terminate("no alternative route is affordable")),
      plannerCall(FINAL_MATCH, finalOutput("# Final report\n\nThe route was abandoned.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal(28_000);

    expect(h.state.lineages["C001"]!.status).toBe("abandoned");
    expect(h.state.lineages["C001"]!.abandonReason).toMatch(/structural flaw/);
    expect(h.state.activeLineageId).toBeNull();
    expect(h.state.issues["I001"]!.status).toBe("resolved");
    expect(h.state.issues["I001"]!.disposition).toBe("stale");
    const backToDiscovery = h
      .eventsOfType("phase.changed")
      .find((e) => e.reason === "lineage C001 abandoned");
    expect(backToDiscovery?.to).toBe("DISCOVERY");
    expect(h.state.terminal!.result).toBe("UNCERTAIN");
  }, 30_000);

  it("13. cross_examine resumes a finished task and folds the answer into the next packet", async () => {
    const T001_THREAD = "th-xexam-t001";
    const h = harness("crossexam", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", solverOutput("UNCERTAIN", "CONCLUSION: UNCERTAIN\n\nOne step is unclear."), {
        threadId: T001_THREAD,
      }),
      plannerCall(
        CURATION_MATCH,
        curationOutput({
          claimExtractions: [
            { statement: "The bound is at most 3.", provenance: "attempt A001", fromTaskId: "T001", dependsOn: [] },
          ],
        }),
      ),
      plannerCall(
        DECISION_MATCH,
        envelope("cross_examine", {
          rationale: "the derivation of K001 is not reproducible from the artifact",
          items: [{ taskId: "T001", refIds: ["K001"], questionMarkdown: "How did you obtain the constant 3?" }],
        }),
      ),
      {
        match: { resumeOf: T001_THREAD },
        finalMessage: { answerMarkdown: "The constant 3 comes from Lemma 2 applied twice." },
        usage: USAGE,
      },
      plannerCall(DECISION_MATCH, terminate("the gap is real and unaffordable")),
      plannerCall(FINAL_MATCH, finalOutput("# Final report\n\nThe constant was clarified but the gap remains.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    const sent = h.eventsOfType("crossexam.sent");
    expect(sent.length).toBe(1);
    expect(sent[0]!.refIds).toEqual(["K001"]);
    const exam = h.state.tasks["T001"]!.crossExams[0]!;
    expect(exam.answerMarkdown).toContain("Lemma 2 applied twice");
    // The resume went to the task's own thread, in its own packet dir.
    const resumes = h.simLog().filter((r) => r.resumeOf === T001_THREAD);
    expect(resumes.length).toBe(1);
    expect(resumes[0]!.cwd.endsWith("/tasks/T001/packet")).toBe(true);
    // …and the answer reaches the Planner on the next decision.
    const lastDecision = h.state.decisionOrder.filter((d) => h.state.decisions[d]!.kind === "next_move").at(-1)!;
    const ledger = h.readDecisionPacket(lastDecision, "current-record.md");
    expect(ledger).toContain("## Focused follow-up answers");
    expect(ledger).toContain("Lemma 2 applied twice");
    expect(h.state.terminal!.result).toBe("UNCERTAIN");
  }, 30_000);

  it("13b. curation mechanically caps an overlong rolling digest", async () => {
    const overlong = "d".repeat(8_000);
    const h = harness("digest-cap", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", solverOutput("UNCERTAIN", "CONCLUSION: UNCERTAIN\n\nPartial.")),
      plannerCall(CURATION_MATCH, curationOutput({ digestMarkdown: overlong })),
      plannerCall(DECISION_MATCH, terminate("the bounded digest is enough for this run")),
      plannerCall(FINAL_MATCH, finalOutput("# Final report\n\nStopped after one attempt.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    const digest = h.read("digest.md");
    expect(digest).toBe("d".repeat(6_400) + "\n\n(truncated to keep the project summary concise)");
  }, 30_000);

  it("13c. stop cancels an in-flight planner call", async () => {
    const h = harness("planner-stop", [
      plannerCall(INTAKE_MATCH, null, { behavior: "hang" }),
    ]);
    h.start();
    await h.waitFor((state) => state.phase === "INTAKE", "intake planner to start");
    for (let i = 0; i < 100 && h.simLog().length === 0; i += 1) await sleep(10);
    expect(h.simLog()).toHaveLength(1);

    const started = Date.now();
    await h.stop();
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 10_000);

  it("14. malformed worker output is repaired by one resume before the wave closes", async () => {
    const T001_THREAD = "th-bad-t001";
    const h = harness("malformed", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", { conclusion: "MAYBE", memo: "not an object" }, {
        behavior: "malformed-output",
        threadId: T001_THREAD,
      }),
      {
        match: { resumeOf: T001_THREAD },
        finalMessage: solverOutput("PROVED", "CONCLUSION: PROVED\n\nCorrected structured output."),
        usage: USAGE,
      },
      plannerCall(
        CURATION_MATCH,
        curationOutput({
          taskDispositions: [{
            taskId: "T001",
            disposition: "set_aside",
            reason: "The repaired JSON is valid, but this scenario contains no independent mathematical evidence to review.",
            unblock: null,
          }],
        }),
      ),
      plannerCall(DECISION_MATCH, terminate("one attempt is not enough to freeze")),
      plannerCall(FINAL_MATCH, finalOutput("# Final report\n\nOne repaired attempt on record.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    const invalid = h.eventsOfType("task.outputInvalid");
    expect(invalid.length).toBe(1);
    expect(invalid[0]!.taskId).toBe("T001");
    expect(invalid[0]!.errors.join(" ")).toMatch(/conclusion|memo/);
    expect(h.state.tasks["T001"]!.invalidOutputErrors).not.toBeNull();
    expect(h.state.tasks["T001"]!.status).toBe("completed");
    expect(h.read("artifacts/attempts/A001.md")).toContain("Corrected structured output.");
    // Both calls are metered on the task.
    expect(h.state.tasks["T001"]!.usage!.input_tokens).toBe(2000);
    expect(h.state.terminal!.result).toBe("UNCERTAIN");
  }, 30_000);

  it("14b. a schema-valid refusal gets one unblock, then a fresh replacement", async () => {
    const derailed = solverOutput(
      "UNCERTAIN",
      "CONCLUSION: UNCERTAIN\n\nI need permission and more input before I can proceed.",
    );
    derailed.artifactMarkdown =
      "CONCLUSION: UNCERTAIN\n\nI need permission and more input before I can proceed.";
    derailed.memo.summary = "Please provide access.";
    const h = harness("derailed-worker", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", derailed, { threadId: "th-derailed" }),
      {
        match: { promptContains: "did not constitute usable mathematical work", resumeOf: "th-derailed" },
        threadId: "th-derailed",
        finalMessage: derailed,
        usage: USAGE,
      },
      {
        match: { promptContains: "Earlier attempts did not produce usable mathematical work" },
        threadId: "th-fresh-replacement",
        finalMessage: solverOutput(
          "UNCERTAIN",
          "CONCLUSION: UNCERTAIN\n\nThe replacement derives a concrete reduction and records its remaining lemma.",
          memo({ obligations: ["Prove the remaining lemma."] }),
        ),
        usage: USAGE,
      },
      plannerCall(
        CURATION_MATCH,
        curationOutput({
          taskDispositions: [
            {
              taskId: "T001",
              disposition: "set_aside",
              reason: "The replacement produced a usable note, but not a result ready for review.",
              unblock: null,
            },
          ],
        }),
      ),
      plannerCall(DECISION_MATCH, terminate("the usable partial note is preserved")),
      plannerCall(FINAL_MATCH, finalOutput("# Final report\n\nThe replacement note is preserved without overclaiming.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    expect(h.eventsOfType("task.outputInvalid")).toHaveLength(2);
    expect(h.eventsOfType("task.outputInvalid")[0]!.errors.join(" ")).toMatch(/unusable returned work/);
    expect(h.state.tasks.T001?.status).toBe("completed");
    expect(h.state.tasks.T001?.threadId).toBe("th-fresh-replacement");
    expect(h.state.tasks.T001?.usage?.input_tokens).toBe(3_000);
    expect(h.read("artifacts/attempts/A001.md")).toContain("replacement derives a concrete reduction");
    expect(Object.keys(h.state.questions)).toEqual([]);
  }, 30_000);

  // Regression for the deadlock found by the first real-quota run: no Planner
  // action promotes a claim, so a candidate that declares a real external
  // dependency could never be accepted and would re-review itself until the
  // budget ran out. Two independent PASS verdicts on the frozen version are
  // the protocol's "check by a different agent" (PROTOCOL §6).
  const dependencyRun = (secondVerdict: "PASS" | "FAIL") => [
    plannerCall(INTAKE_MATCH, intakeOutput()),
    plannerCall(DECISION_MATCH, soloDiscovery()),
    workerCall("T001", solverOutput("PROVED", "CONCLUSION: PROVED\n\nUses an imported theorem.")),
    plannerCall(
      CURATION_MATCH,
      curationOutput({
        claimExtractions: [
          {
            statement: "Every compact widget admits a round embedding (imported).",
            provenance: "Widget Theory, Thm 4.2",
            fromTaskId: "T001",
            dependsOn: [],
          },
        ],
      }),
    ),
    plannerCall(
      DECISION_MATCH,
      freezeCandidate({
        fromArtifactId: "A001",
        newLineageTitle: "Imported-theorem line",
        usedClaimIds: ["K001"],
      }),
    ),
    plannerCall(DECISION_MATCH, reviewWave("C001.v1")),
    workerCall("T002", reviewerOutput("PASS", "VERDICT: PASS\n\nThe import is stated correctly.")),
    workerCall(
      "T003",
      secondVerdict === "PASS"
        ? reviewerOutput("PASS", "VERDICT: PASS\n\nNo counterexample; the citation matches.")
        : reviewerOutput(
            "FAIL",
            "VERDICT: FAIL\n\nThe imported theorem is weaker than used.",
            memo({
              issues: [
                {
                  severity: "CRITICAL",
                  location: "step 3, imported theorem",
                  summary: "the citation does not cover the noncompact case",
                  repairHint: "prove the noncompact case directly",
                },
              ],
            }),
          ),
    ),
    plannerCall(CURATION_MATCH, curationOutput({}, ["T002", "T003"])),
  ];

  it("15. two PASS reviews verify the candidate's declared external dependencies", async () => {
    const h = harness("dependency-promoted", [
      ...dependencyRun("PASS"),
      plannerCall(FINAL_MATCH, finalOutput("# Final report\n\nRound, given the imported theorem.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    expect(h.state.claims["K001"]!.status).toBe("VERIFIED");
    const promotion = h.eventsOfType("claim.status").find((e) => e.claimId === "K001");
    expect(promotion!.by).toBe("conductor");
    expect(promotion!.justification).toMatch(/independent reviews R001, R002/);
    expect(h.state.candidates["C001.v1"]!.acceptance!.passed).toBe(true);
    expect(h.state.terminal!.result).toBe("PROVED");
  }, 30_000);

  // The Hodge run ended with 0 candidates and 0 reviews because the whole
  // statement was out of reach, so everything it *did* prove reached the final
  // report unreviewed. A scoped candidate is how partial progress gets checked.
  it("16. a scoped candidate is reviewable but can never be accepted as the full solution", async () => {
    const scope = "The assertion holds for every odd-dimensional case; the even case is untouched.";
    const h = harness("scoped-partial", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T001", solverOutput("PROVED", "CONCLUSION: PROVED\n\nOdd case only.")),
      plannerCall(
        CURATION_MATCH,
        curationOutput({
          claimExtractions: [
            {
              statement: "The assertion holds in every odd-dimensional case.",
              provenance: "A001, odd-dimensional reduction",
              fromTaskId: "T001",
              dependsOn: [],
            },
          ],
        }),
      ),
      // The chair tries to skip review and open another broad round. The
      // conductor must bounce this while a carried-forward proof is waiting.
      plannerCall(DECISION_MATCH, soloDiscovery()),
      plannerCall(
        DECISION_MATCH,
        freezeCandidate({
          fromArtifactId: "A001",
          newLineageTitle: "Odd-case line",
          scopeMarkdown: scope,
          reviewQuestions: ["Check the odd-dimensional reduction at the smallest boundary case."],
        }),
      ),
      plannerCall(DECISION_MATCH, reviewWave("C001.v1")),
      workerCall("T002", reviewerOutput("PASS", "VERDICT: PASS\n\nCorrect within its stated scope.")),
      workerCall("T003", reviewerOutput("PASS", "VERDICT: PASS\n\nNo overreach beyond the odd case.")),
      plannerCall(
        CURATION_MATCH,
        curationOutput(
          {
            claimUpdates: [
              {
                claimId: "K001",
                status: "VERIFIED",
                reason: "Both sealed reviewers checked the source candidate's exact scoped theorem.",
                evidenceTaskIds: ["T002", "T003"],
              },
            ],
          },
          ["T002", "T003"],
        ),
      ),
      plannerCall(DECISION_MATCH, terminate("the even case remains genuinely open")),
      plannerCall(FINAL_MATCH, finalOutput("# Final report\n\nOdd case settled; even case open.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    const c = h.state.candidates["C001.v1"]!;
    expect(c.scope).toBe(scope);
    // Two PASS reviews, yet acceptance must refuse it as a solution of the problem.
    expect(c.reviewIds.map((r) => h.state.reviews[r]!.verdict)).toEqual(["PASS", "PASS"]);
    expect(c.acceptance!.passed).toBe(false);
    expect(c.acceptance!.failing.join(" ")).toMatch(/scoped to a partial result/);
    expect(h.state.lineages["C001"]!.status).toBe("established");
    expect(h.state.lineages["C001"]!.establishedCandidateId).toBe("C001.v1");
    expect(h.state.claims.K001?.status).toBe("VERIFIED");
    expect(h.state.activeLineageId).toBeNull();
    expect(
      h.eventsOfType("decision.rejected").some((event) =>
        event.violations.join(" ").includes("independent review is needed"),
      ),
    ).toBe(true);
    expect(
      h.eventsOfType("phase.changed").some((event) =>
        event.reason.includes("independent reviews established scoped result C001.v1"),
      ),
    ).toBe(true);
    expect(h.state.terminal!.result).toBe("UNCERTAIN");
    // The reviewers were told what scope to judge against.
    expect(h.read("tasks/T002/packet/research-question.md")).toContain("partial result");
    expect(h.read("tasks/T002/packet/research-question.md")).toContain("odd-dimensional");
    expect(h.read("tasks/T002/packet/research-question.md")).toContain("Questions to test, not admitted gaps");
    expect(h.read("tasks/T002/packet/research-question.md")).toContain("smallest boundary case");
  }, 30_000);

  it("16b. curation closes an old claim only with conclusive evidence from a different sealed task", async () => {
    const h = harness("claim-verification-queue", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall(
        "T001",
        solverOutput(
          "UNCERTAIN",
          "CONCLUSION: UNCERTAIN\n\nThe parity lemma is plausible but not checked.",
        ),
      ),
      plannerCall(
        CURATION_MATCH,
        curationOutput({
          taskDispositions: [
            {
              taskId: "T001",
              disposition: "needs_precise_unblock",
              reason: "The route turns on one exact parity lemma.",
              unblock: "Prove or refute the parity lemma independently.",
            },
          ],
          claimExtractions: [
            {
              statement: "The parity lemma holds for every odd index.",
              provenance: "A001, proposed parity reduction",
              fromTaskId: "T001",
              dependsOn: [],
            },
          ],
        }),
      ),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall("T002", solverOutput("PROVED", "CONCLUSION: PROVED\n\nA complete independent parity proof.")),
      plannerCall(
        CURATION_MATCH,
        curationOutput(
          {
            taskDispositions: [
              {
                taskId: "T002",
                disposition: "set_aside",
                reason: "Its only reusable result is recorded as the check of K001.",
                unblock: null,
              },
            ],
            claimUpdates: [
              {
                claimId: "K001",
                status: "VERIFIED",
                reason: "T002 gives a self-contained proof of the exact parity lemma.",
                evidenceTaskIds: ["T002"],
              },
            ],
          },
          ["T002"],
        ),
      ),
      plannerCall(DECISION_MATCH, terminate("the checked lemma is useful, but the full problem remains open")),
      plannerCall(FINAL_MATCH, finalOutput("# Final report\n\nThe parity lemma is independently checked.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    expect(h.state.claims["K001"]!.status).toBe("VERIFIED");
    expect(h.state.claims["K001"]!.history[0]).toMatchObject({
      from: "UNVERIFIED",
      to: "VERIFIED",
      by: "conductor",
    });
    expect(h.state.claims["K001"]!.history[0]!.justification).toContain("T002");
    expect(h.state.tasks["T001"]!.disposition).toBe("needs_precise_unblock");
    expect(h.state.tasks["T002"]!.disposition).toBe("set_aside");
  }, 30_000);

  it("16c. setting an attempted route aside retires its unverified claim leads", async () => {
    const h = harness("claim-source-triage", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall(
        "T001",
        solverOutput("UNCERTAIN", "CONCLUSION: UNCERTAIN\n\nA speculative parity route with one unresolved step."),
      ),
      plannerCall(
        CURATION_MATCH,
        curationOutput({
          taskDispositions: [
            {
              taskId: "T001",
              disposition: "needs_precise_unblock",
              reason: "Only the parity step could make this route useful.",
              unblock: "Check the parity step independently.",
            },
          ],
          claimExtractions: [
            {
              statement: "The parity step holds in every odd degree.",
              provenance: "A001, unresolved parity step",
              fromTaskId: "T001",
              dependsOn: [],
            },
          ],
        }),
      ),
      plannerCall(
        DECISION_MATCH,
        assessResults([
          {
            taskId: "T001",
            disposition: "set_aside",
            reason: "A closer reading shows the parity step is unsupported and the route has no remaining leverage.",
            unblock: null,
          },
        ]),
      ),
      plannerCall(DECISION_MATCH, terminate("the speculative route has been triaged")),
      plannerCall(FINAL_MATCH, finalOutput("# Final report\n\nThe abandoned parity lead is not presented as evidence.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    expect(h.state.tasks["T001"]!.disposition).toBe("set_aside");
    expect(h.state.claims["K001"]!.sourceTaskId).toBe("T001");
    expect(h.state.claims["K001"]!.status).toBe("SUPERSEDED");
    expect(h.state.claims["K001"]!.history.at(-1)).toMatchObject({
      from: "UNVERIFIED",
      to: "SUPERSEDED",
      by: "planner",
    });
  }, 30_000);

  it("16d. curation condenses overlapping notes into a short reversible working-library card", async () => {
    const intakeMemory: IntakeMemory = {
      type: "ATTEMPT-SUMMARY",
      title: "Boundary reconstruction route",
      abstract: "A boundary identity may reconstruct the primitive invariants.",
      content: "Heuristic: reduce primitive insertions through the boundary identity.",
      tags: ["boundary", "reconstruction"],
    };
    const addition = {
      type: "LEMMA" as const,
      title: "Primitive reconstruction range",
      abstract: "Primitive invariants reduce to ambient data whenever the stated dimension inequality holds.",
      conclusionsMarkdown:
        "## Lemma 1\n\nPrimitive invariants reduce to ambient data under the dimension inequality.\n\n" +
        "## Remark\n\nThe boundary identity is the remaining point to verify.",
      tags: ["boundary", "reconstruction"],
      sourceCardIds: ["M001", "M002"],
      sourceArtifactIds: ["A001"],
      supersedesCardIds: ["M001"],
      promising: true,
    };
    const cardDecisions = [
      {
        cardId: "M002",
        admit: false,
        status: "SUPERSEDED" as const,
        reason: "Its distinct conclusion is preserved in the sharper condensation.",
      },
    ];
    const h = harness("library-condensation", [
      plannerCall(INTAKE_MATCH, {
        ...intakeOutput(),
        rawMemories: [intakeMemory],
      }),
      plannerCall(DECISION_MATCH, soloDiscovery()),
      workerCall(
        "T001",
        solverOutput(
          "UNCERTAIN",
          "CONCLUSION: UNCERTAIN\n\nThe boundary calculation isolates a precise reconstruction range.",
          memo({
            proposedCards: [
              {
                type: "LEMMA",
                title: "Boundary reconstruction calculation",
                abstract: "The same reduction has a precise dimension range.",
                content: "Lemma: the reduction works under the dimension inequality.",
                tags: ["boundary", "reconstruction"],
                provenance: "calculation in this attempt",
              },
            ],
          }),
        ),
      ),
      plannerCall(
        CURATION_MATCH,
        curationOutput({
          cardDecisions,
          libraryAdditions: [
            {
              ...addition,
              abstract: "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence",
              conclusionsMarkdown: "We tried several approaches and retained the most useful one.",
            },
          ],
        }),
      ),
      plannerCall(
        CURATION_MATCH,
        curationOutput({ cardDecisions, libraryAdditions: [addition] }),
      ),
      plannerCall(DECISION_MATCH, terminate("the condensed route is preserved for a later continuation")),
      plannerCall(FINAL_MATCH, finalOutput("# Final report\n\nThe reconstruction route remains an unverified lead.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    expect(
      h.eventsOfType("decision.rejected").some((event) =>
        event.violations.some((violation) => violation.includes("abstract exceeds four sentences")),
      ),
    ).toBe(true);
    expect(
      h.eventsOfType("decision.rejected").some((event) =>
        event.violations.some((violation) => violation.includes("named mathematical conclusions")),
      ),
    ).toBe(true);
    expect(h.state.cards["M001"]!.status).toBe("SUPERSEDED");
    expect(h.state.cards["M002"]!.status).toBe("SUPERSEDED");
    expect(h.state.cards["M003"]).toMatchObject({
      proposedBy: "planner:librarian",
      status: "PROPOSED",
      card: {
        title: "Primitive reconstruction range",
        abstract: addition.abstract,
      },
    });
    expect(h.state.cards["M003"]!.card.tags).toContain("promising");
    expect(h.read("memory/cards/M001.md")).toContain("status: SUPERSEDED");
    expect(h.read("memory/cards/M002.md")).toContain("status: SUPERSEDED");
    expect(h.read("memory/cards/M003.md")).toContain("## Lemma 1");
    expect(h.read("memory/cards/M003.md")).toContain("sources: M001, M002, A001");

    const working = h.readDecisionPacket("DEC004", "working-library.md");
    expect(working).toContain("**M003** [PROPOSED/LEMMA · PROMISING]");
    expect(working).not.toContain("**M001**");
    expect(working).not.toContain("**M002**");
  }, 30_000);

  it("15b. a single FAIL verdict blocks promotion, so the dependency stays unverified", async () => {
    const h = harness("dependency-blocked", [
      ...dependencyRun("FAIL"),
      plannerCall(DECISION_MATCH, terminate("the import does not cover the needed case")),
      plannerCall(FINAL_MATCH, finalOutput("# Final report\n\nThe import is too weak.")),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();

    expect(h.state.claims["K001"]!.status).toBe("UNVERIFIED");
    expect(h.eventsOfType("claim.status").length).toBe(0);
    const acceptance = h.state.candidates["C001.v1"]!.acceptance!;
    expect(acceptance.passed).toBe(false);
    expect(acceptance.failing.join(" ")).toMatch(/K001 is UNVERIFIED/);
    expect(h.state.terminal!.result).toBe("UNCERTAIN");
  }, 30_000);
});

/** Approve every gate that opens from now on (asynchronously, like a human would). */
function autoResolveGates(h: Harness): void {
  h.engine.on("event", (e: Event) => {
    if (e.type !== "gate.opened") return;
    const decisionId = e.decisionId;
    setTimeout(() => {
      if (h.state.openGateDecisionId === decisionId) h.engine.resolveGate(decisionId, "approve");
    }, 0);
  });
}
