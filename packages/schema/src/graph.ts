import type { ProjectState } from "./state.js";
import { candidateLifecycle } from "./candidate-status.js";

/**
 * Semantic graph projection (DESIGN §5, §11). Nodes/edges only — layout is
 * the UI's job and positions are a pure function of this structure plus the
 * user's collapse set, never of arrival order.
 */

export interface GraphNode {
  id: string;
  type:
    | "problem"
    | "wave"
    | "task"
    | "resolution"
    | "lineage"
    | "candidate"
    | "review"
    | "memoryHub"
    | "question"
    | "final"
    | "claim"
    | "fact"
    | "verification"
    | "milestone"
    | "issue"
    | "obligation";
  parentId?: string;
  label: string;
  data: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type:
    | "sequence"
    | "produced"
    | "frozen-from"
    | "reviews"
    | "revision"
    | "uses"
    | "depends-on"
    | "attacks"
    | "verifies"
    | "promotes"
    | "equivalent"
    | "relation";
  label?: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function deriveOpsGraph(state: ProjectState): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  nodes.push({
    id: "problem",
    type: "problem",
    label: state.title || "Problem",
    data: { phase: state.phase, confirmed: state.problem.confirmedMarkdown !== null },
  });

  let prev = "problem";
  for (const waveId of state.waveOrder) {
    const wave = state.waves[waveId]!;
    const spend = wave.taskIds.reduce((acc, tid) => {
      const t = state.tasks[tid]!;
      const u = t.usage;
      return acc + (u ? Math.max(0, u.input_tokens - u.cached_input_tokens) + u.output_tokens : t.estimatedTokens);
    }, 0);
    nodes.push({
      id: waveId,
      type: "wave",
      label: wave.title,
      data: { status: wave.status, taskCount: wave.taskIds.length, spend },
    });
    edges.push({ id: `seq:${prev}:${waveId}`, source: prev, target: waveId, type: "sequence" });
    prev = waveId;

    for (const taskId of wave.taskIds) {
      const t = state.tasks[taskId]!;
      nodes.push({
        id: taskId,
        type: "task",
        parentId: waveId,
        label: `${taskId} ${t.methodTag}`,
        data: {
          role: t.role,
          status: t.status,
          direction: t.direction,
          budgetTokens: t.budgetTokens,
          estimatedTokens: t.estimatedTokens,
          usage: t.usage,
          reviewOf: t.reviewOf,
          conclusion: firstConclusion(state, t.artifactIds),
        },
      });
      for (const milestoneId of t.milestoneIds) {
        const milestone = state.milestones[milestoneId];
        if (!milestone) continue;
        nodes.push({
          id: milestone.id,
          type: "milestone",
          parentId: waveId,
          label: milestone.title,
          data: {
            taskId: t.id,
            title: milestone.title,
            markdown: milestone.markdown,
            recordedAt: milestone.recordedAt,
          },
        });
        edges.push({
          id: `milestone:${t.id}:${milestone.id}`,
          source: t.id,
          target: milestone.id,
          type: "produced",
        });
      }
    }

    if (wave.resolutionPath !== null) {
      const rid = `${waveId}:resolution`;
      nodes.push({
        id: rid,
        type: "resolution",
        parentId: waveId,
        label: `Resolution ${waveId}`,
        data: { path: wave.resolutionPath },
      });
    }
  }

  for (const lineage of Object.values(state.lineages)) {
    const latestCandidateId = lineage.versionIds.at(-1);
    const latestLifecycle = latestCandidateId
      ? candidateLifecycle(state, latestCandidateId)
      : null;
    nodes.push({
      id: lineage.id,
      type: "lineage",
      label: lineage.title,
      data: {
        status: lineage.status,
        active: state.activeLineageId === lineage.id,
        latestCandidateStage: latestLifecycle?.stage ?? "UNKNOWN",
        latestCandidateStatus: latestLifecycle?.label ?? "NO CANDIDATE",
      },
    });
    let prevVersion: string | null = null;
    for (const cid of lineage.versionIds) {
      const c = state.candidates[cid]!;
      const lifecycle = candidateLifecycle(state, cid);
      const openIssues = c.issueIds.filter((i) => state.issues[i]!.status === "open");
      nodes.push({
        id: cid,
        type: "candidate",
        label: cid,
        data: {
          lineageId: lineage.id,
          version: c.version,
          obligations: c.obligations.length,
          reviewQuestions: c.reviewQuestions.length,
          burnDown: issueBurnDown(state, c.issueIds),
          openIssues: openIssues.length,
          acceptance: c.acceptance,
          lifecycleStage: lifecycle.stage,
          lifecycleStatus: lifecycle.label,
          lifecycleDetail: lifecycle.detail,
        },
      });
      const fromTask = state.artifacts[c.fromArtifact]?.taskId;
      if (fromTask) {
        edges.push({ id: `frz:${cid}`, source: fromTask, target: cid, type: "frozen-from" });
      }
      if (prevVersion) {
        edges.push({ id: `rev:${prevVersion}:${cid}`, source: prevVersion, target: cid, type: "revision" });
      }
      prevVersion = cid;

      for (const rid of c.reviewIds) {
        const r = state.reviews[rid]!;
        nodes.push({
          id: rid,
          type: "review",
          label: `${rid} ${r.verdict}`,
          data: { verdict: r.verdict, issueCount: r.issueIds.length, taskId: r.taskId },
        });
        edges.push({ id: `prod:${r.taskId}:${rid}`, source: r.taskId, target: rid, type: "produced" });
        edges.push({ id: `revw:${rid}`, source: rid, target: cid, type: "reviews", label: r.verdict });
      }
    }
  }

