import { describe, expect, it } from "vitest";
import type { Graph, GraphEdge, GraphNode } from "@inventio/schema";
import { OPS, expandedWaveHeight, layoutOps } from "../src/lib/layout.js";
import { EVD, layoutEvidence } from "../src/lib/evidenceLayout.js";
import { layoutTrajectoryEvidence } from "../src/lib/trajectoryEvidenceLayout.js";

function n(id: string, type: GraphNode["type"], parentId?: string, data: Record<string, unknown> = {}): GraphNode {
  return { id, type, label: id, data, ...(parentId ? { parentId } : {}) };
}
function e(id: string, source: string, target: string, type: GraphEdge["type"]): GraphEdge {
  return { id, source, target, type };
}

function opsGraph(): Graph {
  return {
    nodes: [
      n("problem", "problem"),
      n("W001", "wave"),
      n("T001", "task", "W001"),
      n("T002", "task", "W001"),
      n("W001:resolution", "resolution", "W001"),
      n("W002", "wave"),
      n("T003", "task", "W002"),
      n("C001", "lineage"),
      n("C001.v1", "candidate"),
      n("R001", "review"),
      n("memory", "memoryHub"),
      n("Q001", "question", undefined, { blocking: false }),
      n("Q002", "question", undefined, { blocking: true }),
      n("final", "final"),
    ],
    edges: [
      e("s1", "problem", "W001", "sequence"),
      e("s2", "W001", "W002", "sequence"),
      e("f1", "T001", "C001.v1", "frozen-from"),
      e("p1", "T003", "R001", "produced"),
      e("r1", "R001", "C001.v1", "reviews"),
    ],
  };
}

const byId = (r: { nodes: { id: string }[] }) =>
  new Map(r.nodes.map((p) => [p.id, p as (typeof r.nodes)[number] & { x: number; y: number; w: number; h: number; parentId?: string; hidden?: boolean }]));

describe("layoutOps", () => {
  it("places columns left-to-right: problem, waves, final", () => {
    const r = layoutOps(opsGraph(), new Set());
    const m = byId(r);
    expect(m.get("problem")!.x).toBeLessThan(m.get("W001")!.x);
    expect(m.get("W001")!.x).toBeLessThan(m.get("W002")!.x);
    expect(m.get("W002")!.x).toBeLessThan(m.get("final")!.x);
    // top band aligned
    expect(m.get("W001")!.y).toBe(OPS.TOP);
    expect(m.get("W002")!.y).toBe(OPS.TOP);
  });

  it("expands and collapses waves correctly", () => {
    const expanded = byId(layoutOps(opsGraph(), new Set()));
    expect(expanded.get("W001")!.h).toBe(expandedWaveHeight(2, true));
    expect(expanded.get("T001")!.parentId).toBe("W001");
    expect(expanded.get("T001")!.hidden).toBeUndefined();
    // children are relative to parent and stacked
    expect(expanded.get("T001")!.x).toBe(OPS.PAD);
    expect(expanded.get("T002")!.y).toBeGreaterThan(expanded.get("T001")!.y);

    const collapsed = byId(layoutOps(opsGraph(), new Set(["W001"])));
    expect(collapsed.get("W001")!.h).toBe(OPS.CHIP_H);
    expect(collapsed.get("T001")!.hidden).toBe(true);
    expect(collapsed.get("W001:resolution")!.hidden).toBe(true);
  });

  it("emits parents before children", () => {
    const r = layoutOps(opsGraph(), new Set());
    const order = r.nodes.map((p) => p.id);
    expect(order.indexOf("W001")).toBeLessThan(order.indexOf("T001"));
    expect(order.indexOf("W002")).toBeLessThan(order.indexOf("T003"));
  });

  it("aligns candidates under their producing wave with reviews stacked below", () => {
    const r = byId(layoutOps(opsGraph(), new Set()));
    expect(r.get("C001.v1")!.x).toBe(r.get("W001")!.x); // frozen from T001 ∈ W001
    expect(r.get("C001.v1")!.y).toBeGreaterThan(r.get("W001")!.y + r.get("W001")!.h);
    expect(r.get("R001")!.y).toBeGreaterThan(r.get("C001.v1")!.y + OPS.CAND_H - 1);
  });

  it("sorts blocking questions first in the right rail", () => {
    const r = byId(layoutOps(opsGraph(), new Set()));
    expect(r.get("Q002")!.y).toBeLessThan(r.get("Q001")!.y);
    expect(r.get("Q001")!.x).toBeGreaterThan(r.get("final")!.x);
  });

  it("is deterministic and stable under wave appends", () => {
    const g = opsGraph();
    const a = layoutOps(g, new Set());
    const b = layoutOps(g, new Set());
    expect(a).toEqual(b);

    const extended: Graph = {
      nodes: [...g.nodes, n("W003", "wave"), n("T004", "task", "W003")],
      edges: [...g.edges, e("s3", "W002", "W003", "sequence")],
    };
    const c = byId(layoutOps(extended, new Set()));
    const before = byId(a);
    for (const id of ["problem", "W001", "T001", "W002", "T003"]) {
      expect(c.get(id)!.x).toBe(before.get(id)!.x);
      expect(c.get(id)!.y).toBe(before.get(id)!.y);
    }
  });

  it("collapse only changes the collapsed wave's internals, not other columns", () => {
    const open = byId(layoutOps(opsGraph(), new Set()));
    const w1closed = byId(layoutOps(opsGraph(), new Set(["W001"])));
    expect(w1closed.get("W002")!.x).toBe(open.get("W002")!.x);
    expect(w1closed.get("W002")!.y).toBe(open.get("W002")!.y);
    expect(w1closed.get("T003")!.y).toBe(open.get("T003")!.y);
  });

  it("places trajectory milestones directly below the task that recorded them", () => {
    const graph = opsGraph();
    graph.nodes.push(n("MS001", "milestone", "W001", { taskId: "T001" }));
    graph.edges.push(e("ms1", "T001", "MS001", "produced"));
    const expanded = byId(layoutOps(graph, new Set()));
    expect(expanded.get("W001")!.h).toBe(expandedWaveHeight(2, true, 1));
    expect(expanded.get("MS001")!.parentId).toBe("W001");
    expect(expanded.get("MS001")!.y).toBeGreaterThan(expanded.get("T001")!.y);
    expect(expanded.get("MS001")!.y).toBeLessThan(expanded.get("T002")!.y);

    const collapsed = byId(layoutOps(graph, new Set(["W001"])));
    expect(collapsed.get("MS001")!.hidden).toBe(true);
  });
});

