import type { Graph, GraphNode } from "@inventio/schema";
import type { LayoutResult, Placed } from "./layout.js";

/** Stable dimensions for the long-trajectory research map. */
export const TRAJECTORY_MAP = {
  MARGIN: 40,
  TOP: 56,
  PROBLEM_X: 40,
  PROBLEM_W: 220,
  PROBLEM_H: 84,
  TASK_X: 350,
  TASK_W: 250,
  TASK_H: 64,
  MILESTONE_X: 690,
  MILESTONE_W: 210,
  MILESTONE_H: 82,
  COLUMN_GAP: 54,
  CLAIM_W: 270,
  CLAIM_H: 100,
  CHECK_W: 225,
  CHECK_H: 68,
  FACT_W: 270,
  FACT_H: 100,
  ITEM_GAP: 14,
  CLAIM_ROW_GAP: 24,
  LANE_GAP: 58,
} as const;

function stringData(node: GraphNode, key: string): string | null {
  const value = node.data[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function groupedBy(
  nodes: GraphNode[],
  keyFor: (node: GraphNode) => string | null,
): Map<string, GraphNode[]> {
  const grouped = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const key = keyFor(node);
    if (key === null) continue;
    const values = grouped.get(key) ?? [];
    values.push(node);
    grouped.set(key, values);
  }
  return grouped;
}

/**
 * A lane per Solver/Explorer: session → turning points → claims → optional
 * checks → facts. Claim rows expand independently, so revealing checks cannot
 * overlap a neighboring claim or trajectory.
 */
export function layoutTrajectoryEvidence(graph: Graph): LayoutResult {
  const placed: Placed[] = [];
  const tasks = graph.nodes.filter((node) => node.type === "task");
  const milestones = graph.nodes.filter((node) => node.type === "milestone");
  const claims = graph.nodes.filter((node) => node.type === "claim");
  const checks = graph.nodes.filter((node) => node.type === "verification");
  const facts = graph.nodes.filter((node) => node.type === "fact");

  const milestoneTaskFromEdge = new Map<string, string>();
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of graph.edges) {
    if (edge.type !== "sequence") continue;
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (source?.type === "task" && target?.type === "milestone") {
      milestoneTaskFromEdge.set(target.id, source.id);
    }
  }
  const milestonesByTask = groupedBy(
    milestones,
    (node) => stringData(node, "taskId") ?? milestoneTaskFromEdge.get(node.id) ?? null,
  );
  const claimsByTask = groupedBy(claims, (node) => stringData(node, "sourceTaskId"));

  const claimFromCheckEdge = new Map<string, string>();
  const claimFromFactEdge = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.type === "verifies") claimFromCheckEdge.set(edge.target, edge.source);
    if (edge.type === "promotes") claimFromFactEdge.set(edge.target, edge.source);
  }
  const checksByClaim = groupedBy(
    checks,
    (node) => stringData(node, "claimId") ?? claimFromCheckEdge.get(node.id) ?? null,
  );
  const factsByClaim = groupedBy(
    facts,
    (node) => stringData(node, "claimId") ?? claimFromFactEdge.get(node.id) ?? null,
  );

  const maxMilestones = Math.max(
    0,
    ...tasks.map((task) => milestonesByTask.get(task.id)?.length ?? 0),
  );
  const claimX =
    maxMilestones === 0
      ? TRAJECTORY_MAP.MILESTONE_X
      : TRAJECTORY_MAP.MILESTONE_X +
        maxMilestones * (TRAJECTORY_MAP.MILESTONE_W + TRAJECTORY_MAP.COLUMN_GAP);
  const checksX = claimX + TRAJECTORY_MAP.CLAIM_W + TRAJECTORY_MAP.COLUMN_GAP;
  const hasChecks = checks.length > 0;
  const factsX = hasChecks
    ? checksX + TRAJECTORY_MAP.CHECK_W + TRAJECTORY_MAP.COLUMN_GAP
    : claimX + TRAJECTORY_MAP.CLAIM_W + TRAJECTORY_MAP.COLUMN_GAP;

  const problem = graph.nodes.find((node) => node.type === "problem");
  if (problem) {
    placed.push({
      id: problem.id,
      x: TRAJECTORY_MAP.PROBLEM_X,
      y: TRAJECTORY_MAP.TOP,
      w: TRAJECTORY_MAP.PROBLEM_W,
      h: TRAJECTORY_MAP.PROBLEM_H,
    });
  }

  let cursorY = TRAJECTORY_MAP.TOP;
  let maxBottom = problem ? TRAJECTORY_MAP.TOP + TRAJECTORY_MAP.PROBLEM_H : cursorY;
  const placedClaims = new Set<string>();

  const placeClaimRows = (laneClaims: GraphNode[], startY: number): number => {
    let rowY = startY;
    for (const claim of laneClaims) {
      placedClaims.add(claim.id);
      const claimChecks = checksByClaim.get(claim.id) ?? [];
      const claimFacts = factsByClaim.get(claim.id) ?? [];
      const checksHeight =
        claimChecks.length === 0
          ? 0
          : claimChecks.length * TRAJECTORY_MAP.CHECK_H +
            (claimChecks.length - 1) * TRAJECTORY_MAP.ITEM_GAP;
      const factsHeight =
        claimFacts.length === 0
          ? 0
          : claimFacts.length * TRAJECTORY_MAP.FACT_H +
            (claimFacts.length - 1) * TRAJECTORY_MAP.ITEM_GAP;
      const rowHeight = Math.max(TRAJECTORY_MAP.CLAIM_H, checksHeight, factsHeight);
      placed.push({
        id: claim.id,
        x: claimX,
        y: rowY,
        w: TRAJECTORY_MAP.CLAIM_W,
        h: TRAJECTORY_MAP.CLAIM_H,
      });
      claimChecks.forEach((check, index) => {
        placed.push({
          id: check.id,
          x: checksX,
          y: rowY + index * (TRAJECTORY_MAP.CHECK_H + TRAJECTORY_MAP.ITEM_GAP),
          w: TRAJECTORY_MAP.CHECK_W,
          h: TRAJECTORY_MAP.CHECK_H,
        });
      });
      claimFacts.forEach((fact, index) => {
        placed.push({
          id: fact.id,
          x: factsX,
          y: rowY + index * (TRAJECTORY_MAP.FACT_H + TRAJECTORY_MAP.ITEM_GAP),
          w: TRAJECTORY_MAP.FACT_W,
          h: TRAJECTORY_MAP.FACT_H,
        });
      });
      rowY += rowHeight + TRAJECTORY_MAP.CLAIM_ROW_GAP;
    }
    return laneClaims.length === 0 ? startY : rowY - TRAJECTORY_MAP.CLAIM_ROW_GAP;
  };

  for (const task of tasks) {
    const laneClaims = claimsByTask.get(task.id) ?? [];
    const laneMilestones = milestonesByTask.get(task.id) ?? [];
    const claimsBottom = placeClaimRows(laneClaims, cursorY);
    const contentHeight = Math.max(
      TRAJECTORY_MAP.TASK_H,
      laneMilestones.length > 0 ? TRAJECTORY_MAP.MILESTONE_H : 0,
      claimsBottom - cursorY,
    );
    const taskY = cursorY + Math.max(0, (contentHeight - TRAJECTORY_MAP.TASK_H) / 2);
    const milestoneY = cursorY + Math.max(0, (contentHeight - TRAJECTORY_MAP.MILESTONE_H) / 2);
    placed.push({
      id: task.id,
      x: TRAJECTORY_MAP.TASK_X,
      y: taskY,
      w: TRAJECTORY_MAP.TASK_W,
      h: TRAJECTORY_MAP.TASK_H,
    });
    laneMilestones.forEach((milestone, index) => {
      placed.push({
        id: milestone.id,
        x:
          TRAJECTORY_MAP.MILESTONE_X +
          index * (TRAJECTORY_MAP.MILESTONE_W + TRAJECTORY_MAP.COLUMN_GAP),
        y: milestoneY,
        w: TRAJECTORY_MAP.MILESTONE_W,
        h: TRAJECTORY_MAP.MILESTONE_H,
      });
    });
    maxBottom = Math.max(maxBottom, cursorY + contentHeight);
    cursorY += contentHeight + TRAJECTORY_MAP.LANE_GAP;
  }

  // Legacy/imported claims without a known source trajectory remain visible.
  for (const claim of claims) {
    if (placedClaims.has(claim.id)) continue;
    const bottom = placeClaimRows([claim], cursorY);
    maxBottom = Math.max(maxBottom, bottom);
    cursorY = bottom + TRAJECTORY_MAP.LANE_GAP;
  }

  const rightmost =
    facts.length > 0
      ? factsX + TRAJECTORY_MAP.FACT_W
      : checks.length > 0
        ? checksX + TRAJECTORY_MAP.CHECK_W
        : claims.length > 0
          ? claimX + TRAJECTORY_MAP.CLAIM_W
          : tasks.length > 0
            ? Math.max(
                TRAJECTORY_MAP.TASK_X + TRAJECTORY_MAP.TASK_W,
                maxMilestones === 0
                  ? 0
                  : TRAJECTORY_MAP.MILESTONE_X +
                    (maxMilestones - 1) *
                      (TRAJECTORY_MAP.MILESTONE_W + TRAJECTORY_MAP.COLUMN_GAP) +
                    TRAJECTORY_MAP.MILESTONE_W,
              )
            : TRAJECTORY_MAP.PROBLEM_X + TRAJECTORY_MAP.PROBLEM_W;
  return {
    nodes: placed,
    width: rightmost + TRAJECTORY_MAP.MARGIN,
    height: maxBottom + TRAJECTORY_MAP.MARGIN,
  };
}