  const cardCounts: Record<string, number> = {};
  for (const card of Object.values(state.cards)) {
    cardCounts[card.status] = (cardCounts[card.status] ?? 0) + 1;
  }
  if (state.config.workflow === "trajectories-v2") {
    nodes.push({
      id: "memory",
      type: "memoryHub",
      label: "Research library",
      data: {
        counts: {
          FACTS: state.factOrder.filter((id) => state.facts[id]?.status === "ACTIVE").length,
          CLAIMS: state.claimOrder.filter((id) => state.claims[id]?.status === "UNVERIFIED").length,
        },
      },
    });
  } else {
    nodes.push({ id: "memory", type: "memoryHub", label: "Memory", data: { counts: cardCounts } });
  }

  for (const q of Object.values(state.questions)) {
    if (q.status === "open") {
      nodes.push({
        id: q.id,
        type: "question",
        label: q.id,
        data: { text: q.text, blocking: q.blocking },
      });
    }
  }

  if (state.terminal) {
    nodes.push({
      id: "final",
      type: "final",
      label: `RESULT: ${state.terminal.result}`,
      data: { result: state.terminal.result, path: state.terminal.finalPath },
    });
    edges.push({ id: `seq:${prev}:final`, source: prev, target: "final", type: "sequence" });
  }

  return { nodes, edges };
}

/** Evidence view for one candidate version (default: latest of active lineage). */
export function deriveEvidenceGraph(state: ProjectState, candidateIdArg?: string): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const candidateId = candidateIdArg ?? latestActiveCandidateId(state);
  if (!candidateId) return { nodes, edges };
  const c = state.candidates[candidateId];
  if (!c) return { nodes, edges };

  const lifecycle = candidateLifecycle(state, candidateId);
  nodes.push({
    id: candidateId,
    type: "candidate",
    label: candidateId,
    data: {
      obligations: c.obligations.length,
      reviewQuestions: c.reviewQuestions.length,
      acceptance: c.acceptance,
      lifecycleStage: lifecycle.stage,
      lifecycleStatus: lifecycle.label,
      lifecycleDetail: lifecycle.detail,
    },
  });

  c.obligations.forEach((text, i) => {
    const oid = `${candidateId}:ob${i + 1}`;
    nodes.push({ id: oid, type: "obligation", label: `Obligation ${i + 1}`, data: { text } });
    edges.push({ id: `uses:${oid}`, source: candidateId, target: oid, type: "uses" });
  });

  // Claim closure over dependsOn, starting from usedClaimIds.
  const seen = new Set<string>();
  const queue = [...c.usedClaimIds];
  while (queue.length) {
    const kid = queue.shift()!;
    if (seen.has(kid)) continue;
    seen.add(kid);
    const k = state.claims[kid];
    if (!k) continue;
    nodes.push({
      id: kid,
      type: "claim",
      label: kid,
      data: { statement: k.statement, status: k.status, provenance: k.provenance },
    });
    for (const dep of k.dependsOn) {
      queue.push(dep);
      edges.push({ id: `dep:${kid}:${dep}`, source: kid, target: dep, type: "depends-on" });
    }
  }
  for (const kid of c.usedClaimIds) {
    edges.push({ id: `uses:${candidateId}:${kid}`, source: candidateId, target: kid, type: "uses" });
  }

  for (const iid of c.issueIds) {
    const issue = state.issues[iid]!;
    nodes.push({
      id: iid,
      type: "issue",
      label: `${iid} ${issue.severity}`,
      data: {
        severity: issue.severity,
        summary: issue.summary,
        status: issue.status,
        disposition: issue.disposition,
        location: issue.location,
      },
    });
    const target = seen.has(extractClaimRef(issue.location) ?? "") ? extractClaimRef(issue.location)! : candidateId;
    edges.push({ id: `atk:${iid}`, source: iid, target, type: "attacks" });
  }

  return { nodes, edges };
}

