import { describe, expect, it } from "vitest";
import {
  EVENT_TYPES,
  EventSchema,
  INTAKE_ABSTRACT_MAX_CHARS,
  IntakeOutput,
  ProjectConfig,
  applyEvent,
  defaultConfig,
  initialState,
  nextContinuationRevisionId,
  pendingIntakeDecision,
  pendingContinuationRevision,
  replay,
  usageSpend,
  validateActionEnvelope,
  workerOutputJsonSchema,
} from "../src/index.js";
import { buildCanonicalEvents } from "./fixtures.js";

describe("event taxonomy", () => {
  it("canonical fixture covers every event type and every event validates", () => {
    const events = buildCanonicalEvents();
    const used = new Set(events.map((e) => e.type));
    const missing = EVENT_TYPES.filter((t) => !used.has(t));
    expect(missing).toEqual([]);
    for (const e of events) {
      const parsed = EventSchema.safeParse(e);
      expect(parsed.success, `event ${e.seq} ${e.type}: ${JSON.stringify(parsed.success ? "" : parsed.error.issues)}`).toBe(true);
    }
  });
});

describe("intake abstracts", () => {
  const validIntake = {
    problemMarkdown: "# Problem\n\nProve the statement.",
    contextDigestMarkdown: "",
    rawMemories: [],
    managerAbstract: "The objective is to prove the statement, and the main obstacle is compactness.",
    managerNoteMarkdown: "# Current mathematical view\n\nThe compactness issue is central.",
    sourceSummaries: [
      {
        sourceId: "S001",
        abstract: "This note proposes reducing the theorem to a compactness lemma.",
        excerptMarkdown: "Proposed reduction: establish the compactness lemma first.",
      },
    ],
    ambiguities: [],
    clarifications: [],
    notes: "",
  };

  it("accepts short, complete, single-paragraph navigation summaries", () => {
    expect(IntakeOutput.safeParse(validIntake).success).toBe(true);
  });

  it("rejects overflowing, outline-like, and unfinished summaries", () => {
    expect(
      IntakeOutput.safeParse({
        ...validIntake,
        managerAbstract: `${"A".repeat(INTAKE_ABSTRACT_MAX_CHARS)}.`,
      }).success,
    ).toBe(false);
    expect(
      IntakeOutput.safeParse({
        ...validIntake,
        managerAbstract: "Objective: prove the statement.\nOutline: reduce to a lemma.",
      }).success,
    ).toBe(false);
    expect(
      IntakeOutput.safeParse({
        ...validIntake,
        sourceSummaries: [{ ...validIntake.sourceSummaries[0]!, abstract: "An unfinished summary" }],
      }).success,
    ).toBe(false);
  });
});

