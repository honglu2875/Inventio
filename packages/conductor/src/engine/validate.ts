import type { ActionEnvelope, ProjectState } from "@inventio/schema";
import { parseCandidateId } from "@inventio/schema";

/**
 * Deterministic validation of an accepted-for-consideration Research Manager action
 * against the constitution (DESIGN §6.2). Returns human-readable violations;
 * empty array = legal.
 */
/**
 * Floor on a task's token budget. Verified against the real CLI: one `codex
 * exec` turn costs ~16k input tokens before the model writes anything, and the
 * packet itself is metered. A budget below this is not a frugal assignment,
 * it is a task that is killed before it can think — so it is rejected rather
 * than silently dispatched to die.
 */
export const MIN_TASK_TOKENS = 60_000;

/** Conclusive task results that curation explicitly chose to carry, but that
 * have not yet been frozen for independent review. */
export function reviewBacklog(state: ProjectState): { taskId: string; artifactId: string; conclusion: string }[] {
  const frozen = new Set(Object.values(state.candidates).map((candidate) => candidate.fromArtifact));
  const backlog: { taskId: string; artifactId: string; conclusion: string }[] = [];
  for (const task of Object.values(state.tasks)) {
    if (task.disposition !== "carry_forward") continue;
    for (const artifactId of task.artifactIds) {
      const artifact = state.artifacts[artifactId];
      if (
        artifact?.kind === "attempt" &&
        (artifact.conclusion === "PROVED" || artifact.conclusion === "DISPROVED") &&
        !frozen.has(artifactId)
      ) {
        backlog.push({ taskId: task.id, artifactId, conclusion: artifact.conclusion });
      }
    }
  }
  return backlog;
}

export function unassessedConclusiveResults(
  state: ProjectState,
): { taskId: string; artifactId: string; conclusion: string }[] {
  const frozen = new Set(Object.values(state.candidates).map((candidate) => candidate.fromArtifact));
  const backlog: { taskId: string; artifactId: string; conclusion: string }[] = [];
  for (const task of Object.values(state.tasks)) {
    if (task.disposition !== null) continue;
    for (const artifactId of task.artifactIds) {
      const artifact = state.artifacts[artifactId];
      if (
        artifact?.kind === "attempt" &&
        (artifact.conclusion === "PROVED" || artifact.conclusion === "DISPROVED") &&
        !frozen.has(artifactId)
      ) {
        backlog.push({ taskId: task.id, artifactId, conclusion: artifact.conclusion });
      }
    }
  }
  return backlog;
}

/** Legacy/fallback tasks that still own live UNVERIFIED claims but have no
 * durable carry/follow-up/set-aside decision. They are bookkeeping debt, not
 * permission to start another broad round. */
export function unassessedClaimSources(
  state: ProjectState,
): { taskId: string; claimIds: string[] }[] {
  const byTask = new Map<string, string[]>();
  for (const claim of Object.values(state.claims)) {
    if (claim.status !== "UNVERIFIED") continue;
    const taskId = claim.sourceTaskId ?? claim.provenance.match(/\(from (T\d+)\)/)?.[1] ?? null;
    if (taskId === null) continue;
    const task = state.tasks[taskId];
    if (!task || task.disposition !== null || task.status === "queued" || task.status === "running") continue;
    const ids = byTask.get(taskId) ?? [];
    ids.push(claim.id);
    byTask.set(taskId, ids);
  }
  return [...byTask].map(([taskId, claimIds]) => ({ taskId, claimIds }));
}