/**
 * Active mathematical evidence for trajectories-v2. The projection omits
 * failed and duplicate claims from the working graph; their complete history
 * remains in the Library.
 */
export function deriveTrajectoryEvidenceGraph(state: ProjectState): Graph {
  const nodes: GraphNode[] = [
    {
      id: "problem",
      type: "problem",
      label: state.title || "Problem",
      data: { phase: state.phase, confirmed: state.problem.confirmedMarkdown !== null },
    },
  ];
  const edges: GraphEdge[] = [];
  const activeFactIds = state.factOrder.filter((factId) => {
    const status = state.facts[factId]?.status;
    return status === "ACTIVE" || status === "SUSPICIOUS";
  });
  const includedClaims = new Set<string>();
  for (const claimId of state.claimOrder) {
    if (state.claims[claimId]?.status === "UNVERIFIED") includedClaims.add(claimId);
  }
  for (const factId of activeFactIds) includedClaims.add(state.facts[factId]!.claimId);

  for (const claimId of state.claimOrder) {
    if (!includedClaims.has(claimId)) continue;
    const claim = state.claims[claimId]!;
    const checks = claim.verificationIds
      .map((id) => state.verifications[id])
      .filter((value) => value !== undefined);
    nodes.push({
      id: claim.id,
      type: "claim",
      label: claim.title || claim.id,
      data: {
        title: claim.title,
        statement: claim.statement,
        status: claim.status,
        relationToGoal: claim.relationToGoal,
        passCount: checks.filter((check) => check.verdict === "PASS").length,
        checkCount: checks.length,
        passesRequired:
          claim.verificationPolicy?.passesRequired ?? state.config.trajectory.passesRequired,
      },
    });
    edges.push({
      id: `relation:problem:${claim.id}`,
      source: "problem",
      target: claim.id,
      type: "relation",
      label: claim.relationToGoal,
    });
    for (const verification of checks) {
      const checkLabel = verification.verdict ?? (verification.status === "running" ? "RUNNING" : "QUEUED");
      nodes.push({
        id: verification.id,
        type: "verification",
        label: `${verification.id} ${checkLabel}`,
        data: {
          claimId: claim.id,
          ordinal: verification.ordinal,
          status: verification.status,
          verdict: verification.verdict,
          summary: verification.summaryMarkdown,
        },
      });
      edges.push({
        id: `check:${claim.id}:${verification.id}`,
        source: claim.id,
        target: verification.id,
        type: "verifies",
        label: checkLabel,
      });
    }
    if (claim.targetFactId && activeFactIds.includes(claim.targetFactId)) {
      edges.push({
        id: `correction:${claim.id}:${claim.targetFactId}`,
        source: claim.id,
        target: claim.targetFactId,
        type: "attacks",
        label: "CORRECTION",
      });
    }
    for (const otherId of claim.equivalentIds) {
      if (!includedClaims.has(otherId) || claim.id.localeCompare(otherId) >= 0) continue;
      edges.push({
        id: `equivalent:${claim.id}:${otherId}`,
        source: claim.id,
        target: otherId,
        type: "equivalent",
        label: "same statement",
      });
    }
  }

  for (const factId of activeFactIds) {
    const fact = state.facts[factId]!;
    const claim = state.claims[fact.claimId];
    nodes.push({
      id: fact.id,
      type: "fact",
      label: fact.title || fact.id,
      data: {
        title: fact.title,
        statement: fact.statement,
        status: fact.status,
        claimId: fact.claimId,
        relationToGoal: claim?.relationToGoal ?? "RELATED",
      },
    });
    edges.push({
      id: `promotes:${fact.claimId}:${fact.id}`,
      source: fact.claimId,
      target: fact.id,
      type: "promotes",
      label: "established",
    });
  }
  return { nodes, edges };
}

export function latestActiveCandidateId(state: ProjectState): string | null {
  const lid = state.activeLineageId;
  if (!lid) return null;
  const lineage = state.lineages[lid];
  if (!lineage || lineage.versionIds.length === 0) return null;
  return lineage.versionIds[lineage.versionIds.length - 1]!;
}

function issueBurnDown(
  state: ProjectState,
  issueIds: string[],
): { CRITICAL: number; MAJOR: number; MINOR: number } {
  const out = { CRITICAL: 0, MAJOR: 0, MINOR: 0 };
  for (const iid of issueIds) {
    const issue = state.issues[iid]!;
    if (issue.status === "open") out[issue.severity] += 1;
  }
  return out;
}

function firstConclusion(state: ProjectState, artifactIds: string[]): string | null {
  for (const aid of artifactIds) {
    const a = state.artifacts[aid];
    if (a?.conclusion) return a.conclusion;
  }
  return null;
}

function extractClaimRef(location: string): string | null {
  const m = /\bK\d{3}\b/.exec(location);
  return m ? m[0] : null;
}