describe("reducer", () => {
  it("derives an in-progress intake reading from durable decision state", () => {
    const state = initialState();
    applyEvent(state, {
      type: "project.created",
      slug: "intake-busy",
      title: "Intake busy",
      statement: "Prove P.",
      config: defaultConfig(),
      seq: 1,
      ts: "created",
    });
    applyEvent(state, {
      type: "decision.requested",
      decisionId: "DEC001",
      kind: "intake",
      waveId: null,
      seq: 2,
      ts: "requested",
    });
    expect(pendingIntakeDecision(state)?.id).toBe("DEC001");

    applyEvent(state, {
      type: "decision.proposed",
      decisionId: "DEC001",
      action: null,
      usage: null,
      seq: 3,
      ts: "finished",
    });
    expect(pendingIntakeDecision(state)).toBeNull();
  });

  it("derives W###.2 continuation views before any later research round", () => {
    const events = buildCanonicalEvents();
    const continuedAt = events.findIndex((event) => event.type === "project.continued");
    const state = replay(initialState(), events.slice(0, continuedAt + 2));

    expect(state.terminal).toBeNull();
    expect(pendingContinuationRevision(state)?.note).toContain("parity reduction");
    expect(nextContinuationRevisionId(state)).toBe("W001.2");

    applyEvent(
      state,
      EventSchema.parse({
        type: "manager.noteRecorded",
        waveId: "W001.2",
        path: "artifacts/manager-notes/W001.2.md",
        markdown: "The renewed view keeps the parity reduction and broadens the search.",
        abstract: "The renewed view broadens the search.",
        source: "research_manager",
        seq: state.seq + 1,
        ts: "2026-08-26T00:00:00.000Z",
      }),
    );
    expect(pendingContinuationRevision(state)).toBeNull();
    expect(nextContinuationRevisionId(state)).toBe("W001.3");
  });

  it("does not insert a retroactive revision into a legacy continuation that already planned work", () => {
    const events = buildCanonicalEvents();
    const continuedAt = events.findIndex((event) => event.type === "project.continued");
    const state = replay(initialState(), events.slice(0, continuedAt + 2));
    applyEvent(
      state,
      EventSchema.parse({
        type: "wave.planned",
        waveId: "W002",
        title: "Legacy post-continuation round",
        decisionId: "DEC999",
        roster: [],
        reserveTokens: 0,
        rationale: "This round was already planned by an older engine.",
        seq: state.seq + 1,
        ts: "2026-08-26T00:00:01.000Z",
      }),
    );
    expect(pendingContinuationRevision(state)).toBeNull();
  });

  it("loads legacy configs with a strong Research Manager default", () => {
    const legacy = defaultConfig() as unknown as Record<string, unknown>;
    const models = { ...(legacy.models as Record<string, unknown>) };
    delete models.researchManager;
    legacy.models = models;
    const parsed = ProjectConfig.parse(legacy);
    expect(parsed.models.researchManager).toEqual({ model: "gpt-5.6-sol", effort: "max" });
  });

  it("persists unified project settings while retaining legacy compatibility fields", () => {
    const state = replay(initialState(), buildCanonicalEvents());
    expect(state.config.models.solver).toEqual({ model: "gpt-5.6-sol", effort: "max" });
    expect(state.config.models.researchManager).toEqual({
      model: "gpt-5.6-sol",
      effort: "max",
    });
    expect(state.config.models.planner).toEqual({ model: null, effort: "high" });
    expect(state.config.allowWebSearch).toBe(true);
    expect(state.config.autonomy).toBe("auto");
    // The canonical history later continues once with another 100k tokens
    // and two rounds; both extensions must remain reflected in config.
    expect(state.config.budget.totalTokens).toBe(40_100_000);
    expect(state.config.limits.maxWaves).toBe(22);
    expect(state.autonomy).toBe(state.config.autonomy);
  });

  it("folds the canonical sequence without throwing and lands in TERMINAL", () => {
    const state = replay(initialState(), buildCanonicalEvents());
    expect(state.phase).toBe("TERMINAL");
    expect(state.terminal).toEqual({ result: "UNCERTAIN", finalPath: "artifacts/final.md" });
    expect(state.seq).toBe(buildCanonicalEvents().length);
  });

  it("is deterministic: two replays agree exactly", () => {
    const a = replay(initialState(), buildCanonicalEvents());
    const b = replay(initialState(), buildCanonicalEvents());
    expect(a).toEqual(b);
  });

  it("tracks tasks, budget, and counters", () => {
    const state = replay(initialState(), buildCanonicalEvents());
    expect(state.tasks["T001"]!.status).toBe("completed");
    expect(state.tasks["T002"]!.status).toBe("interrupted");
    expect(state.tasks["T003"]!.status).toBe("failed");
    expect(state.tasks["T001"]!.budgetTokens).toBe(1_200_000); // extended
    // one completed task: 10000 - 4000 + 2000
    expect(state.budget.spentTokens).toBe(usageSpend(state.tasks["T001"]!.usage!));
    // two planner proposals with usage
    expect(state.budget.plannerSpentTokens).toBe(2 * 8000);
    expect(state.counters.task).toBe(3);
    expect(state.counters.wave).toBe(1);
    expect(state.counters.claim).toBe(2);
    expect(state.counters.decision).toBe(1);
  });

  it("preserves the original intake context and the owner's edited digest and raw memories", () => {
    const state = replay(initialState(), buildCanonicalEvents());
    expect(state.statement).toBe("Prove that P, keeping every hypothesis explicit.");
    expect(state.contextMarkdown).toContain("revised long literature note");
    expect(state.problem.contextDigestMarkdown).toContain("explicitly unverified");
    expect(state.problem.rawMemories).toHaveLength(1);
    expect(state.problem.rawMemories[0]).toMatchObject({
      title: "Owner-edited induction route",
      tags: ["induction", "parity"],
    });
    expect(state.questions["Q001"]?.interaction).toBe("answer");
    expect(state.questions["Q002"]?.interaction).toBe("acknowledge");
    expect(state.researchManagerNotes).toEqual([
      expect.objectContaining({
        waveId: "W001",
        path: "artifacts/manager-notes/W001.md",
        source: "research_manager",
      }),
    ]);
  });

  it("replaces, rather than duplicates, a manager note when the same round is recovered", () => {
    const events = buildCanonicalEvents();
    const state = replay(initialState(), events);
    applyEvent(state, {
      seq: state.seq + 1,
      ts: "later",
      type: "manager.noteRecorded",
      waveId: "W001",
      path: "artifacts/manager-notes/W001.md",
      markdown: "A corrected current view.",
      source: "research_manager",
    });
    expect(state.researchManagerNotes).toHaveLength(1);
    expect(state.researchManagerNotes[0]?.markdown).toBe("A corrected current view.");
    expect(state.researchManagerNotes[0]?.recordedAt).toBe("later");
  });

  it("marks changed raw source bytes stale but not a summary-only catalog update", () => {
    const state = initialState();
    applyEvent(state, {
      seq: 1,
      ts: "created",
      type: "project.created",
      slug: "raw-revision",
      title: "Raw revision",
      statement: "Prove P.",
      config: defaultConfig(),
    });
    const source = {
      id: "S001",
      kind: "objective" as const,
      title: "Original objective",
      relativePath: "intake/original-objective.md",
      size: 8,
      sha256: "0".repeat(64),
      abstract: "Original summary.",
      excerptMarkdown: "",
    };
    applyEvent(state, { seq: 2, ts: "indexed", type: "intake.sourcesUpdated", sources: [source] });
    expect(state.problem.rawUpdatedAtSeq).toBe(2);

    applyEvent(state, {
      seq: 3,
      ts: "summarized",
      type: "intake.sourcesUpdated",
      sources: [{ ...source, abstract: "A better catalog summary." }],
    });
    expect(state.problem.rawUpdatedAtSeq).toBe(2);

    applyEvent(state, {
      seq: 4,
      ts: "revised",
      type: "intake.sourcesUpdated",
      sources: [{ ...source, sha256: "1".repeat(64) }],
    });
    expect(state.problem.rawUpdatedAtSeq).toBe(4);
  });

  it("preserves stopping history when the owner continues research", () => {
    const state = replay(initialState(), buildCanonicalEvents());
    expect(state.terminalHistory).toHaveLength(2);
    expect(state.continuations).toEqual([
      expect.objectContaining({
        previousResult: "UNCERTAIN",
        note: "Push the parity reduction one step further.",
        addTokens: 100_000,
        addWaves: 2,
        by: "human",
      }),
    ]);
    expect(state.budget.totalTokens).toBe(state.config.budget.totalTokens);
    expect(state.config.limits.maxWaves).toBe(defaultConfig().limits.maxWaves + 2);
    expect(state.terminal).toEqual({ result: "UNCERTAIN", finalPath: "artifacts/final.md" });
  });

  it("tracks candidates, reviews, issues, lineage abandonment", () => {
    const state = replay(initialState(), buildCanonicalEvents());
    const c = state.candidates["C001.v1"]!;
    expect(c.reviewIds).toEqual(["R001"]);
    expect(c.issueIds).toEqual(["I001"]);
    expect(c.acceptance).toEqual({ passed: false, failing: ["open CRITICAL issue I001"] });
    expect(state.issues["I001"]!.status).toBe("resolved");
    expect(state.issues["I001"]!.disposition).toBe("rejected");
    expect(state.lineages["C001"]!.status).toBe("abandoned");
    expect(state.activeLineageId).toBeNull();
  });

  it("rejects out-of-order sequence numbers", () => {
    const events = buildCanonicalEvents();
    const state = replay(initialState(), events);
    expect(() => applyEvent(state, events[0]!)).toThrow(/seq/);
  });

  it("throws on events about unknown entities", () => {
    const state = initialState();
    expect(() =>
      applyEvent(state, {
        seq: 1,
        ts: "t",
        type: "task.completed",
        taskId: "T999",
        usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
      }),
    ).toThrow(/unknown task/);
  });

  it("infers a source task when replaying a legacy claim event", () => {
    const event = EventSchema.parse({
      seq: 1,
      ts: "t",
      type: "claim.added",
      claimId: "K001",
      statement: "A legacy lead.",
      status: "UNVERIFIED",
      provenance: "A001 §2 (from T042)",
      dependsOn: [],
    });
    const state = initialState();
    applyEvent(state, event);
    expect(state.claims.K001?.sourceTaskId).toBe("T042");
  });
});

