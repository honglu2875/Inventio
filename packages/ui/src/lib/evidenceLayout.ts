import type { Graph } from "@inventio/schema";
import type { LayoutResult, Placed } from "./layout.js";

/**
 * Deterministic evidence-view layout (UI-SPEC §8, DESIGN §11.4).
 *
 * Layered DAG, left → right by dependency rank:
 *   rank 0: the candidate (with its obligations stacked directly below);
 *   rank 1: claims the candidate uses;
 *   rank r+1: claims a rank-r claim depends on (max rank wins).
 * Issues float above their target (candidate or attacked claim), stacked.
 */

export const EVD = {
  M: 40,
  TOP: 140, // headroom for issues floating above targets
  CAND_W: 260,
  CAND_H: 110,
  CL_W: 240,
  CL_H: 88,
  OB_W: 260,
  OB_H: 72,
  ISS_W: 220,
  ISS_H: 64,
  GAP_X: 80,
  GAP_Y: 24,
  ISS_GAP: 10,
} as const;

export function layoutEvidence(graph: Graph): LayoutResult {
  const nodes: Placed[] = [];
  const candidate = graph.nodes.find((n) => n.type === "candidate");
  if (!candidate) return { nodes: [], width: 0, height: 0 };

  const claims = graph.nodes.filter((n) => n.type === "claim");
  const obligations = graph.nodes.filter((n) => n.type === "obligation");
  const issues = graph.nodes.filter((n) => n.type === "issue");
  const claimIds = new Set(claims.map((c) => c.id));

  // Ranking: uses → rank 1; depends-on: rank(target) >= rank(source) + 1.
  const rank = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.type === "uses" && e.source === candidate.id && claimIds.has(e.target)) {
      rank.set(e.target, 1);
    }
  }
  // Relax depends-on edges to a fixpoint (graphs are small; claims are acyclic
  // in intent — guard with a bounded pass count anyway).
  for (let pass = 0; pass < claims.length + 2; pass++) {
    let changed = false;
    for (const e of graph.edges) {
      if (e.type !== "depends-on") continue;
      const rs = rank.get(e.source);
      if (rs === undefined) continue;
      const need = rs + 1;
      if ((rank.get(e.target) ?? 1) < need) {
        rank.set(e.target, need);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const c of claims) if (!rank.has(c.id)) rank.set(c.id, 1);

  const colX = (r: number): number => EVD.M + (r === 0 ? 0 : EVD.CAND_W - EVD.CL_W) + r * (EVD.CL_W + EVD.GAP_X);

  // Candidate + obligations at rank 0.
  nodes.push({ id: candidate.id, x: EVD.M, y: EVD.TOP, w: EVD.CAND_W, h: EVD.CAND_H });
  obligations.forEach((o, i) => {
    nodes.push({
      id: o.id,
      x: EVD.M,
      y: EVD.TOP + EVD.CAND_H + EVD.GAP_Y + i * (EVD.OB_H + EVD.GAP_Y / 2),
      w: EVD.OB_W,
      h: EVD.OB_H,
    });
  });

  // Claims per rank, insertion order within a rank (deterministic: derive
  // graph emits BFS order from usedClaimIds).
  const perRank = new Map<number, number>();
  const pos = new Map<string, { x: number; y: number }>();
  for (const c of claims) {
    const r = rank.get(c.id)!;
    const idx = perRank.get(r) ?? 0;
    perRank.set(r, idx + 1);
    const x = colX(r);
    const y = EVD.TOP + idx * (EVD.CL_H + EVD.GAP_Y);
    pos.set(c.id, { x, y });
    nodes.push({ id: c.id, x, y, w: EVD.CL_W, h: EVD.CL_H });
  }
  pos.set(candidate.id, { x: EVD.M, y: EVD.TOP });

  // Issues above their target, stacked upward.
  const issueCount = new Map<string, number>();
  for (const issue of issues) {
    const attack = graph.edges.find((e) => e.type === "attacks" && e.source === issue.id);
    const target = attack ? pos.get(attack.target) ?? { x: EVD.M, y: EVD.TOP } : { x: EVD.M, y: EVD.TOP };
    const k = issueCount.get(attack?.target ?? candidate.id) ?? 0;
    issueCount.set(attack?.target ?? candidate.id, k + 1);
    nodes.push({
      id: issue.id,
      x: target.x + 24,
      y: target.y - (k + 1) * (EVD.ISS_H + EVD.ISS_GAP),
      w: EVD.ISS_W,
      h: EVD.ISS_H,
    });
  }

  const maxRank = Math.max(0, ...rank.values());
  const width = colX(maxRank) + EVD.CL_W + EVD.M;
  const height =
    Math.max(
      EVD.TOP + EVD.CAND_H + EVD.GAP_Y + obligations.length * (EVD.OB_H + EVD.GAP_Y / 2),
      ...[...perRank.entries()].map(([, n]) => EVD.TOP + n * (EVD.CL_H + EVD.GAP_Y)),
    ) + EVD.M;
  return { nodes, width, height };
}
