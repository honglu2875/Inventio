import type { Graph, GraphNode } from "@inventio/schema";

/**
 * Deterministic ops-view layout (UI-SPEC §5, DESIGN §11.3).
 *
 * Time flows left → right in column slots: problem | W001 | W002 | … | final,
 * with the lineage lane below the wave band and the memory/questions band
 * below that. Positions are a pure function of (graph, collapsed set):
 * adding wave N+1 never moves anything in waves 1..N.
 *
 * Children of expanded waves get positions RELATIVE to their parent group
 * node (React Flow convention); everything else is absolute. Parents are
 * emitted before their children.
 */

export const OPS = {
  M: 40, // left margin
  TOP: 40,
  COL_W: 240,
  COL_GAP: 48,
  CHIP_H: 64,
  HEADER: 40,
  PAD: 14,
  TASK_H: 72,
  TGAP: 10,
  MILE_H: 50,
  MILE_GAP: 6,
  RES_H: 36,
  LANE_GAP: 64,
  CAND_W: 208,
  CAND_H: 88,
  REV_H: 34,
  REV_GAP: 8,
  BLOCK_GAP: 16,
  Q_W: 220,
  Q_H: 64,
  Q_GAP: 12,
  PROB_W: 208,
  PROB_H: 76,
  FINAL_W: 220,
  FINAL_H: 64,
  MEM_W: 200,
  MEM_H: 56,
  LIN_W: 180,
  LIN_H: 40,
  LIN_GAP: 8,
} as const;

export interface Placed {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  parentId?: string;
  hidden?: boolean;
}

export interface LayoutResult {
  nodes: Placed[];
  width: number;
  height: number;
}

function slotX(slot: number): number {
  return OPS.M + slot * (OPS.COL_W + OPS.COL_GAP);
}

export function expandedWaveHeight(
  taskCount: number,
  hasResolution: boolean,
  milestoneCount = 0,
): number {
  return (
    OPS.HEADER +
    taskCount * (OPS.TASK_H + OPS.TGAP) +
    milestoneCount * (OPS.MILE_H + OPS.MILE_GAP) +
    (hasResolution ? OPS.RES_H + OPS.TGAP : 0) +
    OPS.PAD
  );
}