describe("action envelope", () => {
  const plan = {
    action: "plan_wave",
    plan_wave: {
      title: "W",
      rationale: "r",
      reserveTokens: 0,
      tasks: [
        {
          role: "solver",
          methodTag: "induction",
          direction: "d",
          briefMarkdown: "b",
          tokenBudget: 1000,
          computation: false,
          webSearch: false,
          reviewOf: null,
          grants: { artifactIds: [], cardIds: [], sourceMounts: [] },
        },
      ],
    },
    cross_examine: null,
    freeze_candidate: null,
    assess_results: null,
    record_dispositions: null,
    abandon_lineage: null,
    raise_question: null,
    terminate: null,
  };

  it("accepts a well-formed envelope", () => {
    const r = validateActionEnvelope(plan);
    expect(r.ok).toBe(true);
  });

  it("rejects a null active variant and non-null inactive variants", () => {
    const r1 = validateActionEnvelope({ ...plan, plan_wave: null });
    expect(r1.ok).toBe(false);
    const r2 = validateActionEnvelope({ ...plan, terminate: { rationale: "x" } });
    expect(r2.ok).toBe(false);
  });
});

describe("worker output json schema", () => {
  it("exports draft JSON Schema objects per role", () => {
    for (const role of ["solver", "explorer", "reviewer", "synthesizer"] as const) {
      const js = workerOutputJsonSchema(role) as { type?: string; properties?: Record<string, unknown> };
      expect(js.type).toBe("object");
      expect(js.properties).toBeTruthy();
      expect(Object.keys(js.properties!)).toContain("artifactMarkdown");
      expect(Object.keys(js.properties!)).toContain(role === "reviewer" ? "verdict" : "conclusion");
    }
  });
});
