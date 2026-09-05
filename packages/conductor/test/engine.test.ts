import { unlinkSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  Harness,
  INTAKE_MATCH,
  PUBLICATION_MATCH,  USAGE, researchStopCalls, intakeOutput, plannerCall,
  publicationOutput, recurrentTestConfig, type SimCall
} from "./helpers/harness.js";

/**
 * Shared intake and publication verification: a real ProjectEngine driven against the
 * codex-sim fake CLI, one scripted scenario per active lifecycle path.
 *
 * Every sim call is discriminated by prompt substring (reader calls) or by
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

function harness(name: string, calls: SimCall[], config = recurrentTestConfig(c => { c.budget.totalTokens = 5_000_000; })): Harness {
  const h = Harness.create(name, calls, config);
  current = h;
  return h;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- shared scenario fragments ---------------------------------------------

async function runToConfirmation(h: Harness): Promise<void> {
  h.start();
  await h.waitFor((s) => s.phase === "AWAITING_CONFIRMATION", "intake to finish");
  h.confirm();
}

// ---------------------------------------------------------------------------

describe("ProjectEngine end-to-end (codex-sim)", () => {
  it("records W000 over the retained raw intake and accepts the owner's direct edit", async () => {
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
    expect(h.state.mathematicalViews).toEqual([
      expect.objectContaining({ waveId: "W000", source: "intake" }),
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

    expect(h.state.mathematicalViews).toEqual([
      expect.objectContaining({
        waveId: "W000",
        source: "human_edited",
        abstract: "The owner has specified the intended geometric interpretation.",
      }),
    ]);
    expect(h.read("artifacts/mathematical-view/W000.md")).toContain("intended geometric interpretation");
  });

  it("unlocks W000 after a regeneration process is interrupted and restarted", async () => {
    const h = harness("w000-regeneration-recovery", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      plannerCall(INTAKE_MATCH, {
        ...intakeOutput(),
        managerAbstract: "A regenerated view of the same objective.",
        managerNoteMarkdown: "# Current mathematical view\n\nA regenerated view.",
      }),
    ]);

    h.start();
    await h.waitFor((state) => state.phase === "AWAITING_CONFIRMATION", "first W000 preview");
    await h.engine.regenerateIntake();
    expect(h.state.decisions["DEC002"]?.status).toBe("accepted");

    // Leave exactly the durable state a hard stop during the model call would
    // leave: the request exists, but no response closes it.
    await h.stop();
    h.truncateLogFrom(
      (event) => event.type === "decision.proposed" && event.decisionId === "DEC002",
    );
    await h.reload();
    expect(h.state.decisions["DEC002"]?.status).toBe("requested");
    expect(h.engine.canReviseRawIntake()).toBe(false);

    h.start();
    await h.waitFor(
      (state) => state.decisions["DEC002"]?.status === "rejected",
      "interrupted W000 request to be closed",
    );
    expect(h.state.phase).toBe("AWAITING_CONFIRMATION");
    expect(h.engine.canReviseRawIntake()).toBe(true);
    expect(h.state.decisions["DEC002"]?.violations.at(-1)?.join(" ")).toContain(
      "previous W000 was preserved",
    );
  });

  it("retries local PDF compilation without another mathematical reader call", async () => {
    const h = harness("publication-retry", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      ...researchStopCalls("# Final report\n\nThe planar reduction is established, but the last implication remains open."),
      plannerCall(PUBLICATION_MATCH, publicationOutput()),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();
    expect(h.state.terminal?.result).toBe("UNCERTAIN");

    h.publicationCompiler.failuresRemaining = 1;
    expect(h.engine.requestPublication()).toBe("P001");
    await h.waitFor(
      (state) => state.publications[0]?.status === "drafted",
      "saved TeX before compilation",
    );
    const modelCallsAfterDraft = h.simLog().length;
    h.engine.requestPublicationCompilation("P001");
    await h.waitFor(
      (state) => state.publications[0]?.status === "failed",
      "first PDF compilation to fail",
    );
    expect(h.state.publications[0]).toMatchObject({
      status: "failed",
      failureStage: "compilation",
      texPath: "publications/P001/manuscript.tex",
    });
    expect(h.read("publications/P001/compile.log")).toContain("did not compile");

    await h.stop();
    await h.reload();
    h.start();
    expect(h.state.publications[0]?.status).toBe("failed");

    // Opening an existing manuscript is idempotent and never compiles it.
    expect(h.engine.requestPublication()).toBe("P001");
    expect(h.publicationCompiler.compileCalls).toBe(1);
    h.engine.requestPublicationCompilation("P001");
    await h.waitFor(
      (state) => state.publications[0]?.status === "ready",
      "retried PDF compilation",
    );
    expect(h.publicationCompiler.compileCalls).toBe(2);
    expect(h.simLog()).toHaveLength(modelCallsAfterDraft);
    expect(h.state.publications).toHaveLength(1);
    expect(h.eventsOfType("publication.compilationRequested")).toHaveLength(2);
    expect(h.read("publications/P001/manuscript.pdf").startsWith("%PDF-")).toBe(true);
  });

  it("saves TeX even when the local PDF compiler is unavailable", async () => {
    const h = harness("publication-without-compiler", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      ...researchStopCalls("# Final report\n\nA partial theorem remains."),
      plannerCall(PUBLICATION_MATCH, publicationOutput()),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();
    h.publicationCompiler.available = false;
    h.engine.requestPublication();
    await h.waitFor(
      (state) => state.publications[0]?.status === "drafted",
      "TeX manuscript without compiler",
    );
    expect(h.read("publications/P001/manuscript.tex")).toContain("\\documentclass");
    expect(h.publicationCompiler.compileCalls).toBe(0);

    h.engine.requestPublicationCompilation("P001");
    expect(h.state.publications[0]).toMatchObject({
      status: "failed",
      failureStage: "compilation",
      texPath: "publications/P001/manuscript.tex",
      error: expect.stringContaining("compiler not installed"),
    });
    expect(h.publicationCompiler.compileCalls).toBe(0);
  });

  it("repairs a draft that leaks internal labels before accepting its TeX", async () => {
    const publicationThread = "th-publication-private-label";
    const h = harness("publication-validation-repair", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      ...researchStopCalls("# Final report\n\nA partial reduction is proved."),
      plannerCall(
        PUBLICATION_MATCH,
        publicationOutput({
          bodyTex: "\\section{Internal note}\nThe argument appears in W000, A001, and E001.\\input{private-note}",
        }),
        { threadId: publicationThread },
      ),
      {
        match: { resumeOf: publicationThread },
        finalMessage: publicationOutput({
          bodyTex:
            "\\section{Partial result}\n\\begin{proposition}The planar reduction holds.\\end{proposition}\n" +
            "\\begin{proof}Apply the stated decomposition.\\end{proof}",
        }),
        usage: USAGE,
      },
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();
    h.engine.requestPublication();
    await h.waitFor(
      (state) => state.publications[0]?.status === "drafted",
      "repaired standalone TeX manuscript",
    );

    const tex = h.read("publications/P001/manuscript.tex");
    expect(tex).not.toMatch(/W000|A001|E001|\\input/);
    expect(tex).toContain("\\section{Partial result}");
    expect(h.simLog().some((row) => row.resumeOf === publicationThread)).toBe(true);
    expect(h.state.budget.plannerSpentTokens).toBe(3 * 1100);
    expect(h.publicationCompiler.compileCalls).toBe(0);
  });

  it("closes the publication decision when drafting cannot begin", async () => {
    const h = harness("publication-missing-report", [
      plannerCall(INTAKE_MATCH, intakeOutput()),
      ...researchStopCalls("# Final report\n\nNo complete proof was obtained."),
    ]);

    await runToConfirmation(h);
    await h.waitForTerminal();
    unlinkSync(h.paths.dir + "/" + h.state.terminal!.finalPath);
    h.engine.requestPublication();
    await h.waitFor(
      (state) => state.publications[0]?.status === "failed",
      "missing stopping report failure",
    );

    expect(h.state.publications[0]).toMatchObject({
      failureStage: "drafting",
      error: "stopping report is missing: " + h.state.terminal!.finalPath,
    });
    expect(h.state.decisions["DEC002"]).toMatchObject({
      kind: "publication",
      status: "rejected",
    });
    expect(h.simLog()).toHaveLength(5);
  });

  });
