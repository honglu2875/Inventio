import { unlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { SimCall } from "./helpers/harness.js";
import {
  CLAIM_COMPARISON_MATCH,
  claimComparisonOutput,
  finalOutput,
  Harness,
  INTAKE_MATCH,
  intakeOutput,
  plannerCall,
  PUBLICATION_MATCH,
  publicationOutput,
  SUMMARY_REVIEW_MATCH,
  summaryRevisionOutput,
  TRAJECTORY_FINAL_MATCH,
  TRAJECTORY_WORKER_MATCH,
  trajectoryOutput,
  trajectoryTestConfig,
  USAGE,
  VERIFICATION_MATCH,
  verificationOutput,
} from "./helpers/harness.js";

let current: Harness | null = null;

afterEach(async () => {
  if (current) await current.stop();
  current = null;
  delete process.env["INVENTIO_SIM_SCENARIO"];
  delete process.env["INVENTIO_SIM_STATE_DIR"];
});

function call(
  promptContains: string,
  cwdContains: string,
  finalMessage: unknown,
  threadId: string,
): SimCall {
  return {
    match: { promptContains, cwdContains },
    threadId,
    finalMessage,
    usage: USAGE,
  };
}

describe("trajectories-v2 end to end", () => {
  it("runs a long trajectory, verifies its self-contained claim twice, records a fact, and stops PROVED", async () => {
    const initial = intakeOutput();
    const solver = trajectoryOutput({
      conclusion: "PROVED",
      summaryMarkdown: "A direct argument proves roundness from the defining curvature identity.",
      writeupMarkdown:
        "# Roundness of the widget\n\nThe defining curvature identity is constant and positive. The standard rigidity argument therefore gives roundness.",
      claims: [
        {
          title: "Roundness criterion",
          statementMarkdown:
            "Every widget satisfying the stated constant positive curvature identity is round.",
          proofMarkdown:
            "Apply the rigidity identity to the traceless second fundamental form. Its squared norm integrates to zero, hence it vanishes identically, so the widget is round.",
          relationToGoal: "PROVES",
        },
      ],
    });
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, initial),
      call(TRAJECTORY_WORKER_MATCH, "/T001/", solver, "th-solver"),
      call(VERIFICATION_MATCH, "/V001/", verificationOutput("PASS"), "th-v1"),
      call(VERIFICATION_MATCH, "/V002/", verificationOutput("PASS"), "th-v2"),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(
        TRAJECTORY_FINAL_MATCH,
        finalOutput("# Final report\n\nThe verified roundness criterion proves the stated result."),
      ),
      plannerCall(PUBLICATION_MATCH, publicationOutput()),
    ];
    const h = Harness.create("trajectory-proved", calls, trajectoryTestConfig());
    current = h;
    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "v2 W000");
    const intakeContract = h.read("decisions/DEC001/packet/AGENTS.md");
    expect(intakeContract).toContain("# Initial mathematical reading");
    expect(intakeContract).not.toContain("Research Manager");
    expect(h.exists("decisions/DEC001/packet/w000-voice-example.md")).toBe(false);
    h.engine.submitDirective(
      "Try the curvature identity before introducing auxiliary machinery.",
      false,
    );
    h.confirm();
    await h.waitForTerminal(30_000);

    expect(h.state.terminal?.result).toBe("PROVED");
    expect(h.state.config.workflow).toBe("trajectories-v2");
    expect(h.state.waveOrder).toEqual(["W001"]);
    expect(h.state.tasks["T001"]?.status).toBe("completed");
    expect(h.state.claimOrder).toEqual(["K001"]);
    expect(h.state.claims["K001"]?.status).toBe("VERIFIED");
    expect(h.state.factOrder).toEqual(["F001"]);
    expect(h.state.facts["F001"]?.status).toBe("ACTIVE");
    expect(h.state.verificationOrder).toEqual(["V001", "V002"]);
    expect(h.state.verificationOrder.map((id) => h.state.verifications[id]?.verdict)).toEqual([
      "PASS",
      "PASS",
    ]);
    expect(h.state.mathematicalViews.map((view) => view.waveId)).toEqual(["W000", "W001"]);
    expect(h.state.mathematicalViews.at(-1)!.recordedAtSeq).toBeGreaterThan(
      Math.max(...h.state.verificationOrder.map((id) => h.state.verifications[id]!.completedAtSeq!)),
    );
    expect(h.exists("claims/K001.md")).toBe(true);
    expect(h.exists("facts/F001.md")).toBe(true);
    expect(h.exists("writeups/A001.md")).toBe(true);
    expect(JSON.parse(h.read("tasks/T001/meta.json"))).toMatchObject({
      tokenAccounting: { kind: "soft-target", target: 500_000, exceededBy: 0 },
    });
    expect(h.read("tasks/T001/packet/owner-guidance.md")).toContain(
      "Try the curvature identity before introducing auxiliary machinery.",
    );
    expect(h.read(h.state.terminal!.finalPath)).not.toContain("Research Manager");
    const firstCheck = h.read("verifications/V001/packet/AGENTS.md");
    const secondCheck = h.read("verifications/V002/packet/AGENTS.md");
    expect(firstCheck).toContain("Check the logical argument in order");
    expect(secondCheck).toContain("Independently derive the step");
    expect(h.read("verifications/V001/packet/claim.md"))
      .toBe(h.read("verifications/V002/packet/claim.md"));

    h.engine.requestPublication();
    await h.waitFor((state) => state.publications[0]?.status === "drafted", "trajectory manuscript");
    const publication = h.state.publications[0]!;
    const packet = `decisions/${publication.decisionId}/packet`;
    expect(h.read(`${packet}/research-record/claims/K001.md`)).toContain(solver.claims[0]!.proofMarkdown);
    expect(h.read(`${packet}/research-record/facts/F001.md`)).toContain(solver.claims[0]!.proofMarkdown);
    expect(h.read(`${packet}/research-record/verifications/V001.md`)).toBe(h.read("verifications/V001/report.md"));
    expect(h.read(`${packet}/research-record/verifications/V002.md`)).toBe(h.read("verifications/V002/report.md"));
    expect(h.read(`${packet}/research-record-index.md`)).toContain("F001 [ACTIVE; from K001]");
    expect(h.read(`${packet}/current-record.md`)).toContain("K001");
    expect(h.diskState()).toEqual(h.state);
  });

  it("starts two Solvers and two Explorers with four distinct task identities", async () => {
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      call(
        TRAJECTORY_WORKER_MATCH,
        "/T001/",
        trajectoryOutput({ summaryMarkdown: "Solver one completed an independent investigation." }),
        "th-solver-1",
      ),
      call(
        TRAJECTORY_WORKER_MATCH,
        "/T002/",
        trajectoryOutput({ summaryMarkdown: "Solver two completed an independent investigation." }),
        "th-solver-2",
      ),
      call(
        TRAJECTORY_WORKER_MATCH,
        "/T003/",
        trajectoryOutput({ summaryMarkdown: "Explorer one completed an independent investigation." }),
        "th-explorer-1",
      ),
      call(
        TRAJECTORY_WORKER_MATCH,
        "/T004/",
        trajectoryOutput({ summaryMarkdown: "Explorer two completed an independent investigation." }),
        "th-explorer-2",
      ),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(
        TRAJECTORY_FINAL_MATCH,
        finalOutput("# Final report\n\nFour independent trajectories completed without a proof."),
      ),
    ];
    const h = Harness.create(
      "trajectory-four-workers",
      calls,
      trajectoryTestConfig((config) => {
        config.limits.maxConcurrentWorkers = 4;
        config.trajectory.solversPerWave = 2;
        config.trajectory.explorersPerWave = 2;
      }),
    );
    current = h;
    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "v2 W000");
    h.confirm();
    await h.waitForTerminal(30_000);

    const roster = h.state.waves["W001"]!.roster;
    expect(roster.map((entry) => [entry.taskId, entry.role])).toEqual([
      ["T001", "solver"],
      ["T002", "solver"],
      ["T003", "explorer"],
      ["T004", "explorer"],
    ]);
    expect(new Set(roster.map((entry) => entry.taskId)).size).toBe(4);
    expect(Object.keys(h.state.tasks).sort()).toEqual(["T001", "T002", "T003", "T004"]);
    expect(Object.values(h.state.tasks).map((task) => task.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(Object.keys(h.state.artifacts).filter((id) => /^[AE]\d+$/.test(id)).sort()).toEqual([
      "A001",
      "A002",
      "E001",
      "E002",
    ]);
    expect(h.state.tasks.T001?.artifactIds).toEqual(["A001"]);
    expect(h.state.tasks.T002?.artifactIds).toEqual(["A002"]);
    expect(h.state.tasks.T003?.artifactIds).toEqual(["E001"]);
    expect(h.state.tasks.T004?.artifactIds).toEqual(["E002"]);
    for (const id of ["A001", "A002", "E001", "E002"]) {
      expect(h.exists(`writeups/${id}.md`)).toBe(true);
    }
    const launchedTaskDirs = h
      .simLog()
      .map((row) => /\/tasks\/(T\d{3})\//.exec(row.cwd)?.[1])
      .filter((id): id is string => id !== undefined)
      .sort();
    expect(launchedTaskDirs).toEqual(["T001", "T002", "T003", "T004"]);
    expect(h.diskState()).toEqual(h.state);
  });

  it("recovers historical A001/E001 collisions from task-local returns exactly once", async () => {
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      call(
        TRAJECTORY_WORKER_MATCH,
        "/T001/",
        trajectoryOutput({
          writeupMarkdown: "# Solver one\n\nThe first Solver's independent argument.",
        }),
        "th-recover-solver-1",
      ),
      call(
        TRAJECTORY_WORKER_MATCH,
        "/T002/",
        trajectoryOutput({
          writeupMarkdown: "# Solver two\n\nThe second Solver's independent argument.",
        }),
        "th-recover-solver-2",
      ),
      call(
        TRAJECTORY_WORKER_MATCH,
        "/T003/",
        trajectoryOutput({
          writeupMarkdown: "# Explorer one\n\nThe first Explorer's independent investigation.",
        }),
        "th-recover-explorer-1",
      ),
      call(
        TRAJECTORY_WORKER_MATCH,
        "/T004/",
        trajectoryOutput({
          writeupMarkdown: "# Explorer two\n\nThe second Explorer's independent investigation.",
        }),
        "th-recover-explorer-2",
      ),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(
        TRAJECTORY_FINAL_MATCH,
        finalOutput("# Final report\n\nThe simulated investigation is complete."),
      ),
    ];
    const h = Harness.create(
      "trajectory-writeup-recovery",
      calls,
      trajectoryTestConfig((config) => {
        config.trajectory.solversPerWave = 2;
        config.trajectory.explorersPerWave = 2;
      }),
    );
    current = h;
    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "v2 W000");
    h.confirm();
    await h.waitForTerminal(30_000);
    await h.stop();

    // Recreate the exact early-v2 corruption without touching production
    // data: all Solver records reused A001 and all Explorer records E001.
    const corrupted = h.diskEvents().map((event) => {
      if (event.type !== "artifact.recorded" || event.kind !== "writeup" || !event.taskId) {
        return event;
      }
      const explorer = h.state.tasks[event.taskId]?.role === "explorer";
      const artifactId = explorer ? "E001" : "A001";
      return { ...event, artifactId, path: `writeups/${artifactId}.md` };
    });
    const last = corrupted.at(-1)!;
    corrupted.push({
      type: "claim.added",
      claimId: "K001",
      title: "Recovered source label",
      statement: "The second Solver recorded a useful observation.",
      proofMarkdown: "This synthetic claim exercises source repair.",
      status: "UNVERIFIED",
      provenance: "A001 (from T002), result 1",
      sourceTaskId: "T002",
      sourceWaveId: "W001",
      path: null,
      relationToGoal: "RELATED",
      kind: "mathematical",
      targetFactId: null,
      verificationPolicy: { verifiersPerClaim: 2, passesRequired: 2 },
      dependsOn: [],
      seq: last.seq + 1,
      ts: "2026-08-29T00:00:00.000Z",
    });
    writeFileSync(h.paths.eventsFile, corrupted.map((event) => JSON.stringify(event)).join("\n") + "\n");

    await h.reload();
    expect(h.state.tasks.T001?.artifactIds).toEqual(["A001"]);
    expect(h.state.tasks.T002?.artifactIds).toEqual(["A002"]);
    expect(h.state.tasks.T003?.artifactIds).toEqual(["E001"]);
    expect(h.state.tasks.T004?.artifactIds).toEqual(["E002"]);
    expect(h.state.claims.K001?.provenance).toBe("A002 (from T002), result 1");
    expect(h.read("writeups/A001.md")).toContain("Solver one");
    expect(h.read("writeups/A002.md")).toContain("Solver two");
    expect(h.read("writeups/E001.md")).toContain("Explorer one");
    expect(h.read("writeups/E002.md")).toContain("Explorer two");
    expect(h.diskState()).toEqual(h.state);

    const repairedEventCount = h.diskEvents().length;
    await h.reload();
    expect(h.diskEvents()).toHaveLength(repairedEventCount);
  });

  it("marks a claim failed as soon as the configured pass threshold is impossible", async () => {
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      call(
        TRAJECTORY_WORKER_MATCH,
        "/T001/",
        trajectoryOutput({
          claims: [
            {
              title: "False shortcut",
              statementMarkdown: "Every widget is round.",
              proofMarkdown: "The assertion is immediate from the name widget.",
              relationToGoal: "PROVES",
            },
          ],
        }),
        "th-solver-fail",
      ),
      call(
        VERIFICATION_MATCH,
        "/V001/",
        verificationOutput("FAIL", "The proof gives no mathematical implication."),
        "th-v1-fail",
      ),
      call(
        VERIFICATION_MATCH,
        "/V002/",
        verificationOutput("FAIL", "The stated reason is merely linguistic."),
        "th-v2-fail",
      ),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(
        TRAJECTORY_FINAL_MATCH,
        finalOutput("# Final report\n\nNo proof or disproof completed independent verification."),
      ),
    ];
    const h = Harness.create("trajectory-failed-claim", calls, trajectoryTestConfig());
    current = h;
    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "v2 W000");
    h.confirm();
    await h.waitForTerminal(30_000);

    expect(h.state.terminal?.result).toBe("UNCERTAIN");
    expect(h.state.claims["K001"]?.status).toBe("FAILED");
    expect(h.state.factOrder).toEqual([]);
  });

  it("asks the originating trajectory once to repair a damaged or non-standalone claim", async () => {
    const malformed = trajectoryOutput({
      claims: [
        {
          title: "Recovered rigidity lemma",
          statementMarkdown: "The widget in T001 is round.",
          proofMarkdown: "As proved above, the traceless curvature vanishes.",
          relationToGoal: "PROVES",
        },
      ],
    });
    const repaired = trajectoryOutput({
      claims: [
        {
          title: "Recovered rigidity lemma",
          statementMarkdown:
            "Every complete widget whose traceless curvature tensor vanishes is round.",
          proofMarkdown:
            "Vanishing of the traceless curvature tensor makes the curvature tensor equal to its constant positive scalar component. Completeness and the stated rigidity theorem therefore identify the widget with the round model.",
          relationToGoal: "PROVES",
        },
      ],
    });
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      call(TRAJECTORY_WORKER_MATCH, "/T001/", malformed, "th-preparation-repair"),
      {
        match: { resumeOf: "th-preparation-repair" },
        threadId: "th-preparation-repair",
        finalMessage: repaired,
        usage: USAGE,
      },
      call(VERIFICATION_MATCH, "/V001/", verificationOutput("PASS"), "th-prepared-v1"),
      call(VERIFICATION_MATCH, "/V002/", verificationOutput("PASS"), "th-prepared-v2"),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(
        TRAJECTORY_FINAL_MATCH,
        finalOutput("# Final report\n\nThe repaired self-contained claim passed checking."),
      ),
    ];
    const h = Harness.create("trajectory-claim-preparation", calls, trajectoryTestConfig());
    current = h;
    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "v2 W000");
    h.confirm();
    await h.waitForTerminal(30_000);

    expect(h.state.tasks.T001?.invalidOutputErrors?.join(" ")).toMatch(
      /internal project ID|surrounding work/,
    );
    expect(h.state.claims.K001?.statement).not.toContain("T001");
    expect(h.state.claims.K001?.proofMarkdown).not.toContain("proved above");
    expect(h.state.claims.K001?.status).toBe("VERIFIED");
  });

  it("keeps an incomplete submission for revision instead of calling its mathematics failed", async () => {
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      call(
        TRAJECTORY_WORKER_MATCH,
        "/T001/",
        trajectoryOutput({
          claims: [
            {
              title: "Rigidity using an unstated lemma",
              statementMarkdown: "Every widget with zero defect is round.",
              proofMarkdown:
                "Apply the named rigidity lemma to the zero-defect tensor; its conclusion gives roundness.",
              relationToGoal: "PARTIAL",
            },
          ],
        }),
        "th-needs-revision",
      ),
      call(
        VERIFICATION_MATCH,
        "/V001/",
        verificationOutput(
          "FAIL",
          "The named rigidity lemma and its hypotheses were not supplied.",
          "MISSING_DEPENDENCY",
        ),
        "th-needs-revision-check",
      ),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(
        TRAJECTORY_FINAL_MATCH,
        finalOutput("# Final report\n\nThe proposed lemma still needs a self-contained proof."),
      ),
    ];
    const h = Harness.create(
      "trajectory-needs-revision",
      calls,
      trajectoryTestConfig((config) => {
        config.trajectory.verifiersPerClaim = 1;
        config.trajectory.passesRequired = 1;
      }),
    );
    current = h;
    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "v2 W000");
    h.confirm();
    await h.waitForTerminal(30_000);

    expect(h.state.claims.K001?.status).toBe("NEEDS_REVISION");
    expect(h.state.verifications.V001?.finding).toBe("MISSING_DEPENDENCY");
    expect(h.state.factOrder).toEqual([]);
  });

  it("compares equal statements before review and checks only one proof at a time", async () => {
    const first = trajectoryOutput({
      claims: [
        {
          title: "Zero-defect rigidity",
          statementMarkdown: "Every complete widget with identically zero defect is round.",
          proofMarkdown:
            "The curvature decomposition has only its constant positive component when the defect vanishes. Completeness and rigidity give the round model.",
          relationToGoal: "PARTIAL",
        },
      ],
    });
    const second = trajectoryOutput({
      claims: [
        {
          title: "Rigidity at zero defect",
          statementMarkdown:
            "If a complete widget has defect tensor zero everywhere, then it is round.",
          proofMarkdown:
            "Insert the zero tensor in the rigidity identity and integrate. The nonnegative traceless term has integral zero and hence vanishes, which yields the round model.",
          relationToGoal: "PARTIAL",
        },
      ],
    });
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      call(TRAJECTORY_WORKER_MATCH, "/T001/", first, "th-duplicate-first"),
      call(TRAJECTORY_WORKER_MATCH, "/T002/", second, "th-duplicate-second"),
      plannerCall(CLAIM_COMPARISON_MATCH, claimComparisonOutput([["K001", "K002"]])),
      call(VERIFICATION_MATCH, "/V001/", verificationOutput("PASS"), "th-duplicate-check"),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(
        TRAJECTORY_FINAL_MATCH,
        finalOutput("# Final report\n\nOne independently checked rigidity fact was retained."),
      ),
    ];
    const h = Harness.create(
      "trajectory-pre-review-equivalence",
      calls,
      trajectoryTestConfig((config) => {
        config.limits.maxConcurrentWorkers = 2;
        config.trajectory.solversPerWave = 2;
        config.trajectory.verifiersPerClaim = 1;
        config.trajectory.passesRequired = 1;
      }),
    );
    current = h;
    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "v2 W000");
    h.confirm();
    await h.waitForTerminal(30_000);

    expect(h.state.waves.W001?.claimsCompared).toBe(true);
    expect(h.state.verificationOrder).toEqual(["V001"]);
    expect(h.state.claims.K001?.status).toBe("VERIFIED");
    expect(h.state.claims.K002?.status).toBe("SUPERSEDED");
    expect(h.state.factOrder).toEqual(["F001"]);
    const comparisonContract = h.read("decisions/DEC003/packet/AGENTS.md");
    expect(comparisonContract).toContain("Do not assess proof quality");
    expect(comparisonContract).toContain("Do not group implications");
    expect(comparisonContract).not.toMatch(/promising|preferred method|research strategy/i);
  });

  it("replaces an operational verifier error instead of treating it as mathematical failure", async () => {
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      call(
        TRAJECTORY_WORKER_MATCH,
        "/T001/",
        trajectoryOutput({
          claims: [
            {
              title: "Uncheckable shortcut",
              statementMarkdown: "Every widget is round.",
              proofMarkdown: "A complete proof is alleged here but cannot be independently recovered.",
              relationToGoal: "PROVES",
            },
          ],
        }),
        "th-solver-verification-error",
      ),
      {
        match: { promptContains: VERIFICATION_MATCH, cwdContains: "/V001/" },
        threadId: "th-verification-error",
        behavior: "crash-mid-stream",
      },
      {
        match: { resumeOf: "th-verification-error" },
        behavior: "exit-nonzero",
      },
      call(
        VERIFICATION_MATCH,
        "/V002/",
        verificationOutput("PASS", "The replacement verifier completed the mathematical check."),
        "th-verification-replacement",
      ),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(
        TRAJECTORY_FINAL_MATCH,
        finalOutput("# Final report\n\nA fresh verifier completed the independent check."),
      ),
    ];
    const h = Harness.create(
      "trajectory-verification-error",
      calls,
      trajectoryTestConfig((config) => {
        config.trajectory.verifiersPerClaim = 1;
        config.trajectory.passesRequired = 1;
      }),
    );
    current = h;
    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "v2 W000");
    h.confirm();
    await h.waitForTerminal(30_000);

    expect(h.state.claims["K001"]?.status).toBe("VERIFIED");
    expect(h.state.verifications["V001"]?.verdict).toBe("ERROR");
    expect(h.state.verifications["V002"]?.verdict).toBe("PASS");
    expect(h.state.factOrder).toEqual(["F001"]);
  });

  it("keeps failed proofs available for later equivalence and reconciles a new valid proof", async () => {
    const firstAttempt = trajectoryOutput({
      claims: [
        {
          title: "Rigidity from vanishing defect",
          statementMarkdown: "A widget whose normalized rigidity defect vanishes is round.",
          proofMarkdown: "The conclusion is immediate and needs no further argument.",
          relationToGoal: "PARTIAL",
        },
      ],
    });
    const secondAttempt = trajectoryOutput({
      claims: [
        {
          title: "Vanishing-defect rigidity criterion",
          statementMarkdown:
            "If the normalized rigidity defect of a widget is identically zero, then the widget is round.",
          proofMarkdown:
            "The defining decomposition writes the curvature tensor as its round component plus the rigidity defect. When the latter vanishes, the tensor has constant positive sectional curvature; the stated completeness hypothesis and the rigidity theorem then identify the widget with the round model.",
          relationToGoal: "PARTIAL",
        },
      ],
    });
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      call(TRAJECTORY_WORKER_MATCH, "/T001/", firstAttempt, "th-equivalence-first"),
      call(VERIFICATION_MATCH, "/V001/", verificationOutput("FAIL"), "th-equivalence-fail"),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      call(TRAJECTORY_WORKER_MATCH, "/T002/", secondAttempt, "th-equivalence-second"),
      plannerCall(CLAIM_COMPARISON_MATCH, claimComparisonOutput([["K001", "K002"]])),
      call(VERIFICATION_MATCH, "/V002/", verificationOutput("PASS"), "th-equivalence-pass"),
      plannerCall(
        SUMMARY_REVIEW_MATCH,
        summaryRevisionOutput({
          changed: true,
          abstract: "A corrected proof establishes the vanishing-defect rigidity criterion.",
          markdown:
            "# W001 — Current mathematical view\n\nThe vanishing-defect rigidity criterion is now established by an independently checked proof.",
        }),
      ),
      plannerCall(
        TRAJECTORY_FINAL_MATCH,
        finalOutput("# Final report\n\nA useful partial rigidity criterion was established."),
      ),
    ];
    const h = Harness.create(
      "trajectory-late-equivalence",
      calls,
      trajectoryTestConfig((config) => {
        config.limits.maxWaves = 2;
        config.trajectory.verifiersPerClaim = 1;
        config.trajectory.passesRequired = 1;
      }),
    );
    current = h;
    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "v2 W000");
    h.confirm();
    await h.waitForTerminal(30_000);

    expect(h.state.claims["K001"]?.status).toBe("FAILED");
    expect(h.state.claims["K002"]?.status).toBe("VERIFIED");
    expect(h.state.claims["K001"]?.equivalentIds).toContain("K002");
    expect(h.state.claims["K002"]?.promotedFactId).toBe("F001");
    expect(h.read("artifacts/mathematical-view/W002.md")).toMatch(
      /^# W002 — Current mathematical view/,
    );
  }, 30_000);

  it("rejects a summary abstract cut off at the transport boundary", async () => {
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      call(TRAJECTORY_WORKER_MATCH, "/T001/", trajectoryOutput(), "th-summary-cutoff"),
      plannerCall(
        SUMMARY_REVIEW_MATCH,
        summaryRevisionOutput({
          changed: true,
          abstract: "A".repeat(480),
          markdown: "# W000 — Current mathematical view\n\nA proposed revision.",
        }),
      ),
      plannerCall(
        TRAJECTORY_FINAL_MATCH,
        finalOutput("# Final report\n\nThe investigation remains incomplete."),
      ),
    ];
    const h = Harness.create("trajectory-summary-cutoff", calls, trajectoryTestConfig());
    current = h;
    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "v2 W000");
    h.confirm();
    await h.waitForTerminal(30_000);

    const view = h.state.mathematicalViews.at(-1)!;
    expect(view.source).toBe("fallback");
    expect(view.abstract).toBe("The objective is to show that the widget is round.");
    expect(h.read("artifacts/mathematical-view/W001.md")).toMatch(
      /^# W001 — Current mathematical view/,
    );
  });

  it("delivers a Continue Research comment to the first trajectories of the renewed run", async () => {
    const laterClaim = trajectoryOutput({
      conclusion: "PROVED",
      summaryMarkdown: "The suggested parity decomposition closes the argument.",
      claims: [
        {
          title: "Parity decomposition",
          statementMarkdown: "The confirmed widget is round.",
          proofMarkdown:
            "Split the defining identity into its even and odd parts. The odd part vanishes by symmetry, while the even part is the positive rigidity integral; hence the traceless term vanishes and the widget is round.",
          relationToGoal: "PROVES",
        },
      ],
    });
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      call(TRAJECTORY_WORKER_MATCH, "/T001/", trajectoryOutput(), "th-first-run"),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(TRAJECTORY_FINAL_MATCH, finalOutput("# First report\n\nNo complete proof was found.")),
      call(TRAJECTORY_WORKER_MATCH, "/T002/", laterClaim, "th-renewed-run"),
      call(VERIFICATION_MATCH, "/V001/", verificationOutput("PASS"), "th-renewed-check"),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(TRAJECTORY_FINAL_MATCH, finalOutput("# Second report\n\nThe verified parity argument proves the result.")),
    ];
    const h = Harness.create(
      "trajectory-continuation-guidance",
      calls,
      trajectoryTestConfig((config) => {
        config.trajectory.verifiersPerClaim = 1;
        config.trajectory.passesRequired = 1;
      }),
    );
    current = h;
    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "v2 W000");
    h.confirm();
    await h.waitForTerminal(30_000);

    h.engine.continueResearch(
      "Use a parity decomposition of the curvature identity and test both summands separately.",
      5_000_000,
      1,
    );
    await h.waitFor(
      (state) => state.terminalHistory.length === 2 && state.terminal !== null,
      "renewed terminal state",
      30_000,
    );

    expect(h.state.terminal?.result).toBe("PROVED");
    expect(h.read("tasks/T002/packet/owner-guidance.md")).toContain(
      "Use a parity decomposition of the curvature identity",
    );
  });

  it("restarts an in-progress independent check without losing or duplicating it", async () => {
    const claim = trajectoryOutput({
      claims: [
        {
          title: "Restart-stable criterion",
          statementMarkdown: "The confirmed widget is round.",
          proofMarkdown:
            "The normalized curvature defect is nonnegative and has integral zero, so it vanishes identically; the defining rigidity criterion then gives roundness.",
          relationToGoal: "PROVES",
        },
      ],
    });
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      call(TRAJECTORY_WORKER_MATCH, "/T001/", claim, "th-restart-worker"),
      {
        match: { promptContains: VERIFICATION_MATCH, cwdContains: "/V001/" },
        threadId: "th-check-before-restart",
        behavior: "hang",
      },
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      call(VERIFICATION_MATCH, "/V001/", verificationOutput("PASS"), "th-check-after-restart"),
      plannerCall(TRAJECTORY_FINAL_MATCH, finalOutput("# Final report\n\nThe checked criterion proves the result.")),
    ];
    const h = Harness.create(
      "trajectory-verification-restart",
      calls,
      trajectoryTestConfig((config) => {
        config.trajectory.verifiersPerClaim = 1;
        config.trajectory.passesRequired = 1;
      }),
    );
    current = h;
    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "v2 W000");
    const pauseBeforeSummary = (event: { type: string }): void => {
      if (event.type === "verification.started") h.engine.pause("test-restart-checkpoint");
    };
    h.engine.on("event", pauseBeforeSummary);
    h.confirm();
    await h.waitFor(
      (state) =>
        state.verifications["V001"]?.status === "running" &&
        state.waves["W001"]?.status === "closed" &&
        state.paused,
      "paused project with a running check",
      30_000,
    );
    h.engine.off("event", pauseBeforeSummary);
    const callDeadline = Date.now() + 3_000;
    while (!h.simLog().some((row) => row.cwd.includes("/V001/"))) {
      if (Date.now() >= callDeadline) throw new Error("verification process did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await h.stop();
    await h.reload();
    h.engine.resume("test-restart");
    h.start();
    await h.waitForTerminal(30_000);

    expect(h.state.verifications["V001"]).toMatchObject({
      status: "completed",
      verdict: "PASS",
    });
    expect(h.diskEvents().filter((event) => event.type === "verification.started")).toHaveLength(1);
    expect(h.diskEvents().filter((event) => event.type === "verification.completed")).toHaveLength(1);
    expect(h.state.claims["K001"]?.status).toBe("VERIFIED");
    expect(h.state.factOrder).toEqual(["F001"]);
  }, 40_000);

  it("recovers a validated trajectory return written just before task completion without another model call", async () => {
    const returned = trajectoryOutput({
      conclusion: "PROVED",
      claims: [
        {
          title: "Durable return criterion",
          statementMarkdown: "The confirmed widget is round.",
          proofMarkdown:
            "Integrating the nonnegative rigidity defect gives zero, so the defect vanishes identically and the widget is round.",
          relationToGoal: "PROVES",
        },
      ],
    });
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      call(TRAJECTORY_WORKER_MATCH, "/T001/", returned, "th-durable-worker"),
      call(VERIFICATION_MATCH, "/V001/", verificationOutput("PASS"), "th-first-durable-check"),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(TRAJECTORY_FINAL_MATCH, finalOutput("# First report\n\nThe result is checked.")),
      call(VERIFICATION_MATCH, "/V001/", verificationOutput("PASS"), "th-recovered-durable-check"),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(TRAJECTORY_FINAL_MATCH, finalOutput("# Recovered report\n\nThe result is checked.")),
    ];
    const h = Harness.create(
      "trajectory-return-recovery",
      calls,
      trajectoryTestConfig((config) => {
        config.trajectory.verifiersPerClaim = 1;
        config.trajectory.passesRequired = 1;
      }),
    );
    current = h;
    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "v2 W000");
    h.confirm();
    await h.waitForTerminal(30_000);
    await h.stop();

    expect(h.exists("tasks/T001/output.json")).toBe(true);
    h.truncateLogFrom((event) => event.type === "task.completed");
    await h.reload();
    expect(h.state.tasks["T001"]?.status).toBe("running");
    h.start();
    await h.waitForTerminal(30_000);

    const workerCalls = h.simLog().filter((row) => row.prompt.includes(TRAJECTORY_WORKER_MATCH));
    expect(workerCalls).toHaveLength(1);
    expect(h.state.tasks["T001"]?.status).toBe("completed");
    expect(h.state.tasks["T001"]?.usage).toEqual(USAGE);
    expect(h.state.factOrder).toEqual(["F001"]);
    expect(h.diskState()).toEqual(h.state);
  });

  it("recovers a valid return rejected by the former row-break delimiter check", async () => {
    const returned = trajectoryOutput({
      claims: [
        {
          title: "Coprime-index summation",
          statementMarkdown: String.raw`The coefficient is $\sum_{\substack{k\ge1\\(k,p,q)\ne(0,0,0)}} a_k$.`,
          proofMarkdown:
            "For each fixed degree only finitely many indices occur, so collecting the displayed coefficients proves the identity.",
          relationToGoal: "PARTIAL",
        },
      ],
    });
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      call(TRAJECTORY_WORKER_MATCH, "/T001/", returned, "th-old-delimiter-worker"),
      call(VERIFICATION_MATCH, "/V001/", verificationOutput("PASS"), "th-first-old-delimiter-check"),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(TRAJECTORY_FINAL_MATCH, finalOutput("# First report\n\nThe result is checked.")),
      call(VERIFICATION_MATCH, "/V001/", verificationOutput("PASS"), "th-recovered-old-delimiter-check"),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(TRAJECTORY_FINAL_MATCH, finalOutput("# Recovered report\n\nThe result is checked.")),
    ];
    const h = Harness.create(
      "trajectory-invalid-output-recovery",
      calls,
      trajectoryTestConfig((config) => {
        config.trajectory.verifiersPerClaim = 1;
        config.trajectory.passesRequired = 1;
      }),
    );
    current = h;
    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "v2 W000");
    h.confirm();
    await h.waitForTerminal(30_000);
    await h.stop();

    h.truncateLogFrom((event) => event.type === "task.completed");
    unlinkSync(`${h.paths.tasksDir}/T001/output.json`);
    const meta = JSON.parse(h.read("tasks/T001/meta.json")) as Record<string, unknown>;
    writeFileSync(
      `${h.paths.tasksDir}/T001/meta.json`,
      JSON.stringify({ ...meta, status: "failed" }, null, 2),
    );
    const historical = h.diskEvents();
    const last = historical.at(-1)!;
    const damaged = [
      ...historical,
      {
        type: "task.outputInvalid",
        taskId: "T001",
        errors: ["claims.0.statementMarkdown: has unmatched \\( ... \\) delimiters"],
        seq: last.seq + 1,
        ts: "2026-08-30T00:00:00.000Z",
      },
      {
        type: "task.failed",
        taskId: "T001",
        error: "output invalid after repair: claims.0.statementMarkdown: has unmatched \\( ... \\) delimiters",
        seq: last.seq + 2,
        ts: "2026-08-30T00:00:01.000Z",
      },
    ];
    writeFileSync(
      h.paths.eventsFile,
      damaged.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );

    await h.reload();
    expect(h.state.tasks.T001).toMatchObject({
      status: "completed",
      error: null,
      invalidOutputErrors: null,
      chargedTokens: 1_100,
    });
    expect(h.state.claims.K001?.statement).toContain(String.raw`\\(k,p,q)`);
    expect(h.exists("writeups/A001.md")).toBe(true);
    expect(JSON.parse(h.read("tasks/T001/meta.json"))).toMatchObject({
      status: "completed",
      recoveredFromRejectedOutput: true,
    });

    h.start();
    await h.waitForTerminal(30_000);
    expect(h.simLog().filter((row) => row.prompt.includes(TRAJECTORY_WORKER_MATCH))).toHaveLength(1);
    expect(h.state.claims.K001?.status).toBe("VERIFIED");
    expect(h.diskState()).toEqual(h.state);
  });

  it("preserves and charges partial work when a long trajectory is interrupted", async () => {
    const partial =
      "A partial calculation reduces the problem to checking the vanishing of one explicit boundary term.";
    const structuredPartial = JSON.stringify({
      conclusion: "UNCERTAIN",
      summaryMarkdown: partial,
      writeupMarkdown: `${partial}\n\nThe remaining boundary term has not been checked.`,
      claims: [],
      milestones: [],
    });
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      {
        match: { promptContains: TRAJECTORY_WORKER_MATCH, cwdContains: "/T001/" },
        threadId: "th-interrupted-partial",
        behavior: "hang",
        items: [
          { type: "agent_message", text: structuredPartial },
          ...Array.from({ length: 14 }, (_, index) => ({
            type: "reasoning",
            text: `Extended calculation step ${index + 1}.`,
          })),
        ],
      },
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(
        TRAJECTORY_FINAL_MATCH,
        finalOutput("# Final report\n\nThe interrupted calculation remains an unchecked partial direction."),
      ),
    ];
    const h = Harness.create(
      "trajectory-partial-accounting",
      calls,
      trajectoryTestConfig((config) => {
        config.budget.defaultTaskTokens = 60_000;
      }),
    );
    current = h;
    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "v2 W000");
    h.confirm();
    await h.waitForTerminal(30_000);

    expect(h.state.tasks.T001?.status).toBe("interrupted");
    expect(h.state.tasks.T001?.chargedTokens).toBeGreaterThan(0);
    expect(h.state.budget.spentTokens).toBeGreaterThanOrEqual(h.state.tasks.T001!.chargedTokens);
    expect(h.read("tasks/T001/salvage.md")).toContain(partial);
    expect(h.state.waves.W001?.docketMarkdown).toContain("Partial notes preserved");
    expect(h.state.waves.W001?.docketMarkdown).toContain(partial);
    expect(h.state.waves.W001?.docketMarkdown).not.toContain('"summaryMarkdown"');
    expect(h.engine.taskDetail("T001").partialWorkMarkdown).toContain(
      "The remaining boundary term has not been checked.",
    );
    expect(h.eventsOfType("task.accounted")).toHaveLength(1);
    expect(JSON.parse(h.read("tasks/T001/meta.json"))).toMatchObject({
      usageReported: false,
      accountingBasis: "estimated",
    });
    expect(h.diskState()).toEqual(h.state);
  });

  it("resumes the same trajectory after a conductor restart without recording a failure", async () => {
    const resumedOutput = trajectoryOutput({
      summaryMarkdown: "The resumed calculation completed the intended argument.",
      writeupMarkdown:
        "# Resumed calculation\n\nThe remaining identity follows by direct substitution, completing this trajectory.",
    });
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      {
        match: { promptContains: TRAJECTORY_WORKER_MATCH, cwdContains: "/T001/" },
        threadId: "th-restartable-trajectory",
        behavior: "hang",
        items: [
          { type: "agent_message", text: "The first half of the calculation is complete." },
          ...Array.from({ length: 4 }, (_, index) => ({
            type: "reasoning",
            text: `Long calculation segment ${index + 1}.`,
          })),
        ],
      },
      {
        match: { resumeOf: "th-restartable-trajectory", cwdContains: "/T001/" },
        threadId: "th-restartable-trajectory",
        finalMessage: resumedOutput,
        usage: USAGE,
      },
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(
        TRAJECTORY_FINAL_MATCH,
        finalOutput("# Final report\n\nThe restarted trajectory completed normally."),
      ),
    ];
    const h = Harness.create("trajectory-restart-resume", calls, trajectoryTestConfig());
    current = h;
    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "v2 W000");
    h.confirm();
    await h.waitFor(
      (state) => state.tasks.T001?.threadId === "th-restartable-trajectory",
      "first trajectory thread",
    );

    await h.stop();
    const firstSegmentCharge = h.state.tasks.T001?.chargedTokens ?? 0;
    expect(h.state.tasks.T001?.status).toBe("running");
    expect(firstSegmentCharge).toBeGreaterThan(0);
    expect(h.eventsOfType("task.interrupted")).toHaveLength(0);

    await h.reload();
    expect(h.state.tasks.T001?.status).toBe("running");
    h.start();
    await h.waitForTerminal(30_000);

    const workerCalls = h.simLog().filter((row) => row.cwd.includes("/T001/"));
    expect(workerCalls).toHaveLength(2);
    expect(workerCalls[1]?.resumeOf).toBe("th-restartable-trajectory");
    expect(h.eventsOfType("task.dispatched")).toHaveLength(1);
    expect(h.eventsOfType("task.interrupted")).toHaveLength(0);
    expect(h.state.tasks.T001).toMatchObject({ status: "completed", usage: USAGE });
    expect(h.state.tasks.T001!.chargedTokens).toBeGreaterThanOrEqual(firstSegmentCharge + 1_100);
    expect(h.diskState()).toEqual(h.state);
  });

  it("recovers a saved independent-check result without checking the claim twice", async () => {
    const returned = trajectoryOutput({
      conclusion: "PROVED",
      claims: [
        {
          title: "Durable verification criterion",
          statementMarkdown: "The confirmed widget is round.",
          proofMarkdown:
            "The nonnegative rigidity defect integrates to zero and hence vanishes, which is exactly the roundness criterion.",
          relationToGoal: "PROVES",
        },
      ],
    });
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      call(TRAJECTORY_WORKER_MATCH, "/T001/", returned, "th-verifier-durable-worker"),
      call(VERIFICATION_MATCH, "/V001/", verificationOutput("PASS"), "th-durable-verifier"),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(TRAJECTORY_FINAL_MATCH, finalOutput("# First report\n\nThe result is checked.")),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(TRAJECTORY_FINAL_MATCH, finalOutput("# Recovered report\n\nThe result is checked.")),
    ];
    const h = Harness.create(
      "trajectory-verification-output-recovery",
      calls,
      trajectoryTestConfig((config) => {
        config.trajectory.verifiersPerClaim = 1;
        config.trajectory.passesRequired = 1;
      }),
    );
    current = h;
    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "v2 W000");
    h.confirm();
    await h.waitForTerminal(30_000);
    await h.stop();

    expect(h.exists("verifications/V001/output.json")).toBe(true);
    h.truncateLogFrom((event) => event.type === "verification.completed");
    await h.reload();
    expect(h.state.verifications["V001"]?.status).toBe("running");
    h.start();
    await h.waitForTerminal(30_000);

    const checkCalls = h.simLog().filter((row) => row.prompt.includes(VERIFICATION_MATCH));
    expect(checkCalls).toHaveLength(1);
    expect(h.state.verifications["V001"]).toMatchObject({ status: "completed", verdict: "PASS" });
    expect(h.state.verifications["V001"]?.usage).toEqual(USAGE);
    expect(h.state.factOrder).toEqual(["F001"]);
    expect(h.diskState()).toEqual(h.state);
  });

  it("repairs a crash between verifying a claim and recording its fact", async () => {
    const claim = trajectoryOutput({
      claims: [
        {
          title: "Crash-stable criterion",
          statementMarkdown: "The confirmed widget is round.",
          proofMarkdown:
            "The rigidity identity expresses the squared defect as a nonnegative function with zero integral. Thus the defect vanishes and the widget is round.",
          relationToGoal: "PROVES",
        },
      ],
    });
    const calls: SimCall[] = [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      call(TRAJECTORY_WORKER_MATCH, "/T001/", claim, "th-repair-worker"),
      call(VERIFICATION_MATCH, "/V001/", verificationOutput("PASS"), "th-repair-check"),
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(TRAJECTORY_FINAL_MATCH, finalOutput("# First final report\n\nThe checked claim proves the result.")),
      plannerCall(TRAJECTORY_FINAL_MATCH, finalOutput("# Recovered final report\n\nThe checked claim proves the result.")),
    ];
    const h = Harness.create(
      "trajectory-promotion-repair",
      calls,
      trajectoryTestConfig((config) => {
        config.trajectory.verifiersPerClaim = 1;
        config.trajectory.passesRequired = 1;
      }),
    );
    current = h;
    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "v2 W000");
    h.confirm();
    await h.waitForTerminal(30_000);
    await h.stop();

    h.truncateLogFrom((event) => event.type === "fact.recorded");
    await h.reload();
    expect(h.state.claims["K001"]?.status).toBe("VERIFIED");
    expect(h.state.factOrder).toEqual([]);
    h.start();
    await h.waitForTerminal(30_000);

    expect(h.state.factOrder).toEqual(["F001"]);
    expect(h.state.claims["K001"]?.promotedFactId).toBe("F001");
    expect(h.diskEvents().filter((event) => event.type === "fact.recorded")).toHaveLength(1);
    expect(h.diskState()).toEqual(h.state);
  });
});
