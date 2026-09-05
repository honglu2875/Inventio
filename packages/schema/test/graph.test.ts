import { describe, expect, it } from "vitest";
import {
  candidateLifecycle,
  deriveEvidenceGraph,
  deriveOpsGraph,
  deriveTrajectoryEvidenceGraph,
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
    for (const expected of ["problem", "W001", "T001", "T002", "T003", "MS001", "C001", "C001.v1", "R001", "memory"]) {
      expect(ids.has(expected), `missing node ${expected}`).toBe(true);
    }
    // tasks are children of their wave
    const t1 = g.nodes.find((n) => n.id === "T001")!;
    expect(t1.parentId).toBe("W001");
    const milestone = g.nodes.find((n) => n.id === "MS001")!;
    expect(milestone.parentId).toBe("W001");
    expect(g.edges).toContainEqual({
      id: "milestone:T001:MS001",
      source: "T001",
      target: "MS001",
      type: "produced",
    });
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

describe("trajectory evidence graph", () => {
  it("shows research trajectories, turning points, active claims, checks, and established facts", () => {
    const events = buildCanonicalEvents();
    const cut = events.findIndex((event) => event.type === "verification.completed");
    const state = replay(initialState(), events.slice(0, cut));
    const graph = deriveTrajectoryEvidenceGraph(state);
    const ids = new Set(graph.nodes.map((node) => node.id));

    for (const expected of ["problem", "T001", "MS001", "K001", "K002", "K003", "V001", "F001"]) {
      expect(ids.has(expected), `missing node ${expected}`).toBe(true);
    }
    expect(graph.edges).toContainEqual({
      id: "trajectory-step:T001:MS001",
      source: "T001",
      target: "MS001",
      type: "sequence",
    });
    expect(graph.edges).toContainEqual({
      id: "produced:MS001:K001",
      source: "MS001",
      target: "K001",
      type: "produced",
      label: "RELATED",
    });
    expect(graph.nodes.find((node) => node.id === "V001")?.label).toBe("V001 RUNNING");
    expect(graph.edges).toContainEqual({
      id: "check:K003:V001",
      source: "K003",
      target: "V001",
      type: "verifies",
      label: "RUNNING",
    });
    expect(graph.edges.some((edge) => edge.type === "promotes" && edge.source === "K001" && edge.target === "F001")).toBe(true);
    expect(graph.edges.some((edge) => edge.type === "equivalent" && new Set([edge.source, edge.target]).has("K001") && new Set([edge.source, edge.target]).has("K002"))).toBe(true);
    expect(graph.edges.some((edge) => edge.type === "attacks" && edge.source === "K003" && edge.target === "F001")).toBe(true);
  });

  it("preserves fact dependencies and their withdrawn provenance", () => {
    const state = stateBeforeAbandonment();
    state.config.workflow = "trajectories-v2";
    state.claims.K003!.dependsOn = ["F001"];
    state.claims.K003!.targetFactId = null;
    state.claims.K003!.status = "NEEDS_REVISION";
    state.facts.F001!.status = "RETRACTED";
    // A cycle must neither hang projection nor hide the original premise.
    state.claims.K001!.dependsOn = ["F001"];
    const graph = deriveTrajectoryEvidenceGraph(state);
    expect(graph.nodes.find((node) => node.id === "F001")?.data.status).toBe("RETRACTED");
    expect(graph.nodes.some((node) => node.id === "K001")).toBe(true);
    expect(graph.edges).toContainEqual({
      id: "claim-dependency:K003:F001", source: "K003", target: "F001", type: "depends-on",
    });
    expect(graph.edges.find((edge) => edge.id === "promotes:K001:F001")?.label).toBe("retracted");
    const ids = new Set(graph.nodes.map((node) => node.id));
    expect(graph.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
  });

  it("keeps open conflicting statements visible even if one proof failed", () => {
    const state = stateBeforeAbandonment();
    state.config.workflow = "trajectories-v2";
    state.facts.F001!.status = "ACTIVE";
    state.claims.K002!.status = "FAILED";
    state.claimConflicts.push({
      leftClaimId: "K001", rightClaimId: "K002", reason: "Incompatible computed values",
      status: "OPEN", recordedAtSeq: 1, resolvedAtSeq: null, resolutionReason: null,
    });
    const graph = deriveTrajectoryEvidenceGraph(state);
    expect(graph.nodes.some((node) => node.id === "K002")).toBe(true);
    expect(graph.nodes.find((node) => node.id === "F001")?.data.status).toBe("UNSETTLED");
    expect(graph.edges.some((edge) => edge.type === "conflicts" && edge.source === "K001" && edge.target === "K002")).toBe(true);
    expect(graph.edges.find((edge) => edge.id === "promotes:K001:F001")?.label).toBe("unsettled");
    state.claimConflicts[0]!.status = "RESOLVED";
    const resolved = deriveTrajectoryEvidenceGraph(state);
    expect(resolved.edges.some((edge) => edge.type === "conflicts")).toBe(false);
    expect(resolved.nodes.some((node) => node.id === "K002")).toBe(false);
  });

  it("supports a focused summary while retaining aggregate check counts", () => {
    const events = buildCanonicalEvents();
    const cut = events.findIndex((event) => event.type === "verification.completed");
    const state = replay(initialState(), events.slice(0, cut));
    state.waves.W001!.status = "closed";

    const focused = deriveTrajectoryEvidenceGraph(state, {
      includeMilestones: false,
      includeVerifications: false,
    });
    const focusedIds = new Set(focused.nodes.map((node) => node.id));
    expect(focusedIds.has("T001")).toBe(true);
    expect(focusedIds.has("T002")).toBe(false);
    expect(focusedIds.has("MS001")).toBe(false);
    expect(focusedIds.has("V001")).toBe(false);
    expect(focused.nodes.find((node) => node.id === "K003")?.data.checkCount).toBe(1);
    expect(focused.edges.some((edge) => edge.source === "T001" && edge.target === "K003" && edge.type === "produced")).toBe(true);

    const all = deriveTrajectoryEvidenceGraph(state, {
      includeAllTrajectories: true,
      includeMilestones: false,
      includeVerifications: false,
    });
    const allIds = new Set(all.nodes.map((node) => node.id));
    expect(allIds.has("T002")).toBe(true);
    expect(allIds.has("T003")).toBe(true);
  });
});
