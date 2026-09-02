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
      return acc + (t.status === "running" ? Math.max(t.chargedTokens, t.estimatedTokens) : t.chargedTokens);
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
          chargedTokens: t.chargedTokens,
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
          CLAIMS: state.claimOrder.filter((id) => {
            const status = state.claims[id]?.status;
            return status === "UNVERIFIED" || status === "NEEDS_REVISION";
          }).length,
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

export interface TrajectoryEvidenceOptions {
  /** Include every Solver/Explorer session instead of only current research paths. */
  includeAllTrajectories?: boolean;
  /** Include the sparse turning points recorded during each long session. */
  includeMilestones?: boolean;
  /** Expand each claim's individual independent checks. */
  includeVerifications?: boolean;
}

/**
 * Current mathematical record for trajectories-v2, retaining the route by
 * which each claim was reached. Failed and duplicate claims stay out of this
 * working projection; their complete history remains in the Library.
 *
 * The defaults preserve the complete semantic projection. A UI may hide
 * individual verification nodes (the aggregate remains on each claim) or ask
 * for all research trajectories as progressive-disclosure choices.
 */
export function deriveTrajectoryEvidenceGraph(
  state: ProjectState,
  options: TrajectoryEvidenceOptions = {},
): Graph {
  const includeAllTrajectories = options.includeAllTrajectories ?? false;
  const includeMilestones = options.includeMilestones ?? true;
  const includeVerifications = options.includeVerifications ?? true;
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
    const status = state.claims[claimId]?.status;
    if (status === "UNVERIFIED" || status === "NEEDS_REVISION") includedClaims.add(claimId);
  }
  for (const factId of activeFactIds) includedClaims.add(state.facts[factId]!.claimId);

  const includedTaskIds = new Set<string>();
  for (const claimId of includedClaims) {
    const taskId = state.claims[claimId]?.sourceTaskId;
    if (taskId && state.tasks[taskId]) includedTaskIds.add(taskId);
  }

  const researchTask = (taskId: string): boolean => {
    const role = state.tasks[taskId]?.role;
    return role === "solver" || role === "explorer";
  };
  if (includeAllTrajectories) {
    for (const waveId of state.waveOrder) {
      for (const taskId of state.waves[waveId]?.taskIds ?? []) {
        if (researchTask(taskId)) includedTaskIds.add(taskId);
      }
    }
  } else {
    // Keep the live round visible before it has had a chance to produce claims.
    const currentWaveId = [...state.waveOrder]
      .reverse()
      .find((waveId) => state.waves[waveId]?.status !== "closed");
    if (currentWaveId) {
      for (const taskId of state.waves[currentWaveId]?.taskIds ?? []) {
        if (researchTask(taskId)) includedTaskIds.add(taskId);
      }
    }
    // A fresh or claim-free record should still show the latest completed work.
    if (includedTaskIds.size === 0) {
      const latestWaveId = state.waveOrder.at(-1);
      for (const taskId of latestWaveId ? state.waves[latestWaveId]?.taskIds ?? [] : []) {
        if (researchTask(taskId)) includedTaskIds.add(taskId);
      }
    }
  }

  const claimIdsByTask = new Map<string, string[]>();
  for (const claimId of includedClaims) {
    const taskId = state.claims[claimId]?.sourceTaskId;
    if (!taskId) continue;
    const ids = claimIdsByTask.get(taskId) ?? [];
    ids.push(claimId);
    claimIdsByTask.set(taskId, ids);
  }
  const factCountByTask = new Map<string, number>();
  for (const factId of activeFactIds) {
    const taskId = state.claims[state.facts[factId]!.claimId]?.sourceTaskId;
    if (taskId) factCountByTask.set(taskId, (factCountByTask.get(taskId) ?? 0) + 1);
  }

  const trajectoryTail = new Map<string, string>();
  for (const waveId of state.waveOrder) {
    const wave = state.waves[waveId];
    if (!wave) continue;
    for (const taskId of wave.taskIds) {
      if (!includedTaskIds.has(taskId)) continue;
      const task = state.tasks[taskId]!;
      nodes.push({
        id: task.id,
        type: "task",
        label: `${task.id} ${task.methodTag}`,
        data: {
          role: task.role,
          status: task.status,
          waveId: task.waveId,
          methodTag: task.methodTag,
          direction: task.direction,
          budgetTokens: task.budgetTokens,
          spend:
            task.status === "running"
              ? Math.max(task.chargedTokens, task.estimatedTokens)
              : task.chargedTokens,
          lastItemPreview: task.lastItem?.preview ?? "",
          conclusion: firstConclusion(state, task.artifactIds),
          milestoneCount: task.milestoneIds.length,
          claimCount: claimIdsByTask.get(task.id)?.length ?? 0,
          factCount: factCountByTask.get(task.id) ?? 0,
          researchMap: true,
        },
      });
      edges.push({
        id: `trajectory:problem:${task.id}`,
        source: "problem",
        target: task.id,
        type: "relation",
      });
      let tail = task.id;
      if (includeMilestones) {
        const milestones = task.milestoneIds
          .map((milestoneId) => state.milestones[milestoneId])
          .filter((milestone) => milestone !== undefined);
        milestones.forEach((milestone, index) => {
          nodes.push({
            id: milestone.id,
            type: "milestone",
            label: milestone.title,
            data: {
              taskId: task.id,
              title: milestone.title,
              markdown: milestone.markdown,
              recordedAt: milestone.recordedAt,
              ordinal: index + 1,
              total: milestones.length,
              researchMap: true,
            },
          });
          edges.push({
            id: `trajectory-step:${tail}:${milestone.id}`,
            source: tail,
            target: milestone.id,
            type: "sequence",
          });
          tail = milestone.id;
        });
      }
      trajectoryTail.set(task.id, tail);
    }
  }

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
        sourceTaskId: claim.sourceTaskId,
        sourceWaveId: claim.sourceWaveId,
        passCount: checks.filter((check) => check.verdict === "PASS").length,
        checkCount: checks.length,
        passesRequired:
          claim.verificationPolicy?.passesRequired ?? state.config.trajectory.passesRequired,
      },
    });
    const source = claim.sourceTaskId ? trajectoryTail.get(claim.sourceTaskId) : undefined;
    edges.push(
      source
        ? {
            id: `produced:${source}:${claim.id}`,
            source,
            target: claim.id,
            type: "produced",
            label: claim.relationToGoal,
          }
        : {
            id: `relation:problem:${claim.id}`,
            source: "problem",
            target: claim.id,
            type: "relation",
            label: claim.relationToGoal,
          },
    );
    for (const dependencyId of claim.dependsOn) {
      if (!includedClaims.has(dependencyId)) continue;
      edges.push({
        id: `claim-dependency:${claim.id}:${dependencyId}`,
        source: claim.id,
        target: dependencyId,
        type: "depends-on",
      });
    }
    for (const verification of includeVerifications ? checks : []) {
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
          finding: verification.finding,
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