export function layoutOps(graph: Graph, collapsed: ReadonlySet<string>): LayoutResult {
  const nodes: Placed[] = [];
  const byId = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));

  const waves = graph.nodes.filter((n) => n.type === "wave");
  const waveSlot = new Map<string, number>();
  waves.forEach((w, i) => waveSlot.set(w.id, i + 1));

  const tasksByWave = new Map<string, GraphNode[]>();
  const milestonesByTask = new Map<string, GraphNode[]>();
  const resolutionByWave = new Map<string, GraphNode>();
  for (const n of graph.nodes) {
    if (n.type === "task" && n.parentId) {
      const list = tasksByWave.get(n.parentId) ?? [];
      list.push(n);
      tasksByWave.set(n.parentId, list);
    }
    if (n.type === "milestone") {
      const taskId = typeof n.data["taskId"] === "string" ? n.data["taskId"] : "";
      if (taskId !== "") {
        const list = milestonesByTask.get(taskId) ?? [];
        list.push(n);
        milestonesByTask.set(taskId, list);
      }
    }
    if (n.type === "resolution" && n.parentId) resolutionByWave.set(n.parentId, n);
  }

  // --- top band: problem, waves, final ---------------------------------
  if (byId.has("problem")) {
    nodes.push({ id: "problem", x: OPS.M, y: OPS.TOP, w: OPS.PROB_W, h: OPS.PROB_H });
  }

  let bandBottom = OPS.TOP + OPS.PROB_H;
  for (const wave of waves) {
    const slot = waveSlot.get(wave.id)!;
    const tasks = tasksByWave.get(wave.id) ?? [];
    const resolution = resolutionByWave.get(wave.id);
    const isCollapsed = collapsed.has(wave.id);
    const milestoneCount = tasks.reduce(
      (total, task) => total + (milestonesByTask.get(task.id)?.length ?? 0),
      0,
    );
    const h = isCollapsed
      ? OPS.CHIP_H
      : expandedWaveHeight(tasks.length, resolution !== undefined, milestoneCount);
    nodes.push({ id: wave.id, x: slotX(slot), y: OPS.TOP, w: OPS.COL_W, h });
    bandBottom = Math.max(bandBottom, OPS.TOP + h);

    let cursorY = OPS.HEADER;
    tasks.forEach((t) => {
      nodes.push({
        id: t.id,
        parentId: wave.id,
        x: OPS.PAD,
        y: cursorY,
        w: OPS.COL_W - 2 * OPS.PAD,
        h: OPS.TASK_H,
        ...(isCollapsed ? { hidden: true } : {}),
      });
      cursorY += OPS.TASK_H + OPS.TGAP;
      for (const milestone of milestonesByTask.get(t.id) ?? []) {
        nodes.push({
          id: milestone.id,
          parentId: wave.id,
          x: OPS.PAD + 12,
          y: cursorY,
          w: OPS.COL_W - 2 * OPS.PAD - 12,
          h: OPS.MILE_H,
          ...(isCollapsed ? { hidden: true } : {}),
        });
        cursorY += OPS.MILE_H + OPS.MILE_GAP;
      }
    });
    if (resolution) {
      nodes.push({
        id: resolution.id,
        parentId: wave.id,
        x: OPS.PAD,
        y: cursorY,
        w: OPS.COL_W - 2 * OPS.PAD,
        h: OPS.RES_H,
        ...(isCollapsed ? { hidden: true } : {}),
      });
    }
  }

  const finalSlot = waves.length + 1;
  if (byId.has("final")) {
    nodes.push({ id: "final", x: slotX(finalSlot), y: OPS.TOP, w: OPS.FINAL_W, h: OPS.FINAL_H });
  }

  // --- lineage lane -----------------------------------------------------
  const lane1Y = bandBottom + OPS.LANE_GAP;
  let laneBottom = lane1Y;

  const lineages = graph.nodes.filter((n) => n.type === "lineage");
  lineages.forEach((l, i) => {
    nodes.push({
      id: l.id,
      x: OPS.M,
      y: lane1Y + i * (OPS.LIN_H + OPS.LIN_GAP),
      w: OPS.LIN_W,
      h: OPS.LIN_H,
    });
    laneBottom = Math.max(laneBottom, lane1Y + (i + 1) * (OPS.LIN_H + OPS.LIN_GAP));
  });

  // Column for a candidate = column of the wave containing its producing
  // task (via the frozen-from edge); fallback: sequential slots from 1.
  const frozenFrom = new Map<string, string>(); // candidateId -> taskId
  for (const e of graph.edges) {
    if (e.type === "frozen-from") frozenFrom.set(e.target, e.source);
  }
  const reviewsByCandidate = new Map<string, GraphNode[]>();
  for (const e of graph.edges) {
    if (e.type === "reviews") {
      const list = reviewsByCandidate.get(e.target) ?? [];
      const reviewNode = byId.get(e.source);
      if (reviewNode) list.push(reviewNode);
      reviewsByCandidate.set(e.target, list);
    }
  }

  const columnCursor = new Map<number, number>(); // slot -> next y
  let fallbackSlot = 1;
  for (const cand of graph.nodes.filter((n) => n.type === "candidate")) {
    const taskId = frozenFrom.get(cand.id);
    const waveId = taskId ? byId.get(taskId)?.parentId : undefined;
    const slot = waveId !== undefined && waveSlot.has(waveId) ? waveSlot.get(waveId)! : fallbackSlot++;
    const y = columnCursor.get(slot) ?? lane1Y;
    nodes.push({ id: cand.id, x: slotX(slot), y, w: OPS.CAND_W, h: OPS.CAND_H });

    const reviews = reviewsByCandidate.get(cand.id) ?? [];
    reviews.forEach((r, k) => {
      nodes.push({
        id: r.id,
        x: slotX(slot) + 12,
        y: y + OPS.CAND_H + OPS.REV_GAP + k * (OPS.REV_H + OPS.REV_GAP),
        w: OPS.CAND_W - 12,
        h: OPS.REV_H,
      });
    });
    const blockBottom =
      y + OPS.CAND_H + (reviews.length > 0 ? OPS.REV_GAP + reviews.length * (OPS.REV_H + OPS.REV_GAP) : 0);
    columnCursor.set(slot, blockBottom + OPS.BLOCK_GAP);
    laneBottom = Math.max(laneBottom, blockBottom);
  }

  // --- bottom band: memory hub; right rail: questions -------------------
  const lane2Y = laneBottom + OPS.LANE_GAP;
  let height = lane2Y;
  if (byId.has("memory")) {
    nodes.push({ id: "memory", x: OPS.M, y: lane2Y, w: OPS.MEM_W, h: OPS.MEM_H });
    height = lane2Y + OPS.MEM_H;
  }

  const questions = graph.nodes.filter((n) => n.type === "question");
  // blocking first, then id order (stable: derive graph preserves insertion)
  const sorted = [...questions].sort((a, b) => {
    const ab = a.data["blocking"] === true ? 0 : 1;
    const bb = b.data["blocking"] === true ? 0 : 1;
    return ab - bb || a.id.localeCompare(b.id);
  });
  const qx = slotX(finalSlot) + (byId.has("final") ? OPS.COL_W + OPS.COL_GAP : 0);
  sorted.forEach((q, k) => {
    nodes.push({ id: q.id, x: qx, y: OPS.TOP + k * (OPS.Q_H + OPS.Q_GAP), w: OPS.Q_W, h: OPS.Q_H });
    height = Math.max(height, OPS.TOP + (k + 1) * (OPS.Q_H + OPS.Q_GAP));
  });

  const width = qx + OPS.Q_W + OPS.M;
  return { nodes, width, height: height + OPS.TOP };
}