export function validateAction(state: ProjectState, envelope: ActionEnvelope): string[] {
  const v: string[] = [];
  const config = state.config;
  const remaining =
    state.budget.totalTokens - state.budget.spentTokens - state.budget.plannerSpentTokens;

  switch (envelope.action) {
   case "plan_wave": {
     const plan = envelope.plan_wave!;
      const researchAssignments = plan.tasks.filter((task) => task.role !== "synthesizer");
      if (researchAssignments.length > 8) {
        v.push(
          `a research round may contain at most 8 solver, explorer, or reviewer assignments; synthesis is counted separately (${researchAssignments.length} research assignments proposed)`,
        );
      }
     const unassessed = unassessedConclusiveResults(state);
      if (unassessed.length > 0 && state.activeLineageId === null) {
        v.push(
          `completed results still need a mathematical assessment before another research round: ${unassessed
            .map((item) => `${item.artifactId}/${item.conclusion}`)
            .join(", ")}. Use the internal assess_results action to select each for further use, ask one exact follow-up, or set it aside.`,
        );
      }
      const unassessedSources = unassessedClaimSources(state);
      if (unassessedSources.length > 0 && state.activeLineageId === null) {
        v.push(
          `older claim-producing attempts still need a mathematical assessment: ${unassessedSources
            .map((item) => `${item.taskId} (${item.claimIds.length} live claim${item.claimIds.length === 1 ? "" : "s"})`)
            .join(", ")}. Use the internal assess_results action; setting an attempt aside changes its unverified leads to SUPERSEDED.`,
        );
      }
      const pendingReview = reviewBacklog(state);
      if (pendingReview.length > 0 && state.activeLineageId === null) {
        v.push(
          `independent review is needed before another research round for ${pendingReview
            .map((item) => `${item.artifactId}/${item.conclusion}`)
            .join(", ")}. Submit the strongest exact statement as a precisely scoped candidate, or set the attempt aside with a mathematical reason.`,
        );
      }
      if (state.waveOrder.length >= config.limits.maxWaves) {
        v.push(`research-round limit reached (${config.limits.maxWaves}); prefer a focused question or an honest ending`);
      }
      const reserveFloor = Math.floor(config.budget.totalTokens * config.budget.reserveFraction);
      if (remaining < reserveFloor) {
        v.push(
          `remaining budget ${remaining} is below the protected follow-up allowance ${reserveFloor}: do not start another research round — ask a focused follow-up, respond to referee comments, preserve a candidate, ask the owner a concrete question, or finish honestly`,
        );
      }
      const taskSum = plan.tasks.reduce((a, t) => a + t.tokenBudget, 0);
      const waveTotal = taskSum + plan.reserveTokens;
      if (waveTotal > remaining) {
        v.push(`research-round total ${waveTotal} exceeds the remaining allocation ${remaining}`);
      }
      if (plan.reserveTokens * 4 < waveTotal) {
        v.push(
          `follow-up allowance ${plan.reserveTokens} is below 25% of the research-round total ${waveTotal}`,
        );
      }
      const solverTags = plan.tasks.filter((t) => t.role === "solver").map((t) => t.methodTag);
      if (new Set(solverTags).size !== solverTags.length) {
        v.push("parallel solvers must carry distinct methodTags (genuinely different directions)");
      }
      const briefs = plan.tasks.map((t) => t.briefMarkdown.trim());
      if (new Set(briefs).size !== briefs.length) {
        v.push("two tasks share an identical brief; independent attempts need distinct briefs");
      }
      for (const t of plan.tasks) {
        if (t.tokenBudget < MIN_TASK_TOKENS) {
          v.push(
            `assignment ${t.role}/${t.methodTag} has tokenBudget ${t.tokenBudget}, below the ${MIN_TASK_TOKENS} minimum: one model turn costs ~16,000 input tokens before reasoning, so it would stop before producing anything. Allocate a realistic amount (typically 150,000–1,500,000 for a solver).`,
          );
        }
        if (t.webSearch && !config.allowWebSearch) {
          v.push(
            `assignment ${t.role}/${t.methodTag} requests web search, but allowWebSearch is false: the owner supplies the literature. Use the supplied sources instead, or ask the owner to enable search.`,
          );
        }
        if (t.role === "reviewer") {
          if (!t.reviewOf) {
            v.push(`reviewer assignment (${t.methodTag}) must set reviewOf to a candidate ID`);
          } else if (!state.candidates[t.reviewOf]) {
            v.push(`reviewOf ${t.reviewOf} is not a candidate version`);
          } else if (!t.grants.artifactIds.includes(t.reviewOf)) {
            v.push(`the reviewer must receive the candidate write-up ${t.reviewOf}`);
          }
        } else if (t.reviewOf !== null) {
          v.push(`non-reviewer task (${t.role}/${t.methodTag}) must have reviewOf null`);
        }
        for (const aid of t.grants.artifactIds) {
          if (!state.artifacts[aid]) {
            if (state.cards[aid]) {
              v.push(
                `${aid} is a research-library note ID, not a full write-up ID: move it from grants.artifactIds to grants.cardIds`,
              );
            } else if (state.claims[aid]) {
              const claim = state.claims[aid]!;
              const sources = Object.values(state.artifacts)
                .filter((artifact) => artifact.taskId !== null && artifact.taskId === claim.sourceTaskId)
                .map((artifact) => artifact.id);
              v.push(
                `${aid} is a claim ID, not a file that can be supplied: remove it from grants.artifactIds, mention it in the brief, and supply its source write-up${sources.length > 0 ? ` (${sources.join(", ")})` : ""} if needed`,
              );
            } else {
              v.push(`supplied write-up ${aid} does not exist; grants.artifactIds accepts only existing full write-up IDs`);
            }
          }
        }
        for (const cid of t.grants.cardIds) {
          if (!state.cards[cid]) {
            if (state.claims[cid]) {
              const claim = state.claims[cid]!;
              const sources = Object.values(state.artifacts)
                .filter((artifact) => artifact.taskId !== null && artifact.taskId === claim.sourceTaskId)
                .map((artifact) => artifact.id);
              v.push(
                `${cid} is a claim ID, not a research-library note: grants.cardIds accepts only M-prefixed IDs; remove ${cid}, mention it in the brief, and supply its source write-up${sources.length > 0 ? ` (${sources.join(", ")})` : ""} through grants.artifactIds if needed`,
              );
            } else if (state.artifacts[cid]) {
              v.push(
                `${cid} is a full write-up ID, not a research-library note ID: move it from grants.cardIds to grants.artifactIds`,
              );
            } else {
              v.push(
                `supplied research-library note ${cid} does not exist; grants.cardIds accepts only existing M-prefixed IDs from working-library.md`,
              );
            }
          } else if (state.cards[cid]!.status === "QUARANTINED") {
            v.push(`library note ${cid} is marked unreliable and may not be supplied as a fact`);
          }
        }
        for (const m of t.grants.sourceMounts) {
          if (!config.sourceMounts.some((sm) => sm.name === m)) {
            v.push(`source mount "${m}" is not declared in project config`);
          }
        }
      }
      // Reviewer independence: at most one review task per candidate per author? Two allowed
      // (the protocol wants two sealed reviews) — but a reviewer must not also be the
      // synthesizer in the same wave.
      if (plan.tasks.some((t) => t.role === "reviewer") && plan.tasks.some((t) => t.role === "synthesizer")) {
        v.push("do not mix reviewers and a synthesizer in one research round; first submit a fixed candidate version, then review it independently");
      }
      break;
    }
    case "assess_results": {
      const seen = new Set<string>();
      for (const item of envelope.assess_results!.items) {
        const task = state.tasks[item.taskId];
        if (!task) {
          v.push(`assess_results references unknown task ${item.taskId}`);
          continue;
        }
        if (seen.has(item.taskId)) v.push(`assess_results repeats ${item.taskId}`);
        seen.add(item.taskId);
        if (task.status === "queued" || task.status === "running") {
          v.push(`cannot assess ${item.taskId} while it is ${task.status}`);
        }
        if (task.disposition === "set_aside") {
          v.push(`${item.taskId} was already set aside; that final mathematical decision is not reopened`);
        } else if (task.disposition === item.disposition) {
          v.push(`${item.taskId} already has the internal value ${task.disposition}; reassessment must change it`);
        }
        if (item.disposition === "needs_precise_unblock" && item.unblock === null) {
          v.push(`${item.taskId} uses needs_precise_unblock but gives no exact question in the internal unblock field`);
        }
        if (item.disposition !== "needs_precise_unblock" && item.unblock !== null) {
          v.push(`${item.taskId} must set the internal unblock field to null for ${item.disposition}`);
        }
      }
      break;
    }
    case "cross_examine": {
      for (const item of envelope.cross_examine!.items) {
        const t = state.tasks[item.taskId];
        if (!t) v.push(`focused-follow-up target ${item.taskId} does not exist`);
        else if (t.threadId === null) v.push(`focused-follow-up target ${item.taskId} has no resumable session`);
        else if (t.status === "queued" || t.status === "running") {
          v.push(`focused-follow-up target ${item.taskId} is still working; wait until its research round finishes`);
        }
      }
      break;
    }
    case "freeze_candidate": {
      const f = envelope.freeze_candidate!;
      const artifact = state.artifacts[f.fromArtifactId];
      if (!artifact) {
        v.push(`fromArtifactId ${f.fromArtifactId} does not exist`);
        break;
      }
      if (artifact.kind !== "attempt") {
        v.push(`candidate versions must come from proof attempts; ${f.fromArtifactId} is a ${artifact.kind} write-up`);
      }
      if (!artifact.conclusion) {
        v.push(`write-up ${f.fromArtifactId} has no recorded conclusion`);
      } else if (artifact.conclusion !== "PROVED" && artifact.conclusion !== "DISPROVED") {
        v.push(
          `write-up ${f.fromArtifactId} concludes ${artifact.conclusion}; submit only a result that claims PROVED or DISPROVED, and continue working on incomplete attempts`,
        );
      }
      if (
        (artifact.conclusion === "PROVED" || artifact.conclusion === "DISPROVED") &&
        f.obligations.length > 0
      ) {
        v.push(
          `write-up ${f.fromArtifactId} claims ${artifact.conclusion}, but freeze_candidate lists ${f.obligations.length} known open obligation${f.obligations.length === 1 ? "" : "s"}; put adversarial checks in reviewQuestions, or repair or downgrade the write-up before submitting it`,
        );
      }
      const duplicateChecks = f.reviewQuestions.filter((question) => f.obligations.includes(question));
      if (duplicateChecks.length > 0) {
        v.push("the same item cannot be both an admitted obligation and a referee question");
      }
      if (artifact.taskId !== null) {
        for (const computation of Object.values(state.computations)) {
          if (computation.taskId !== artifact.taskId) continue;
          if (computation.exitCode !== null && computation.exitCode !== 0) {
            v.push(
              `write-up ${f.fromArtifactId} relies on ${computation.id}, whose original command failed with exit ${computation.exitCode}; repair or replace the computation before submitting the candidate`,
            );
          } else if (computation.reproduced?.match !== true) {
            v.push(
              `write-up ${f.fromArtifactId} relies on ${computation.id}, which has no exact clean reproduction; repair or replace it before submitting the candidate`,
            );
          }
        }
      }
      if (f.lineageId && f.newLineageTitle) {
        v.push("provide lineageId or newLineageTitle, not both");
      }
      if (!f.lineageId && !f.newLineageTitle) {
        v.push("provide lineageId (existing) or newLineageTitle (new)");
      }
      if (f.lineageId) {
        const l = state.lineages[f.lineageId];
        if (!l) v.push(`mathematical approach ${f.lineageId} does not exist`);
        else if (l.status !== "active") v.push(`mathematical approach ${f.lineageId} is ${l.status}, not active`);
        else {
          const nextVersion = l.versionIds.length + 1;
          if (nextVersion > 1 + state.config.limits.maxRepairRounds + 1) {
            v.push(
              `version v${nextVersion} exceeds the repair-round limit; prefer a new approach or terminate (PROTOCOL §5)`,
            );
          }
        }
      }
      if (f.newLineageTitle && state.activeLineageId) {
        v.push(
          `an active mathematical approach (${state.activeLineageId}) already exists; discontinue it before opening a new one`,
        );
      }
      if (f.scopeMarkdown !== null && f.scopeMarkdown.trim().length < 20) {
        v.push(
          `scopeMarkdown must state the narrower result precisely (what is proved, for which cases) or be null for a full-problem candidate`,
        );
      }
      for (const kid of f.usedClaimIds) {
        if (!state.claims[kid]) v.push(`usedClaimId ${kid} is not in the current claims record`);
      }
      break;
    }
    case "record_dispositions": {
      for (const item of envelope.record_dispositions!.items) {
        const issue = state.issues[item.issueId];
        if (!issue) v.push(`issue ${item.issueId} does not exist`);
        else if (issue.status !== "open") v.push(`issue ${item.issueId} is already resolved`);
      }
      break;
    }
    case "abandon_lineage": {
      const l = state.lineages[envelope.abandon_lineage!.lineageId];
      if (!l) v.push(`mathematical approach ${envelope.abandon_lineage!.lineageId} does not exist`);
      else if (l.status !== "active") v.push(`mathematical approach ${l.id} is already discontinued`);
      break;
    }
    case "raise_question":
      break;
    case "terminate": {
      const unresolved = [
        ...unassessedConclusiveResults(state).map((item) => `${item.artifactId} is not assessed`),
        ...unassessedClaimSources(state).map(
          (item) => `${item.taskId} still owns ${item.claimIds.length} unassessed live claim${item.claimIds.length === 1 ? "" : "s"}`,
        ),
        ...reviewBacklog(state).map((item) => `${item.artifactId} was selected for further use but has not been reviewed`),
      ];
      if (unresolved.length > 0) {
        v.push(
          `cannot stop while concrete mathematical results still need decisions: ${unresolved.join(", ")}. Assess them, submit the strongest exact statements for review, or set them aside with a mathematical reason first.`,
        );
      }
      break;
    }
  }
  return v;
}

/** Sanity used by the engine when freezing: derive the next version id. */
export function nextCandidateVersion(state: ProjectState, lineageId: string): number {
  const l = state.lineages[lineageId];
  if (!l) throw new Error(`unknown lineage ${lineageId}`);
  const last = l.versionIds[l.versionIds.length - 1];
  if (!last) return 1;
  const parsed = parseCandidateId(last);
  return (parsed?.version ?? l.versionIds.length) + 1;
}