function evidenceGraph(): Graph {
  return {
    nodes: [
      n("C001.v1", "candidate"),
      n("C001.v1:ob1", "obligation", undefined, { text: "even case" }),
      n("K001", "claim", undefined, { status: "VERIFIED" }),
      n("K002", "claim", undefined, { status: "UNVERIFIED" }),
      n("K003", "claim", undefined, { status: "UNVERIFIED" }),
      n("I001", "issue", undefined, { severity: "CRITICAL" }),
      n("I002", "issue", undefined, { severity: "MINOR" }),
    ],
    edges: [
      e("u0", "C001.v1", "C001.v1:ob1", "uses"),
      e("u1", "C001.v1", "K001", "uses"),
      e("u2", "C001.v1", "K002", "uses"),
      e("d1", "K002", "K003", "depends-on"),
      e("a1", "I001", "K002", "attacks"),
      e("a2", "I002", "C001.v1", "attacks"),
    ],
  };
}

describe("layoutEvidence", () => {
  it("ranks left-to-right: candidate, used claims, dependencies", () => {
    const m = byId(layoutEvidence(evidenceGraph()));
    expect(m.get("C001.v1")!.x).toBeLessThan(m.get("K001")!.x);
    expect(m.get("K001")!.x).toBe(m.get("K002")!.x); // both rank 1
    expect(m.get("K003")!.x).toBeGreaterThan(m.get("K002")!.x); // rank 2
  });

  it("stacks obligations below the candidate and issues above their targets", () => {
    const m = byId(layoutEvidence(evidenceGraph()));
    expect(m.get("C001.v1:ob1")!.y).toBeGreaterThan(m.get("C001.v1")!.y + EVD.CAND_H - 1);
    expect(m.get("I001")!.y).toBeLessThan(m.get("K002")!.y);
    expect(m.get("I002")!.y).toBeLessThan(m.get("C001.v1")!.y);
  });

  it("returns empty layout without a candidate and is deterministic", () => {
    expect(layoutEvidence({ nodes: [], edges: [] }).nodes).toEqual([]);
    const g = evidenceGraph();
    expect(layoutEvidence(g)).toEqual(layoutEvidence(g));
  });
});

describe("layoutTrajectoryEvidence", () => {
  it("lays out the v2 mathematical record as problem, claims, checks, then facts", () => {
    const graph: Graph = {
      nodes: [
        n("problem", "problem"),
        n("K001", "claim"),
        n("V001", "verification"),
        n("F001", "fact"),
      ],
      edges: [
        e("r", "problem", "K001", "relation"),
        e("v", "K001", "V001", "verifies"),
        e("p", "K001", "F001", "promotes"),
      ],
    };
    const placed = byId(layoutTrajectoryEvidence(graph));
    expect(placed.get("problem")!.x).toBeLessThan(placed.get("K001")!.x);
    expect(placed.get("K001")!.x).toBeLessThan(placed.get("V001")!.x);
    expect(placed.get("V001")!.x).toBeLessThan(placed.get("F001")!.x);
    expect(layoutTrajectoryEvidence(graph)).toEqual(layoutTrajectoryEvidence(graph));
  });
});
