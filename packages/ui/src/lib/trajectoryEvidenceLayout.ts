import type { Graph } from "@inventio/schema";
import type { LayoutResult, Placed } from "./layout.js";

/** A simple stable procession: problem → claims → checks → established facts. */
export function layoutTrajectoryEvidence(graph: Graph): LayoutResult {
  const nodes: Placed[] = [];
  const margin = 40;
  const top = 56;
  const gapY = 22;
  const columns = {
    problem: { x: margin, w: 220, h: 84 },
    claim: { x: 350, w: 250, h: 96 },
    verification: { x: 690, w: 225, h: 68 },
    fact: { x: 1005, w: 250, h: 96 },
  } as const;

  const problem = graph.nodes.find((node) => node.type === "problem");
  if (problem) nodes.push({ id: problem.id, x: columns.problem.x, y: top, w: columns.problem.w, h: columns.problem.h });

  let maxBottom = top + columns.problem.h;
  for (const type of ["claim", "verification", "fact"] as const) {
    const column = columns[type];
    graph.nodes.filter((node) => node.type === type).forEach((node, index) => {
      const y = top + index * (column.h + gapY);
      nodes.push({ id: node.id, x: column.x, y, w: column.w, h: column.h });
      maxBottom = Math.max(maxBottom, y + column.h);
    });
  }
  return { nodes, width: columns.fact.x + columns.fact.w + margin, height: maxBottom + margin };
}
