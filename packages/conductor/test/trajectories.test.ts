import { afterEach, describe, expect, it } from "vitest";
import type { SimCall } from "./helpers/harness.js";
import {
  Harness,
  INTAKE_MATCH,
  SUMMARY_REVIEW_MATCH,
  TRAJECTORY_FINAL_MATCH,
  TRAJECTORY_WORKER_MATCH,
  USAGE,
  VERIFICATION_MATCH,
  finalOutput,
  intakeOutput,
  plannerCall,
  summaryRevisionOutput,
  trajectoryOutput,
  trajectoryTestConfig,
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
    expect(h.exists("claims/K001.md")).toBe(true);
    expect(h.exists("facts/F001.md")).toBe(true);
    expect(h.exists("writeups/A001.md")).toBe(true);
    expect(h.read("tasks/T001/packet/owner-guidance.md")).toContain(
      "Try the curvature identity before introducing auxiliary machinery.",
    );
    expect(h.read(h.state.terminal!.finalPath)).not.toContain("Research Manager");
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
    const launchedTaskDirs = h
      .simLog()
      .map((row) => /\/tasks\/(T\d{3})\//.exec(row.cwd)?.[1])
      .filter((id): id is string => id !== undefined)
      .sort();
    expect(launchedTaskDirs).toEqual(["T001", "T002", "T003", "T004"]);
    expect(h.diskState()).toEqual(h.state);
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
    expect(h.state.claims["K001"]?.status).toBe("REFUTED");
    expect(h.state.factOrder).toEqual([]);
  });

  it("does not leave a claim permanently active when every configured check finishes without the required passes", async () => {
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
      plannerCall(SUMMARY_REVIEW_MATCH, summaryRevisionOutput()),
      plannerCall(
        TRAJECTORY_FINAL_MATCH,
        finalOutput("# Final report\n\nThe alleged shortcut did not complete independent checking."),
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

    expect(h.state.claims["K001"]?.status).toBe("REFUTED");
    expect(h.state.claims["K001"]?.history.at(-1)?.justification).toContain("1 process error");
    expect(h.state.verifications["V001"]?.verdict).toBe("ERROR");
    expect(h.state.factOrder).toEqual([]);
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
