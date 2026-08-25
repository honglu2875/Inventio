import { describe, expect, it } from "vitest";
import {
  candidateLifecycle,
  deriveEvidenceGraph,
  deriveOpsGraph,
  initialState,
  replay,
} from "../src/index.js";
import { buildCanonicalEvents } from "./fixtures.js";

function stateBeforeAbandonment() {
  const events = buildCanonicalEvents();
  const cut = events.findIndex((e) => e.type === "lineage.abandoned");
  return replay(initialState(), events.slice(0, cut));
}

describe("ops graph", () => {
  it("projects waves, tasks, candidates, reviews, memory, questions", () => {
    const g = deriveOpsGraph(stateBeforeAbandonment());
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const expected of ["problem", "W001", "T001", "T002", "T003", "C001", "C001.v1", "R001", "memory"]) {
      expect(ids.has(expected), `missing node ${expected}`).toBe(true);
    }
    // tasks are children of their wave
    const t1 = g.nodes.find((n) => n.id === "T001")!;
    expect(t1.parentId).toBe("W001");
    // sequence edge problem -> W001
    expect(g.edges.some((e) => e.type === "sequence" && e.source === "problem" && e.target === "W001")).toBe(true);
    // frozen-from edge from producing task to candidate
    expect(g.edges.some((e) => e.type === "frozen-from" && e.source === "T001" && e.target === "C001.v1")).toBe(true);
    // review edge with verdict label
    expect(g.edges.some((e) => e.type === "reviews" && e.source === "R001" && e.target === "C001.v1" && e.label === "FAIL")).toBe(true);
  });

  it("is a pure function of state (same state, same graph)", () => {
    const s = stateBeforeAbandonment();
    expect(deriveOpsGraph(s)).toEqual(deriveOpsGraph(s));
  });

  it("adds a final node once terminal", () => {
    const s = replay(initialState(), buildCanonicalEvents());
    const g = deriveOpsGraph(s);
    expect(g.nodes.some((n) => n.id === "final" && n.label === "RESULT: UNCERTAIN")).toBe(true);
  });
});

describe("candidate lifecycle", () => {
  it("keeps an author conclusion separate from a failed independent review", () => {
    const state = stateBeforeAbandonment();
    const lifecycle = candidateLifecycle(state, "C001.v1");
    expect(lifecycle.stage).toBe("FAILED_REVIEW");
    expect(lifecycle.failReviews).toBe(1);
    expect(lifecycle.authorConclusion).toBe("UNCERTAIN");
  });

  it("marks a replaced, never-reviewed version explicitly", () => {
    const state = stateBeforeAbandonment();
    const v1 = state.candidates["C001.v1"]!;
    v1.reviewIds = [];
    v1.issueIds = [];
    v1.acceptance = null;
    state.candidates["C001.v2"] = {
      ...v1,
      id: "C001.v2",
      version: 2,
      reviewIds: [],
      issueIds: [],
      acceptance: null,
    };
    state.lineages["C001"]!.versionIds.push("C001.v2");
    expect(candidateLifecycle(state, "C001.v1").stage).toBe("SUPERSEDED_UNREVIEWED");
    expect(candidateLifecycle(state, "C001.v2").stage).toBe("AWAITING_REVIEW");
  });

  it("recognizes the version established by the event record", () => {
    const state = replay(initialState(), buildCanonicalEvents());
    expect(candidateLifecycle(state, "C002.v1").stage).toBe("ACCEPTED");
  });
});

describe("evidence graph", () => {
  it("builds the claim closure with uses/depends-on/attacks edges", () => {
    const g = deriveEvidenceGraph(stateBeforeAbandonment());
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const expected of ["C001.v1", "K001", "K002", "I001", "C001.v1:ob1"]) {
      expect(ids.has(expected), `missing node ${expected}`).toBe(true);
    }
    expect(g.edges.some((e) => e.type === "uses" && e.source === "C001.v1" && e.target === "K001")).toBe(true);
    expect(g.edges.some((e) => e.type === "depends-on" && e.source === "K002" && e.target === "K001")).toBe(true);
    // issue location mentions K002, so it attacks the claim, not the candidate
    expect(g.edges.some((e) => e.type === "attacks" && e.source === "I001" && e.target === "K002")).toBe(true);
  });

  it("returns an empty graph when no lineage is active", () => {
    const s = replay(initialState(), buildCanonicalEvents());
    expect(deriveEvidenceGraph(s).nodes).toEqual([]);
  });
});
